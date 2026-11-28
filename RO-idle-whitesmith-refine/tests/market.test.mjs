import assert from "node:assert/strict";
import test from "node:test";
import {
  diffPurchasedItems,
  isOverHalfWeight,
  marketPlan,
  planAutoDeposit,
  verifyDeposited,
  wouldExceedMaxWeight,
} from "../market.mjs";

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
  assert.throws(() => diffPurchasedItems(before, after, 2317, 1), /無法確認剛買到的裝備位置/);
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
  const plan = planAutoDeposit(snapshot, storage, [[42, 1], [43, 1]]);
  assert.deepEqual(plan, {items: [{uid: 42, qty: 1}, {uid: 43, qty: 1}], fee: 40, totalQty: 2});

  assert.throws(
    () => planAutoDeposit({...snapshot, mapId: "unknown_town"}, storage, [[42, 1]]),
    /沒有卡普拉倉庫服務/,
  );
  assert.throws(
    () => planAutoDeposit({...snapshot, character: {zeny: 39}}, storage, [[42, 1]]),
    /無法支付倉庫費/,
  );
  assert.throws(
    () => planAutoDeposit(snapshot, {...storage, capacity: 11}, [[42, 1], [43, 1]]),
    /倉庫空間不足/,
  );
  assert.throws(
    () => planAutoDeposit(snapshot, storage, [[11, 1]]),
    /待存倉的剛購裝備狀態已變更/,
  );
});

test("verifyDeposited confirms items left inventory cleanly", () => {
  const before = [{uid: 10, qty: 20}, {uid: 42, qty: 1}, {uid: 43, qty: 1}];
  const after = [{uid: 10, qty: 20}];
  assert.doesNotThrow(() => verifyDeposited(before, after, [{uid: 42, qty: 1}, {uid: 43, qty: 1}]));
  assert.throws(
    () => verifyDeposited(before, [{uid: 10, qty: 20}, {uid: 43, qty: 1}], [{uid: 42, qty: 1}, {uid: 43, qty: 1}]),
    /未確認剛買到的裝備已存入倉庫/,
  );
});
