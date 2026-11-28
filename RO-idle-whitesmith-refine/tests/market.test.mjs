import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
  diffPurchasedBatch,
  diffPurchasedItems,
  groupVendorOrders,
  isOverHalfWeight,
  marketPlan,
  planAutoDeposit,
  takeVendorBatch,
  verifyDeposited,
  wouldExceedMaxWeight,
} from "../market.mjs";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("marketPlan attaches unitWeight when definition has weight", () => {
  const response = {
    heldItems: [{id: 2317, category: "equipment", cardSlots: 1, weight: 280}],
    shops: [{
      vendorId: 2,
      vendorName: "商人A",
      openedAt: 1000,
      mapId: "prontera",
      items: [{itemId: 2317, name: "鋼鐵鎧甲", price: 50000, qty: 1, cartUid: 11}],
    }],
  };
  const plan = marketPlan(response, {2317: 1}, {id: 1, mapId: "prontera", zeny: 200000}, {
    keyword: "鋼鐵鎧甲",
    holes: 1,
    ceiling: 60000,
    quantity: 5,
  });
  assert.equal(plan.count, 1);
  assert.equal(plan.orders[0].unitWeight, 280);
});

test("isOverHalfWeight checks strictly over 50% via weight/weightMax or weightPercent fallback", () => {
  assert.equal(isOverHalfWeight({weight: 1000, derived: {weightMax: 2000}}), false);
  assert.equal(isOverHalfWeight({weight: 1001, derived: {weightMax: 2000}}), true);
  assert.equal(isOverHalfWeight({weight: 999, derived: {weightMax: 2000}}), false);
  assert.equal(isOverHalfWeight({weightPercent: 50}), false);
  assert.equal(isOverHalfWeight({weightPercent: 50.1}), true);
  assert.throws(() => isOverHalfWeight({}), /無法確認角色目前負重/);
});

test("wouldExceedMaxWeight checks next item overflow against weightMax", () => {
  const snap = {weight: 900, derived: {weightMax: 2000}};
  assert.equal(wouldExceedMaxWeight(snap, 1100, 1), false);
  assert.equal(wouldExceedMaxWeight(snap, 1101, 1), true);
  assert.equal(wouldExceedMaxWeight(snap, 600, 2), true);
  assert.equal(wouldExceedMaxWeight(snap, null, 1), false);
});

test("diffPurchasedItems finds newly added equipment UIDs without touching existing items", () => {
  const before = [
    {uid: 10, itemId: 504, qty: 20},
    {uid: 11, itemId: 2317, qty: 1},
  ];
  const after = [
    {uid: 10, itemId: 504, qty: 20},
    {uid: 11, itemId: 2317, qty: 1},
    {uid: 42, itemId: 2317, qty: 1},
  ];
  assert.deepEqual(diffPurchasedItems(before, after, 2317, 1), [{uid: 42, qty: 1}]);
});

test("diffPurchasedItems throws when inventory delta does not match expected quantity", () => {
  const before = [{uid: 10, itemId: 504, qty: 20}];
  const after = [{uid: 10, itemId: 504, qty: 20}];
  assert.throws(() => diffPurchasedItems(before, after, 2317, 1), /無法確認剛買到的物品位置/);
});

