import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultHandoffOptions,
  exportAllSettings,
  importAllSettings,
  removeMarketPreset,
  sanitizeHandoffOptions,
  storageKeys,
  upsertMarketPreset,
} from "../settings.mjs";

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val)),
    removeItem: key => map.delete(key),
  };
}

test("defaultHandoffOptions sets clearNew, autoArrows=100, and autoZeny=15000000", () => {
  assert.deepEqual(sanitizeHandoffOptions(null), defaultHandoffOptions);
  assert.equal(defaultHandoffOptions.targetZeny, 15000000);
  assert.equal(defaultHandoffOptions.arrowQty, 100);
});

test("upsertMarketPreset and removeMarketPreset manage presets cleanly", () => {
  let presets = upsertMarketPreset([], {keyword: "鋁", holes: "non-equip", ceiling: "22000", quantity: "500"});
  assert.equal(presets.length, 1);
  assert.equal(presets[0].keyword, "鋁");
  assert.match(presets[0].name, /鋁｜非裝備｜≤22,000｜×500/);

  // Duplicate id deduplicates and moves to top
  presets = upsertMarketPreset(presets, {keyword: "角弓", holes: "2", ceiling: "50000", quantity: "20"});
  presets = upsertMarketPreset(presets, {keyword: "鋁", holes: "non-equip", ceiling: "22000", quantity: "500"});
  assert.equal(presets.length, 2);
  assert.equal(presets[0].keyword, "鋁");

  presets = removeMarketPreset(presets, presets[0].id);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].keyword, "角弓");
});

test("exportAllSettings and importAllSettings round-trip all persisted preferences", () => {
  const src = memoryStore({
    [storageKeys.theme]: "dark",
    [storageKeys.activeTab]: "tab-handoff",
    [storageKeys.refineUi]: JSON.stringify({storageMaterials: true, storageWeapons: true, autoEquip: true, location: "storage", optionsOpen: false}),
    [storageKeys.refineSupply]: JSON.stringify({shopMetals: true, buyVending: true, caps: {984: "12000", 985: "25000", 1010: "", 1011: ""}}),
    [storageKeys.marketAutoStore]: "true",
    [storageKeys.marketLastQuery]: JSON.stringify({keyword: "鋁", holes: "non-equip", ceiling: "25000", quantity: "300"}),
    [storageKeys.marketPresets]: JSON.stringify([{keyword: "鋁", holes: "non-equip", ceiling: "25000", quantity: "300"}]),
    [storageKeys.handoffOptions]: JSON.stringify({clearNew: true, autoArrows: true, arrowQty: 200, autoZeny: true, targetZeny: 15000000}),
  });
  const exported = JSON.stringify(exportAllSettings(src));

  const dst = memoryStore();
  const imported = importAllSettings(exported, dst);
  assert.equal(imported.theme, "dark");
  assert.equal(imported.activeTab, "tab-handoff");
  assert.equal(imported.refineUi.storageWeapons, true);
  assert.equal(imported.refineSupply.caps[985], "25000");
  assert.equal(imported.marketLastQuery.keyword, "鋁");
  assert.equal(imported.marketPresets.length, 1);
  assert.equal(imported.handoffOptions.targetZeny, 15000000);
  assert.equal(imported.handoffOptions.arrowQty, 200);

  assert.throws(() => importAllSettings("not-json", dst), /JSON 格式不正確/);
  assert.throws(() => importAllSettings('{"schema":"other"}', dst), /不是有效的/);
});
