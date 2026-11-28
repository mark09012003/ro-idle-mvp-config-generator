import {itemFingerprint, remapRules, ruleReferences} from "./rebind.mjs";

export const profileName = "神射11轉";

function toWeight10(weight) {
  return Math.round(weight * 10);
}

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

export function planClearNewCharacter(snapshot, catalog, weights = null, heldItems = null) {
  const inventory = snapshot?.inventory ?? [];
  const byUid = new Map(inventory.map(item => [item.uid, item]));
  const unsellable = new Set(catalog?.unsellableIds ?? []);
  const heldById = new Map((heldItems ?? snapshot?.heldItems ?? []).map(def => [def.id, def]));

  const unequipSlots = [];
  for (const [slot, uid] of Object.entries(snapshot?.equipment ?? {})) {
    if (uid == null) continue;
    const item = byUid.get(uid);
    if (item && !item.locked) unequipSlots.push({slot, uid});
  }

  const clearItems = [];
  const sellUids = [];
  const discardItems = [];
  let freedWeight10 = 0;

  for (const item of inventory) {
    if (item.locked) continue;
    clearItems.push(item);
    const held = heldById.get(item.itemId);
    const w = weights?.[item.itemId] ?? held?.weight;
    if (Number.isFinite(w) && w > 0) freedWeight10 += toWeight10(w) * (item.qty ?? 1);
    const cannotSell = unsellable.has(item.itemId) || item.unidentified ||
      held?.noSell === true || (held && !(held.sell > 0));
    if (cannotSell) discardItems.push({uid: item.uid, qty: item.qty});
    else sellUids.push(item.uid);
  }

  return {unequipSlots, clearItems, sellUids, discardItems, freedWeight10, freedSlots: clearItems.length};
}

export function planHandoffArrows(record, snapshot, options, catalog, weights = null) {
  const arrowQty = Number.isInteger(options?.arrowQty) && options.arrowQty >= 1 ? Math.min(30000, options.arrowQty) : 100;
  const rules = handoffRules(record.config, snapshot.character.rebirth);
  const keptInventory = options?.clearedInventory
    ? (snapshot.inventory ?? []).filter(item => item.locked)
    : (snapshot.inventory ?? []);

  const neededIds = new Set();
  for (const rule of rules) {
    if (rule.ammo == null) continue;
    const ammoId = rule.ammoId || record.ammo?.[rule.ammo];
    if (Number.isInteger(ammoId) && ammoId > 0) neededIds.add(ammoId);
  }

  const buy = [];
  const unbuyable = [];
  let totalCost = 0;
  let extraWeight10 = 0;
  let extraSlots = 0;

  for (const ammoId of neededIds) {
    if (keptInventory.some(item => item.itemId === ammoId && item.qty > 0)) continue;
    if (!options?.autoArrows) {
      unbuyable.push(ammoId);
      continue;
    }
    const general = catalog?.arrowShops?.general?.[ammoId] ?? catalog?.arrowShops?.general?.[String(ammoId)];
    const townEntry = catalog?.arrowShops?.towns?.[snapshot.mapId]?.[ammoId] ??
      catalog?.arrowShops?.towns?.[snapshot.mapId]?.[String(ammoId)];
    const source = general ? {shop: null, name: general.name, price: general.price}
      : townEntry ? {shop: townEntry.shop, name: townEntry.name, price: townEntry.price}
      : null;
    if (!source) {
      unbuyable.push(ammoId);
      continue;
    }
    const cost = source.price * arrowQty;
    buy.push({itemId: ammoId, name: source.name, qty: arrowQty, shop: source.shop, unitPrice: source.price, cost});
    totalCost += cost;
    const w = weights?.[ammoId];
    if (Number.isFinite(w) && w > 0) extraWeight10 += toWeight10(w) * arrowQty;
    extraSlots += 1;
  }

  return {buy, totalCost, extraWeight10, extraSlots, unbuyable};
}

