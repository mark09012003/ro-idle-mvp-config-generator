export const storageKeys = {
  activeTab: "active-tool-tab-v1",
  refineUi: "refine-ui-prefs-v1",
  refineSupply: "refine-supply-options-v1",
  marketAutoStore: "market-auto-store-v1",
  marketLastQuery: "market-last-query-v1",
  marketPresets: "market-presets-v1",
  handoffOptions: "handoff-options-v1",
};

const validTabs = new Set(["tab-refine", "tab-market", "tab-growth", "tab-handoff"]);
const validLocations = new Set(["", "bag", "worn", "storage"]);
const validHoles = new Set(["any", "non-equip", "0", "1", "2", "3", "4"]);

export const defaultHandoffOptions = {
  clearNew: true,
  autoArrows: true,
  arrowQty: 100,
  autoZeny: true,
  targetZeny: 15000000,
};

export function sanitizeHandoffOptions(raw) {
  const arrowQty = Number(raw?.arrowQty);
  const targetZeny = Number(raw?.targetZeny);
  return {
    clearNew: raw?.clearNew !== false,
    autoArrows: raw?.autoArrows !== false,
    arrowQty: Number.isInteger(arrowQty) && arrowQty >= 1 && arrowQty <= 30000 ? arrowQty : defaultHandoffOptions.arrowQty,
    autoZeny: raw?.autoZeny !== false,
    targetZeny: Number.isSafeInteger(targetZeny) && targetZeny >= 0 ? targetZeny : defaultHandoffOptions.targetZeny,
  };
}

export function sanitizeRefineUi(raw) {
  return {
    storageMaterials: raw?.storageMaterials === true,
    storageWeapons: raw?.storageWeapons === true,
    autoEquip: raw?.autoEquip === true,
    location: validLocations.has(raw?.location) ? raw.location : "",
    optionsOpen: raw?.optionsOpen === true,
  };
}

export function sanitizeMarketQuery(raw) {
  const holes = validHoles.has(String(raw?.holes)) ? String(raw.holes) : "any";
  return {
    keyword: typeof raw?.keyword === "string" ? raw.keyword.slice(0, 40) : "",
    holes,
    ceiling: typeof raw?.ceiling === "string" || Number.isFinite(raw?.ceiling) ? String(raw.ceiling).trim() : "",
    quantity: typeof raw?.quantity === "string" || Number.isFinite(raw?.quantity) ? String(raw.quantity).trim() : "1",
  };
}

export function sanitizeMarketPreset(raw) {
  const query = sanitizeMarketQuery(raw);
  const ceiling = Number(query.ceiling);
  const quantity = Number(query.quantity);
  if (!query.keyword.trim() || !Number.isSafeInteger(ceiling) || ceiling < 1 ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
    return null;
  }
  const holeLabel = {any: "不限", "non-equip": "非裝備"}[query.holes] ?? `${query.holes}洞`;
  const name = typeof raw?.name === "string" && raw.name.trim()
    ? raw.name.trim().slice(0, 60)
    : `${query.keyword.trim()}｜${holeLabel}｜≤${ceiling.toLocaleString()}｜×${quantity}`;
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : `${query.keyword.trim()}:${query.holes}:${ceiling}:${quantity}`,
    name,
    keyword: query.keyword.trim(),
    holes: query.holes,
    ceiling: String(ceiling),
    quantity: String(quantity),
  };
}

export function upsertMarketPreset(presets, entry) {
  const clean = sanitizeMarketPreset(entry);
  if (!clean) throw new Error("請先填妥有效的道具名稱、單價上限與數量（1～10000），再存成常用。");
  const next = (Array.isArray(presets) ? presets : []).filter(item => item.id !== clean.id);
  next.unshift(clean);
  return next.slice(0, 30);
}

export function removeMarketPreset(presets, id) {
  return (Array.isArray(presets) ? presets : []).filter(item => item.id !== id);
}

function readJson(store, key) {
  try {
    const raw = store.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function exportAllSettings(store) {
  const activeTab = store.getItem(storageKeys.activeTab);
  const autoStoreRaw = store.getItem(storageKeys.marketAutoStore);
  const presetsRaw = readJson(store, storageKeys.marketPresets);
  return {
    schema: "ro-idle-whitesmith-settings-v1",
    activeTab: validTabs.has(activeTab) ? activeTab : "tab-refine",
    refineUi: sanitizeRefineUi(readJson(store, storageKeys.refineUi)),
    refineSupply: readJson(store, storageKeys.refineSupply) ?? {shopMetals: true, buyVending: false, caps: {}},
    marketAutoStore: autoStoreRaw === null ? true : autoStoreRaw === "true",
    marketLastQuery: sanitizeMarketQuery(readJson(store, storageKeys.marketLastQuery)),
    marketPresets: (Array.isArray(presetsRaw) ? presetsRaw : []).map(sanitizeMarketPreset).filter(Boolean),
    handoffOptions: sanitizeHandoffOptions(readJson(store, storageKeys.handoffOptions)),
  };
}

export function importAllSettings(jsonText, store) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("設定 JSON 格式不正確，請確認已完整複製。");
  }
  if (!parsed || typeof parsed !== "object" || parsed.schema !== "ro-idle-whitesmith-settings-v1") {
    throw new Error("這不是有效的「批次裝備精練」設定檔。");
  }
  if (validTabs.has(parsed.activeTab)) store.setItem(storageKeys.activeTab, parsed.activeTab);
  store.setItem(storageKeys.refineUi, JSON.stringify(sanitizeRefineUi(parsed.refineUi)));
  if (parsed.refineSupply && typeof parsed.refineSupply === "object") {
    const caps = {};
    for (const id of [984, 985, 1010, 1011]) {
      const val = parsed.refineSupply.caps?.[id];
      caps[id] = typeof val === "string" || Number.isFinite(val) ? String(val).trim() : "";
    }
    store.setItem(storageKeys.refineSupply, JSON.stringify({
      shopMetals: parsed.refineSupply.shopMetals !== false,
      buyVending: parsed.refineSupply.buyVending === true,
      caps,
    }));
  }
  store.setItem(storageKeys.marketAutoStore, String(parsed.marketAutoStore !== false));
  store.setItem(storageKeys.marketLastQuery, JSON.stringify(sanitizeMarketQuery(parsed.marketLastQuery)));
  const presets = (Array.isArray(parsed.marketPresets) ? parsed.marketPresets : [])
    .map(sanitizeMarketPreset)
    .filter(Boolean)
    .slice(0, 30);
  store.setItem(storageKeys.marketPresets, JSON.stringify(presets));
  store.setItem(storageKeys.handoffOptions, JSON.stringify(sanitizeHandoffOptions(parsed.handoffOptions)));
  return exportAllSettings(store);
}