test("planAutoDeposit validates Kafra fee, Zeny, capacity, locks, and equipped slots", () => {
  const snapshot = {
    mapId: "prontera",
    activity: "stopped",
    character: {zeny: 1000},
    equipment: {armor: 11},
    inventory: [
      {uid: 11, itemId: 2317, qty: 1},
      {uid: 42, itemId: 2317, qty: 1},
      {uid: 43, itemId: 2317, qty: 1},
    ],
  };
  const storage = {fees: {prontera: 40}, capacity: 600, items: new Array(10).fill({sid: 1})};
  const slots = {2317: 1};
  const plan = planAutoDeposit(snapshot, storage, [[42, 1], [43, 1]], slots);
  assert.deepEqual(plan, {items: [{uid: 42, qty: 1}, {uid: 43, qty: 1}], fee: 40, totalQty: 2});

  assert.throws(
    () => planAutoDeposit({...snapshot, mapId: "unknown_town"}, storage, [[42, 1]], slots),
    /沒有卡普拉倉庫服務/,
  );
  assert.throws(
    () => planAutoDeposit({...snapshot, character: {zeny: 39}}, storage, [[42, 1]], slots),
    /無法支付倉庫費/,
  );
  assert.throws(
    () => planAutoDeposit(snapshot, {...storage, capacity: 11}, [[42, 1], [43, 1]], slots),
    /倉庫空間不足/,
  );
  assert.throws(
    () => planAutoDeposit(snapshot, storage, [[11, 1]], slots),
    /待存倉的剛購物品狀態已變更/,
  );
});

test("verifyDeposited confirms items left inventory cleanly", () => {
  const before = [{uid: 10, qty: 20}, {uid: 42, qty: 1}, {uid: 43, qty: 1}];
  const after = [{uid: 10, qty: 20}];
  assert.doesNotThrow(() => verifyDeposited(before, after, [{uid: 42, qty: 1}, {uid: 43, qty: 1}]));
  assert.throws(
    () => verifyDeposited(before, [{uid: 10, qty: 20}, {uid: 43, qty: 1}], [{uid: 42, qty: 1}, {uid: 43, qty: 1}]),
    /未確認剛買到的物品已存入倉庫/,
  );
});

test("marketPlan supports non-equipment items, exact itemId filter, and quantities over 100", () => {
  const response = {
    heldItems: [],
    shops: [
      {
        vendorId: 2,
        vendorName: "材料商",
        openedAt: 1000,
        mapId: "prontera",
        items: [
          {itemId: 985, name: "鋁", price: 15000, qty: 200, cartUid: 1},
          {itemId: 756, name: "神之金屬原石", price: 5000, qty: 50, cartUid: 2},
          {itemId: 2317, name: "鋼鐵鎧甲", price: 10000, qty: 1, cartUid: 3},
        ],
      },
    ],
  };
  const slots = {2317: 1};
  const weights = {985: 20, 756: 20, 2317: 450};

  const nonEquip = marketPlan(response, slots, {id: 1, mapId: "prontera", zeny: 5_000_000}, {
    keyword: "鋁",
    holes: "non-equip",
    ceiling: 20000,
    quantity: 200,
  }, weights);
  assert.equal(nonEquip.count, 200);
  assert.equal(nonEquip.orders[0].isEquipment, false);
  assert.equal(nonEquip.orders[0].unitWeight, 20);

  const exactOnly = marketPlan(response, slots, {id: 1, mapId: "prontera", zeny: 5_000_000}, {
    keyword: "神之金屬",
    itemId: 984,
    holes: "any",
    ceiling: 20000,
    quantity: 50,
  }, weights);
  assert.equal(exactOnly.count, 0);
});

test("groupVendorOrders combines orders from the same vendor and takeVendorBatch chunks by weight", () => {
  const orders = [
    {vendorId: 10, seller: "A", item: {cartUid: 1, itemId: 1101, price: 1000}, qty: 1, isEquipment: true, unitWeight: 200},
    {vendorId: 20, seller: "B", item: {cartUid: 2, itemId: 1101, price: 1100}, qty: 1, isEquipment: true, unitWeight: 200},
    {vendorId: 10, seller: "A", item: {cartUid: 3, itemId: 1101, price: 1200}, qty: 1, isEquipment: true, unitWeight: 200},
    {vendorId: 10, seller: "A", item: {cartUid: 4, itemId: 1101, price: 1300}, qty: 1, isEquipment: true, unitWeight: 200},
  ];
  const groups = groupVendorOrders(orders);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].vendorId, 10);
  assert.equal(groups[0].orders.length, 3);
  assert.equal(groups[1].vendorId, 20);

  // autoStore OFF: takes all 3 orders from vendor 10 in one batch
  const allAtOnce = takeVendorBatch(groups[0].orders.map(o => ({...o})), {weight: 0, derived: {weightMax: 1000}, inventory: []}, false);
  assert.equal(allAtOnce.length, 3);

  // autoStore ON: weight 200 / 1000 (half = 500). Item 1 -> 400 (<=500), Item 2 -> 600 (>500, stop!), leaving Item 3 in queue.
  const queue = groups[0].orders.map(o => ({...o}));
  const chunk1 = takeVendorBatch(queue, {weight: 200, derived: {weightMax: 1000}, inventory: []}, true);
  assert.equal(chunk1.length, 2);
  assert.equal(queue.length, 1);
});

