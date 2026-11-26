import {itemFingerprint, remapRules, ruleReferences} from "./rebind.mjs";

export const profileName = "神射11轉";

export function sourceHandoffConfig(snapshot) {
  const saved = snapshot.profiles?.find(profile => profile.name === profileName)?.config;
  if (!saved) throw new Error(`原角色找不到已儲存的「${profileName}」配置。`);
  const equipRules = saved.equipRules?.length ? saved.equipRules : snapshot.config?.equipRules;
  if (!equipRules?.length) throw new Error("原角色的已儲存配置與目前設定都沒有自動換裝規則。");
  return {...saved, equipRules};
}

export function sameBindings(actual, expected) {
  const slots = rules => (rules ?? []).map(({weapon, shield, ammo, gear}) => [weapon, shield, ammo, gear ?? []]);
  return JSON.stringify(slots(actual)) === JSON.stringify(slots(expected));
}

export function handoffRules(config, rebirth) {
  if (rebirth) return config.equipRules ?? [];
  return (config.equipRules ?? []).flatMap(rule => {
    if (rule.cond?.baseLvAbove !== 64 || rule.weapon == null) return [rule];
    const {weapon, ...rest} = rule;
    return rest.shield || rest.ammo || rest.gear?.length ? [rest] : [];
  });
}

export function handoffItems(snapshot, config, definitions) {
  const ammo = new Set((config.equipRules ?? []).map(rule => rule.ammo).filter(Boolean));
  const ids = new Set([...Object.entries(snapshot.equipment)
    .filter(([slot]) => slot !== "ammo").map(([, uid]) => uid),
    ...[...ruleReferences(config.equipRules ?? []).keys()].filter(uid => !ammo.has(uid))]);
  ids.delete(undefined);
  ids.delete(null);
  const inventory = new Map(snapshot.inventory.map(item => [item.uid, item]));
  return [...ids].map(uid => {
    const item = inventory.get(uid);
    if (!item || item.qty !== 1 || !definitions[item.itemId] ||
        definitions[item.itemId][1].includes("ammo") || item.unidentified) {
      throw new Error(`找不到可交接的裝備 UID ${uid}，請檢查原配置及背包。`);
    }
    return item;
  });
}

export function matchMoved(before, after, expected, key) {
  const known = new Set(before.map(item => item[key]));
  const added = after.filter(item => !known.has(item[key])).sort((a, b) => a[key] - b[key]);
  if (added.length !== expected.length ||
      added.some((item, index) => item.qty !== 1 || !Number.isSafeInteger(item[key]) ||
        itemFingerprint(item) !== itemFingerprint(expected[index]))) {
    throw new Error("無法確認剛移動的裝備編號，請檢查倉庫與背包。");
  }
  return added;
}

export function destinationConfig(record, snapshot) {
  const rules = handoffRules(record.config, snapshot.character.rebirth);
  const inventory = snapshot.inventory;
  const mapping = new Map(record.items.map((item, index) => [item.uid, record.newUids[index]]));
  for (const rule of rules) {
    if (rule.ammo == null) continue;
    const ammoId = rule.ammoId || record.ammo[rule.ammo];
    const available = inventory.filter(item => ammoId && item.itemId === ammoId && item.qty > 0);
    if (!available.length) throw new Error(`新角色缺少換裝規則使用的箭矢（道具 ID ${ammoId ?? "未知"}）。備好箭矢後再繼續。`);
    mapping.set(rule.ammo, available[0].uid);
  }
  for (const uid of ruleReferences(rules).keys()) {
    if (!inventory.some(item => item.uid === mapping.get(uid))) {
      throw new Error(`無法重綁舊 UID ${uid}，請確認交接裝備仍在背包。`);
    }
  }
  return {...record.config, equipRules: remapRules(rules, mapping, inventory)};
}
