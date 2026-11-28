import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
  handoffItems,
  planClearNewCharacter,
  planHandoffArrows,
  planHandoffZeny,
  profileName,
  validateReceiveHandoff,
} from "../handoff.mjs";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8"));
const weights = JSON.parse(fs.readFileSync(path.join(dir, "market-weights.json"), "utf8"));

test("handoffItems allows newly released worn equipment missing from static rebind-items.json", () => {
  const snapshot = {
    equipment: {headTop: 10, ammo: 20},
    inventory: [
      {uid: 10, itemId: 99999, qty: 1}, // New headgear not in static definitions
      {uid: 20, itemId: 1751, qty: 500},
      {uid: 30, itemId: 1716, qty: 1},
    ],
  };
  const config = {equipRules: [{weapon: 30, ammo: 20}]};
  const definitions = {1716: ["角弓", ["weapon"]], 1751: ["銀箭矢", ["ammo"]]};

  const items = handoffItems(snapshot, config, definitions);
  assert.deepEqual(items.map(i => i.uid), [10, 30]);
});

test("validateReceiveHandoff checks 10-profile limit, backpack slots, carry weight, and non-rebirth note", () => {
  const record = {
    config: {equipRules: [{cond: {baseLvAbove: 64}, weapon: 30}]},
    items: [
      {uid: 1, itemId: 2317, qty: 1}, // 450 weight
      {uid: 2, itemId: 1716, qty: 1}, // 100 weight
    ],
  };
  const weights = {2317: 450, 1716: 100};
  const box = {fees: {prontera: 40}, items: [], heldItems: []};

  // Profile cap (10 different profiles)
  const fullProfiles = Array.from({length: 10}, (_, i) => ({name: `p${i}`}));
  assert.throws(
    () => validateReceiveHandoff({activity: "stopped", profiles: fullProfiles, inventory: [], weight: 0, derived: {weightMax: 2000}, character: {}}, box, record, weights),
    /已存滿 10 個配置檔/,
  );

  // Overweight for Lv1 Novice
  assert.throws(
    () => validateReceiveHandoff({activity: "stopped", profiles: [], inventory: [], weight: 1600, derived: {weightMax: 2000}, character: {}}, box, record, weights),
    /剩餘負重不足（剩餘 400，需要 550）/,
  );

  // Insufficient backpack slots
  const fullBag = Array.from({length: 99}, (_, i) => ({uid: i + 1}));
  assert.throws(
    () => validateReceiveHandoff({activity: "stopped", profiles: [], inventory: fullBag, weight: 0, derived: {weightMax: 2000}, character: {}}, box, record, weights),
    /背包空間不足/,
  );

  // Valid non-rebirth character with existing same-name profile (even at 10 profiles)
  const okProfiles = [...fullProfiles.slice(0, 9), {name: profileName}];
  const info = validateReceiveHandoff({activity: "stopped", profiles: okProfiles, inventory: [], weight: 100, derived: {weightMax: 2000}, character: {rebirth: null}}, box, record, weights);
  assert.deepEqual(info, {sameName: true, skippedWeaponRule: true});
});

test("planClearNewCharacter unequips and splits sellable vs unsellable items while skipping locked items", () => {
  const snapshot = {
    equipment: {weapon: 1, armor: 2},
    inventory: [
      {uid: 1, itemId: 1201, qty: 1}, // 短劍 (sellable, weight 40)
      {uid: 2, itemId: 2301, qty: 1, locked: true}, // locked Cotton Shirt -> must be skipped!
      {uid: 3, itemId: 1750, qty: 50}, // 箭矢 (sell === 0 -> discard, weight 5)
    ],
  };
  const plan = planClearNewCharacter(snapshot, catalog, weights);
  assert.deepEqual(plan.unequipSlots, [{slot: "weapon", uid: 1}]);
  assert.deepEqual(plan.sellUids, [1]);
  assert.deepEqual(plan.discardItems, [{uid: 3, qty: 50}]);
  assert.equal(plan.freedSlots, 2);
  assert.equal(plan.freedWeight10, 450);
});

test("planHandoffArrows plans general shop Silver Arrows and town shop Fire Arrows", () => {
  const record = {
    config: {
      equipRules: [
        {ammo: 10, ammoId: 1751},
        {ammo: 11, ammoId: 1752},
      ],
    },
    ammo: {10: 1751, 11: 1752},
  };
  const snapshot = {mapId: "prontera", inventory: [], character: {rebirth: null}};
  const plan = planHandoffArrows(record, snapshot, {autoArrows: true, arrowQty: 100, clearedInventory: true}, catalog, weights);
  assert.equal(plan.buy.length, 2);
  assert.deepEqual(plan.buy[0], {itemId: 1751, name: "銀箭矢", qty: 100, shop: null, unitPrice: 3, cost: 300});
  assert.deepEqual(plan.buy[1], {itemId: 1752, name: "火箭矢", qty: 100, shop: "Weapon Dealer#prt", unitPrice: 3, cost: 300});
  assert.equal(plan.totalCost, 600);
  assert.equal(plan.extraSlots, 2);
  assert.equal(plan.extraWeight10, 400);
});

test("planHandoffZeny tops up to 15,000,000 including Kafra withdrawal fee and skips when already funded", () => {
  const box = {fees: {prontera: 40}, zeny: 50_000_000};
  const broke = {mapId: "prontera", character: {zeny: 0}};
  const plan = planHandoffZeny(broke, box, {autoZeny: true, targetZeny: 15_000_000});
  assert.deepEqual(plan, {amount: 15_000_040, netGain: 15_000_000, fee: 40});

  // Already has 15M -> skips so retries never double-withdraw
  const funded = {mapId: "prontera", character: {zeny: 15_000_000}};
  assert.deepEqual(planHandoffZeny(funded, box, {autoZeny: true, targetZeny: 15_000_000}), {amount: 0, netGain: 0, fee: 0});

  // Insufficient storage Zeny throws clearly
  assert.throws(
    () => planHandoffZeny(broke, {fees: {prontera: 40}, zeny: 1_000_000}, {autoZeny: true, targetZeny: 15_000_000}),
    /帳號倉庫 Zeny 不足/,
  );
});
