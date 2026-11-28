import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {associateWithdrawnEquipment, batchPlan, equipmentPlan, itemWeight, nextRefineCommand, npcMetalPrice, planNextRefineWave, refineOutcome, restoreEquipment} from "../refine.mjs";

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

test("npcMetalPrice applies Merchant Discount and Rogue Compulsion rates", () => {
  const noDiscount = makeView();
  assert.equal(npcMetalPrice(noDiscount, catalog, 1010), 200);
  assert.equal(npcMetalPrice(noDiscount, catalog, 1011), 1000);
  assert.equal(npcMetalPrice(noDiscount, catalog, 984), null);

  const dc10 = makeView();
  dc10.snapshot.character.skills.MC_DISCOUNT = 10;
  assert.equal(npcMetalPrice(dc10, catalog, 1010), 152);
  assert.equal(npcMetalPrice(dc10, catalog, 1011), 760);
});

test("batchPlan and planNextRefineWave auto-buy missing Lv1/Lv2 metals from Prontera shop after bag and storage", () => {
  const view = makeView({
    weight: 0,
    weightMax: 2000,
    inventory: [
      {uid: 1, itemId: 1101, qty: 1, refine: 0}, // Lv1 weapon, safe +7 -> 7 × 1010
      {uid: 2, itemId: 1010, qty: 2}, // 2 in bag
    ],
  });
  view.snapshot.character.skills.MC_DISCOUNT = 10;
  const storage = {fees: {prontera: 40}, capacity: 600, items: [{sid: 9, itemId: 1010, qty: 1}]}; // 1 in storage
  const chosen = [equipmentPlan(view, catalog, view.snapshot.inventory[0], 0, "bag", "weapon")];
  const supply = {useStorageMaterials: true, buyShopMetals: true, buyVendingMaterials: false, vendingCaps: {}};

  const batch = batchPlan(view, storage, chosen, supply, catalog);
  assert.equal(batch.materials[0].missing, 1);
  assert.equal(batch.materials[0].shopBuy, 4);
  assert.equal(batch.shopCost, 4 * 152);

  const wave = planNextRefineWave(view, storage, chosen, supply, catalog);
  assert.deepEqual(wave.withdraw, [{sid: 9, qty: 1}]);
  assert.deepEqual(wave.shopBuy, [{itemId: 1010, name: "強化武器金屬-級數一", qty: 4, unitPrice: 152, cost: 608}]);
  assert.deepEqual(wave.vendingBuy, []);
});

test("batchPlan and planNextRefineWave plan vending material buys with user caps and respect weight", () => {
  const view = makeView({
    weight: 900,
    weightMax: 1000, // free weight = 100 -> fits 5 × 985 (20 each)
    inventory: [
      {uid: 1, itemId: 2317, qty: 1, refine: 0},
      {uid: 2, itemId: 2317, qty: 1, refine: 0},
    ],
  });
  const storage = {fees: {prontera: 40}, capacity: 600, items: []};
  const chosen = view.snapshot.inventory.map(item => equipmentPlan(view, catalog, item, 0, "bag", "armor")); // 4 鋁 each = 8 鋁 total
  const supply = {useStorageMaterials: true, buyShopMetals: true, buyVendingMaterials: true, vendingCaps: {985: 25000}};

  const batch = batchPlan(view, storage, chosen, supply, catalog);
  assert.equal(batch.materials[0].vendingBuy, 8);
  assert.equal(batch.vendingMaxCost, 200000);
  assert.ok(batch.waves >= 2);

  // Wave 1 fits only 1 armor's 4 鋁 (80 weight <= 100 free weight), leaving armor #2 for wave 2
  const wave1 = planNextRefineWave(view, storage, chosen, supply, catalog);
  assert.equal(wave1.wavePlans.length, 1);
  assert.deepEqual(wave1.vendingBuy, [{itemId: 985, name: "鋁", qty: 4, maxPrice: 25000}]);

  // Missing cap throws helpful prompt
  assert.throws(
    () => batchPlan(view, storage, chosen, {useStorageMaterials: true, buyShopMetals: true, buyVendingMaterials: true, vendingCaps: {}}, catalog),
    /請設定「鋁」的攤位可接受單價上限/,
  );
});

test("associateWithdrawnEquipment, nextRefineCommand, refineOutcome, and restoreEquipment handle full refine lifecycle", async () => {
  const before = makeView({
    inventory: [
      {uid: 1, itemId: 2315, qty: 1, refine: 4}, // originally worn armor (Whitesmith-equippable)
      {uid: 2, itemId: 985, qty: 10},
    ],
  });
  before.snapshot.equipment = {armor: 1};

  const storageArmor = {sid: 55, itemId: 2315, qty: 1, refine: 4};
  const plan = equipmentPlan(before, catalog, storageArmor, 5, "storage", "armor", true);
  assert.equal(plan.needsEquip, true);

  const afterWithdraw = structuredClone(before);
  afterWithdraw.commandRevision = 11;
  afterWithdraw.snapshot.inventory.push({uid: 77, itemId: 2315, qty: 1, refine: 4});
  const [linked] = associateWithdrawnEquipment(before, afterWithdraw, [plan]);
  assert.equal(linked.uid, 77);

  // Equip temporary armor, generate refine command, verify success and restore original armor
  const equippedView = structuredClone(afterWithdraw);
  equippedView.commandRevision = 12;
  equippedView.snapshot.equipment = {armor: 77};
  const cmd = nextRefineCommand(equippedView, catalog, linked, 77, 4);
  assert.deepEqual(cmd.command, {type: "refine", uid: 77});

  const refinedView = structuredClone(equippedView);
  refinedView.commandRevision = 13;
  refinedView.snapshot.inventory.find(i => i.uid === 77).refine = 5;
  assert.equal(refineOutcome(refinedView, linked, 4), "success");

  const brokenView = structuredClone(equippedView);
  brokenView.snapshot.inventory = brokenView.snapshot.inventory.filter(i => i.uid !== 77);
  assert.equal(refineOutcome(brokenView, linked, 4), "failure");

  const sent = [];
  const restored = await restoreEquipment(refinedView, {armor: 1}, 77, catalog, async (cur, command) => {
    sent.push(command);
    const next = structuredClone(cur);
    next.commandRevision++;
    if (command.type === "unequip") delete next.snapshot.equipment[command.slot];
    if (command.type === "equip") next.snapshot.equipment.armor = command.uid;
    return next;
  });
  assert.deepEqual(sent, [{type: "unequip", slot: "armor"}, {type: "equip", uid: 1}]);
  assert.equal(restored.snapshot.equipment.armor, 1);
});
