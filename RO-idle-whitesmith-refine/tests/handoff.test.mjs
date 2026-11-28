import assert from "node:assert/strict";
import test from "node:test";
import {handoffItems, profileName, validateReceiveHandoff} from "../handoff.mjs";

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
    /剩餘負重不足（剩餘 400，交接裝備總重 550）/,
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