test("takeVendorBatch splits large stackable order from one vendor across 50% weight chunks", () => {
  const queue = [{vendorId: 10, seller: "A", item: {cartUid: 1, itemId: 985, price: 15000}, qty: 200, isEquipment: false, unitWeight: 20}];
  // weight 200 / 2000 (half = 1000) -> 41 * 20 = 820 -> total 1020 (> 50%)
  const chunk1 = takeVendorBatch(queue, {weight: 200, derived: {weightMax: 2000}, inventory: []}, true);
  assert.equal(chunk1.length, 1);
  assert.equal(chunk1[0].qty, 41);
  assert.equal(queue[0].qty, 159);
});

test("diffPurchasedBatch verifies multi-order batch and planAutoDeposit merges stackable items in storage", () => {
  const before = [{uid: 5, itemId: 985, qty: 10}];
  const after = [
    {uid: 5, itemId: 985, qty: 30},
    {uid: 99, itemId: 1101, qty: 1},
  ];
  const added = diffPurchasedBatch(before, after, [
    {item: {itemId: 985}, qty: 20},
    {item: {itemId: 1101}, qty: 1},
  ]);
  assert.deepEqual(added, [{uid: 5, qty: 20}, {uid: 99, qty: 1}]);

  // Storage is at 600/600 capacity, but already has an unlocked stack of 985 -> depositing 985 adds 0 slots!
  const snapshot = {
    mapId: "prontera",
    activity: "stopped",
    character: {zeny: 1000},
    equipment: {},
    inventory: [{uid: 5, itemId: 985, qty: 30}],
  };
  const fullStorage = {
    fees: {prontera: 40},
    capacity: 2,
    items: [
      {sid: 1, itemId: 985, qty: 50},
      {sid: 2, itemId: 504, qty: 10},
    ],
  };
  const plan = planAutoDeposit(snapshot, fullStorage, [[5, 20]]);
  assert.deepEqual(plan, {items: [{uid: 5, qty: 20}], fee: 40, totalQty: 20});
});

test("market-weights.json covers all market-slots and rebind-items including fractional arrows and 0-weight batching", () => {
  const weights = JSON.parse(fs.readFileSync(path.join(dir, "market-weights.json"), "utf8"));
  const slots = JSON.parse(fs.readFileSync(path.join(dir, "market-slots.json"), "utf8"));
  const rebind = JSON.parse(fs.readFileSync(path.join(dir, "rebind-items.json"), "utf8"));
  for (const id of Object.keys(slots)) {
    assert.ok(Number.isFinite(weights[id]), `missing weight for slot item ${id}`);
  }
  for (const id of Object.keys(rebind)) {
    assert.ok(Number.isFinite(weights[id]), `missing weight for rebind item ${id}`);
  }
  assert.equal(weights["1750"], 0.1);

  const zeroWeightQueue = [
    {vendorId: 1, seller: "A", item: {cartUid: 1, itemId: 9007, price: 100}, qty: 1, isEquipment: false, unitWeight: 0},
    {vendorId: 1, seller: "A", item: {cartUid: 2, itemId: 9008, price: 100}, qty: 1, isEquipment: false, unitWeight: 0},
  ];
  const batch = takeVendorBatch(zeroWeightQueue, {weight: 100, derived: {weightMax: 2000}, inventory: []}, true);
  assert.equal(batch.length, 2);
});
