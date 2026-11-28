import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {batchPlan, equipmentPlan, itemWeight, planNextRefineWave} from "../refine.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(dir, "..", "catalog.json"), "utf8"));

function makeView({weight = 0, weightMax = 2000, zeny = 1_000_000, inventory = [], mapId = "prontera", job = "whitesmith", jobLv = 70} = {}) {
  return {
    characterId: 1,
    commandRevision: 10,
    running: false,
    snapshot: {
      mapId,
      activity: "stopped",
      weight,
      weightPercent: (weight / weightMax) * 100,
      derived: {weightMax},
      equipment: {},
      inventory,
      character: {
        baseLv: 99,
        job,
        jobLv,
        sp: 500,
        zeny,
        skills: {WS_WEAPONREFINE: 10},
      },
    },
  };
}

test("catalog.weights covers every refineable weapon, armor, and refine material", () => {
  for (const id of Object.keys(catalog.weapon)) {
    assert.ok(Number.isFinite(itemWeight(catalog, null, Number(id))), `missing weapon weight ${id}`);
  }
  for (const id of Object.keys(catalog.armor)) {
    assert.ok(Number.isFinite(itemWeight(catalog, null, Number(id))), `missing armor weight ${id}`);
  }
  for (const id of [1010, 1011, 984, 985]) {
    assert.equal(itemWeight(catalog, null, id), 20);
  }
});

test("planNextRefineWave chunks storage equipment and materials by remaining carry weight", () => {
  // 鋼鐵鎧甲 (2317) weighs 450, 鋁 (985) weighs 20.
  // Safe refine +0 -> +4 needs 4 鋁 (80 weight). Total per armor = 530 weight.
  // With weight 100 / 1200 -> free weight = 1100 -> fits exactly 2 armors + 8 鋁 (1060), not 3 (1590).
  const view = makeView({weight: 100, weightMax: 1200});
  const storageItems = [
    {sid: 101, itemId: 2317, qty: 1, refine: 0},
    {sid: 102, itemId: 2317, qty: 1, refine: 0},
    {sid: 103, itemId: 2317, qty: 1, refine: 0},
    {sid: 201, itemId: 985, qty: 50},
  ];
  const storage = {fees: {prontera: 40}, capacity: 600, items: storageItems};
  const chosen = storageItems.slice(0, 3).map(item => equipmentPlan(view, catalog, item, 0, "storage", "armor"));

  const wave = planNextRefineWave(view, storage, chosen, true, catalog);
  assert.equal(wave.blockedReason, null);
  assert.equal(wave.partialMaterials, false);
  assert.equal(wave.wavePlans.length, 2);
  assert.deepEqual(wave.withdraw, [
    {sid: 101, qty: 1},
    {sid: 102, qty: 1},
    {sid: 201, qty: 8},
  ]);

  const batch = batchPlan(view, storage, chosen, true, catalog);
  assert.ok(batch.waves >= 2);
  assert.equal(batch.fee, 40);
});

test("planNextRefineWave splits materials across waves when single non-safe item cannot hold all steps at once", () => {
  // 長劍 (1101) weighs 50, 強化武器金屬-級數一 (1010) weighs 20.
  // Refine +0 -> +10 (10 steps = 200 material weight + 50 weapon = 250 total).
  // Free weight = 120 -> fits weapon (50) + 3 materials (60) = 110, stepCap = 3.
  const view = makeView({weight: 880, weightMax: 1000});
  const storage = {
    fees: {prontera: 40},
    capacity: 600,
    items: [
      {sid: 11, itemId: 1101, qty: 1, refine: 0},
      {sid: 12, itemId: 1010, qty: 20},
    ],
  };
  const plan = equipmentPlan(view, catalog, storage.items[0], 10, "storage", "weapon");
  const wave = planNextRefineWave(view, storage, [plan], true, catalog);
  assert.equal(wave.blockedReason, null);
  assert.equal(wave.wavePlans.length, 1);
  assert.equal(wave.partialMaterials, true);
  assert.equal(wave.stepCap, 3);
  assert.deepEqual(wave.withdraw, [
    {sid: 11, qty: 1},
    {sid: 12, qty: 3},
  ]);
});

test("planNextRefineWave respects 100-slot backpack limit and reuses existing unlocked material stack slot", () => {
  // 98 items already in bag (including unlocked 鋁 stack 985) -> 2 free slots.
  // Each storage armor takes 1 slot; 鋁 merges into existing unlocked stack (0 new slots) -> fits 2 armors.
  const inventory = [
    {uid: 1, itemId: 985, qty: 1},
    ...Array.from({length: 97}, (_, index) => ({uid: index + 2, itemId: 501, qty: 1})),
  ];
  const view = makeView({weight: 0, weightMax: 10000, inventory});
  const storage = {
    fees: {prontera: 40},
    capacity: 600,
    items: [
      {sid: 1, itemId: 2317, qty: 1, refine: 0},
      {sid: 2, itemId: 2317, qty: 1, refine: 0},
      {sid: 3, itemId: 2317, qty: 1, refine: 0},
      {sid: 99, itemId: 985, qty: 50},
    ],
  };
  const chosen = storage.items.slice(0, 3).map(item => equipmentPlan(view, catalog, item, 0, "storage", "armor"));
  const wave = planNextRefineWave(view, storage, chosen, true, catalog);
  assert.equal(wave.wavePlans.length, 2);
  assert.deepEqual(wave.withdraw, [
    {sid: 1, qty: 1},
    {sid: 2, qty: 1},
    {sid: 99, qty: 7},
  ]);
});

test("batchPlan allows selecting more than 100 storage items by splitting into waves", () => {
  const view = makeView({weight: 0, weightMax: 50000});
  const storageItems = [
    ...Array.from({length: 105}, (_, index) => ({sid: index + 1, itemId: 1101, qty: 1, refine: 0})),
    {sid: 999, itemId: 1010, qty: 1000},
  ];
  const storage = {fees: {prontera: 40}, capacity: 600, items: storageItems};
  const chosen = storageItems.slice(0, 105).map(item => equipmentPlan(view, catalog, item, 0, "storage", "weapon"));
  const batch = batchPlan(view, storage, chosen, true, catalog);
  assert.ok(batch.waves >= 2);
  const wave1 = planNextRefineWave(view, storage, chosen, true, catalog);
  assert.ok(wave1.withdraw.length <= 100);
  assert.equal(wave1.wavePlans.length, 99);
});

test("batchPlan blocks immediately when remaining weight cannot fit even one storage item", () => {
  const view = makeView({weight: 1900, weightMax: 2000});
  const storage = {
    fees: {prontera: 40},
    capacity: 600,
    items: [
      {sid: 1, itemId: 2317, qty: 1, refine: 0},
      {sid: 2, itemId: 985, qty: 20},
    ],
  };
  const chosen = [equipmentPlan(view, catalog, storage.items[0], 0, "storage", "armor")];
  assert.throws(() => batchPlan(view, storage, chosen, true, catalog), /目前剩餘負重（100）不足/);
});