export function planHandoffZeny(snapshot, box, options) {
  const targetZeny = Number(options?.targetZeny);
  if (!options?.autoZeny || !Number.isSafeInteger(targetZeny) || targetZeny < 1) {
    return {amount: 0, netGain: 0, fee: 0};
  }
  const currentZeny = snapshot?.character?.zeny ?? 0;
  if (currentZeny >= targetZeny) {
    return {amount: 0, netGain: 0, fee: 0};
  }
  const fee = box?.fees?.[snapshot?.mapId];
  if (!Number.isFinite(fee)) {
    throw new Error("請到有卡普拉服務的城鎮再從倉庫提領 Zeny。");
  }
  const shortfall = targetZeny - currentZeny;
  const available = box?.zeny ?? 0;
  if (available < shortfall) {
    throw new Error(`帳號倉庫 Zeny 不足（倉庫僅有 ${available.toLocaleString()} Zeny，不足以補足至 ${targetZeny.toLocaleString()} Zeny）。`);
  }
  const amount = Math.min(available, shortfall + fee);
  if (amount <= fee) {
    throw new Error(`倉庫提領金額須大於倉庫費 ${fee} Zeny。`);
  }
  return {amount, netGain: amount - fee, fee};
}

export function validateReceiveHandoff(snapshot, box, record, weights = null, extras = null) {
  if (snapshot?.activity === "dead") {
    throw new Error("角色目前處於死亡狀態，無法使用倉庫。");
  }
  const sameName = Boolean(snapshot?.profiles?.some(profile => profile.name === profileName));
  if (!sameName && (snapshot?.profiles?.length ?? 0) >= 10) {
    throw new Error(`目前角色已存滿 10 個配置檔，請先刪除一個配置再建立「${profileName}」。`);
  }
  const freedSlots = extras?.freedSlots ?? 0;
  const freedWeight10 = extras?.freedWeight10 ?? 0;
  const extraArrowSlots = extras?.extraArrowSlots ?? 0;
  const extraArrowWeight10 = extras?.extraArrowWeight10 ?? 0;

  if (box || extraArrowSlots > 0) {
    const usedSlots = Math.max(0, (snapshot?.inventory?.length ?? 0) - freedSlots);
    const freeSlots = Math.max(0, 100 - usedSlots);
    const neededSlots = (box ? record.items.length : 0) + extraArrowSlots;
    if (neededSlots > freeSlots) {
      throw new Error(`目前角色背包空間不足（剩餘 ${freeSlots} 格，需要 ${neededSlots} 格），請先清理背包。`);
    }
    const weight = snapshot?.weight;
    const weightMax = snapshot?.derived?.weightMax;
    if (Number.isFinite(weight) && Number.isFinite(weightMax) && weightMax > 0) {
      const heldWeights = new Map((box?.heldItems ?? []).map(def => [def.id, def.weight]));
      let added10 = extraArrowWeight10;
      if (box) {
        for (const item of record.items) {
          const w = weights?.[item.itemId] ?? heldWeights.get(item.itemId);
          if (Number.isFinite(w) && w > 0) added10 += toWeight10(w);
        }
      }
      const current10 = Math.max(0, toWeight10(weight) - freedWeight10);
      const free10 = Math.max(0, toWeight10(weightMax) - current10);
      if (added10 > free10) {
        throw new Error(`目前角色剩餘負重不足（剩餘 ${free10 / 10}，需要 ${added10 / 10}），請先清理背包或提升負重。`);
      }
    }
  }
  if (Number.isFinite(extras?.projectedZeny) && Number.isFinite(extras?.requiredZeny) &&
      extras.projectedZeny < extras.requiredZeny) {
    throw new Error(`Zeny 不足（預計可用 ${extras.projectedZeny.toLocaleString()} Zeny，倉庫費與買箭需要 ${extras.requiredZeny.toLocaleString()} Zeny）。`);
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
