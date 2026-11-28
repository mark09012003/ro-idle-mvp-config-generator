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

export function rebindPlan(snapshot, characterId, backup) {
  const activeRules = snapshot.config.equipRules ?? [];
  const target = snapshot.profiles?.find(entry => entry.name === profileName)?.config;
  const reference = backup?.id !== characterId && backup?.rules?.length ? backup : null;
  if (reference && (!activeRules.length || (!target && reference.config))) {
    const profile = target ?? reference.config;
    if (!profile) throw new Error(`請回原角色重新記錄「${profileName}」完整配置。`);
    return {
      rules: handoffRules({equipRules: reference.rules}, snapshot.character.rebirth),
      useBackup: true,
      profile,
      create: !target,
    };
  }
  return {rules: activeRules, useBackup: !!reference && JSON.stringify(reference.rules) === JSON.stringify(activeRules)};
}

export function handoffItems(snapshot, config, definitions, heldItems = null) {
  const ammo = new Set((config.equipRules ?? []).map(rule => rule.ammo).filter(Boolean));
  const wornNonAmmo = new Set(Object.entries(snapshot.equipment)
    .filter(([slot, uid]) => slot !== "ammo" && uid != null).map(([, uid]) => uid));
  const ids = new Set([...wornNonAmmo,
    ...[...ruleReferences(config.equipRules ?? []).keys()].filter(uid => !ammo.has(uid))]);
  ids.delete(undefined);
  ids.delete(null);
  const heldById = new Map((heldItems ?? snapshot.heldItems ?? []).map(def => [def.id, def]));
  const inventory = new Map(snapshot.inventory.map(item => [item.uid, item]));
  return [...ids].map(uid => {
    const item = inventory.get(uid);
    const def = item ? definitions?.[item.itemId] : null;
    const held = item ? heldById.get(item.itemId) : null;
    const isAmmo = Boolean(def?.[1]?.includes("ammo") || held?.category === "ammo" || held?.slots?.includes("ammo"));
    const knownEquipment = Boolean(def || held?.category === "equipment" || wornNonAmmo.has(uid));
    if (!item || item.qty !== 1 || !knownEquipment || isAmmo || item.unidentified) {
      throw new Error(`找不到可交接的裝備 UID ${uid}，請檢查原配置及背包。`);
    }
    return item;
  });
}

export function validateReceiveHandoff(snapshot, box, record, weights = null) {
  if (snapshot?.activity === "dead") {
    throw new Error("角色目前處於死亡狀態，無法使用倉庫。");
  }
  const sameName = Boolean(snapshot?.profiles?.some(profile => profile.name === profileName));
  if (!sameName && (snapshot?.profiles?.length ?? 0) >= 10) {
    throw new Error(`目前角色已存滿 10 個配置檔，請先刪除一個配置再建立「${profileName}」。`);
  }
  if (box) {
    const freeSlots = Math.max(0, 100 - (snapshot?.inventory?.length ?? 0));
    if (record.items.length > freeSlots) {
      throw new Error(`目前角色背包空間不足（剩餘 ${freeSlots} 格，需要 ${record.items.length} 格），請先清理背包。`);
    }
    const weight = snapshot?.weight;
    const weightMax = snapshot?.derived?.weightMax;
    if (Number.isFinite(weight) && Number.isFinite(weightMax) && weightMax > 0) {
      const heldWeights = new Map((box.heldItems ?? []).map(def => [def.id, def.weight]));
      let added10 = 0;
      for (const item of record.items) {
        const w = weights?.[item.itemId] ?? heldWeights.get(item.itemId);
        if (Number.isFinite(w) && w > 0) added10 += Math.round(w * 10);
      }
      const free10 = Math.max(0, Math.round(weightMax * 10) - Math.round(weight * 10));
      if (added10 > free10) {
        throw new Error(`目前角色剩餘負重不足（剩餘 ${free10 / 10}，交接裝備總重 ${added10 / 10}），請先清理背包或提升負重。`);
      }
    }
  }
  const skippedWeaponRule = !snapshot?.character?.rebirth &&
    (record.config?.equipRules ?? []).some(rule => rule.cond?.baseLvAbove === 64 && rule.weapon != null);
  return {sameName, skippedWeaponRule};
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
