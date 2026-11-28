export function skillLevel(view) {
  const character = view?.snapshot?.character;
  const skill = character?.skills?.WS_WEAPONREFINE;
  return character?.job === "whitesmith" && Number.isInteger(skill) ? Math.min(10, skill) : 0;
}

export function equipmentPlan(view, catalog, item, targetLevel, source, mode, autoEquip = false) {
  const snapshot = view?.snapshot;
  const armor = mode === "armor";
  const usesSkill = mode === "weapon";
  const definition = (armor ? catalog.armor : catalog.weapon)[item?.itemId];
  const cap = usesSkill ? skillLevel(view) : 10;
  if (view?.running !== false || cap < 1 || !definition || item.qty !== 1 ||
      item.locked || item.unidentified || item.broken) return null;
  if (!usesSkill && !catalog.refineTowns.includes(snapshot.mapId)) return null;

  const worn = source === "bag" && Object.values(snapshot.equipment).includes(item.uid);
  if (worn && usesSkill) return null;
  const [name, level, equipLevel, jobs] = definition;
  const from = item.refine ?? 0;
  const steps = catalog.steps[level];
  const jobLv = snapshot.character.jobLv;
  if ((usesSkill && !Number.isInteger(jobLv)) || !Number.isInteger(from) || from < 0) return null;

  const bonus = usesSkill ? Math.trunc((jobLv - 50) / 2) : 0;
  const rates = steps.map(([, , rate]) => Math.max(0, Math.min(100, rate + bonus)));
  const firstRisk = rates.findIndex(rate => rate < 100);
  const safe = firstRisk < 0 ? rates.length : firstRisk;
  const target = targetLevel || Math.min(cap, safe);
  const needsEquip = armor && !worn && target !== safe;
  const canEquip = autoEquip && snapshot.character.baseLv >= equipLevel &&
    (jobs === "all" || jobs?.includes(snapshot.character.job));
  if (target <= from || target > cap || target > steps.length ||
      (!usesSkill && !worn && target !== safe && !(needsEquip && canEquip))) return null;
  const method = usesSkill ? "skill" : worn || needsEquip ? "npc" : "safe";
  return {source, item, name, from, target, mode, method, needsEquip, worn,
    steps: steps.slice(from, target), rates: rates.slice(from, target)};
}

export function equipmentLocation(plan) {
  if (plan.source === "storage") return "storage";
  return plan.worn ? "worn" : "bag";
}

export function matchesEquipment(plan, query, location) {
  const term = query.trim().normalize("NFKC").toLowerCase();
  const name = plan.name.normalize("NFKC").toLowerCase();
  return (!location || equipmentLocation(plan) === location) &&
    (!term || name.includes(term) || String(plan.item.itemId) === term);
}

const maxInventorySlots = 100;
const maxWithdrawEntries = 100;

function toWeight10(weight) {
  return Math.round(weight * 10);
}

export function itemWeight(catalog, storage, itemId) {
  const fromCatalog = catalog?.weights?.[itemId];
  if (Number.isFinite(fromCatalog) && fromCatalog >= 0) return fromCatalog;
  const fromHeld = storage?.heldItems?.find(def => def.id === itemId)?.weight;
  if (Number.isFinite(fromHeld) && fromHeld >= 0) return fromHeld;
  throw new Error(`無法確認道具 #${itemId} 的重量。`);
}

function bagMaterialState(inventory, materialIds) {
  const usable = new Map();
  const hasLocked = new Map();
  const hasUnlockedStack = new Set();
  for (const id of materialIds) {
    const stacks = inventory.filter(item => item.itemId === id);
    const locked = stacks.findIndex(item => item.locked);
    const qty = stacks.slice(0, locked < 0 ? stacks.length : locked).reduce((sum, item) => sum + item.qty, 0);
    usable.set(id, qty);
    hasLocked.set(id, locked >= 0);
    if (stacks.length > 0 && locked < 0) hasUnlockedStack.add(id);
  }
  return {usable, hasLocked, hasUnlockedStack};
}

export function planNextRefineWave(view, storage, remainingPlans, useStorageMaterials, catalog) {
  if (!remainingPlans.length) {
    return {wavePlans: [], withdraw: [], partialMaterials: false, stepCap: null, blockedReason: null};
  }
  const snapshot = view?.snapshot;
  const weight = snapshot?.weight;
  const weightMax = snapshot?.derived?.weightMax;
  const hasWeight = Number.isFinite(weight) && Number.isFinite(weightMax) && weightMax > 0;
  let freeWeight10 = hasWeight ? Math.max(0, toWeight10(weightMax) - toWeight10(weight)) : Infinity;
  let freeSlots = Math.max(0, maxInventorySlots - (snapshot?.inventory?.length ?? 0));

  const materialNames = new Map();
  for (const plan of remainingPlans) {
    for (const [id, name] of plan.steps) materialNames.set(id, name);
  }
  const {usable: bagUsable, hasLocked, hasUnlockedStack} = bagMaterialState(snapshot.inventory, materialNames.keys());

  const storagePools = new Map();
  for (const item of storage?.items ?? []) {
    if (item.locked || !(item.qty > 0)) continue;
    const list = storagePools.get(item.itemId) ?? [];
    list.push({sid: item.sid, qty: item.qty});
    storagePools.set(item.itemId, list);
  }

  const wavePlans = [];
  const withdrawEq = [];
  const withdrawMatBySid = new Map();
  const allocatedMatSlots = new Set();

  const tryFitPlan = (plan, stepLimit) => {
    const needEq = plan.source === "storage";
    const eqWeight10 = needEq && hasWeight ? toWeight10(itemWeight(catalog, storage, plan.item.itemId)) : 0;
    const eqSlots = needEq ? 1 : 0;
    const eqEntries = needEq ? 1 : 0;

    const neededByMat = new Map();
    for (const [id] of plan.steps.slice(0, stepLimit)) {
      neededByMat.set(id, (neededByMat.get(id) ?? 0) + 1);
    }

    const bagDeductions = new Map();
    const matPulls = new Map();
    const newMatSlots = new Set();
    let matWeight10 = 0;

    for (const [id, qty] of neededByMat) {
      const availableInBag = bagUsable.get(id) ?? 0;
      if (hasLocked.get(id) && availableInBag < qty) {
        throw new Error(`${materialNames.get(id)} 的上鎖堆疊會被精練優先消耗，請先整理背包。`);
      }
      const fromBag = Math.min(availableInBag, qty);
      bagDeductions.set(id, fromBag);
      let needFromStorage = qty - fromBag;
      if (needFromStorage <= 0) continue;
      if (!useStorageMaterials) {
        throw new Error(`材料不足，缺少 ${materialNames.get(id)} ×${needFromStorage}。`);
      }
      if (hasWeight) {
        matWeight10 += toWeight10(itemWeight(catalog, storage, id)) * needFromStorage;
      }
      if (!hasUnlockedStack.has(id) && !allocatedMatSlots.has(id)) {
        newMatSlots.add(id);
      }
      for (const stack of storagePools.get(id) ?? []) {
        if (needFromStorage === 0) break;
        const alreadyTaken = (withdrawMatBySid.get(stack.sid) ?? 0) + (matPulls.get(stack.sid) ?? 0);
        const available = stack.qty - alreadyTaken;
        if (available <= 0) continue;
        const take = Math.min(needFromStorage, available);
        matPulls.set(stack.sid, (matPulls.get(stack.sid) ?? 0) + take);
        needFromStorage -= take;
      }
      if (needFromStorage > 0) {
        throw new Error(`材料不足，缺少 ${materialNames.get(id)} ×${needFromStorage}。`);
      }
    }

    let newMatEntries = 0;
    for (const sid of matPulls.keys()) {
      if (!withdrawMatBySid.has(sid)) newMatEntries++;
    }
    const addedWeight10 = eqWeight10 + matWeight10;
    const addedSlots = eqSlots + newMatSlots.size;
    const nextEntryCount = withdrawEq.length + eqEntries + withdrawMatBySid.size + newMatEntries;

    if (addedWeight10 > freeWeight10) {
      return {
        ok: false,
        reason: `目前剩餘負重（${freeWeight10 / 10}）不足以領取下一件裝備與材料（需要 ${addedWeight10 / 10}），請先清理背包。`,
      };
    }
    if (addedSlots > freeSlots) {
      return {
        ok: false,
        reason: `目前背包剩餘格數（${freeSlots} 格）不足以領取下一件裝備與材料（需要 ${addedSlots} 格），請先清理背包。`,
      };
    }
    if (nextEntryCount > maxWithdrawEntries) {
      return {
        ok: false,
        reason: "單次倉庫領取超過 100 項上限，請減少背包佔用後重試。",
      };
    }

    return {
      ok: true,
      commit() {
        if (needEq) withdrawEq.push({sid: plan.item.sid, qty: 1});
        for (const [id, used] of bagDeductions) bagUsable.set(id, (bagUsable.get(id) ?? 0) - used);
        for (const [sid, qty] of matPulls) withdrawMatBySid.set(sid, (withdrawMatBySid.get(sid) ?? 0) + qty);
        for (const id of newMatSlots) allocatedMatSlots.add(id);
        freeWeight10 -= addedWeight10;
        freeSlots -= addedSlots;
      },
    };
  };

  let partialMaterials = false;
  let stepCap = null;
  let blockedReason = null;

  for (const plan of remainingPlans) {
    const attempt = tryFitPlan(plan, plan.steps.length);
    if (attempt.ok) {
      attempt.commit();
      wavePlans.push(plan);
      continue;
    }
    if (wavePlans.length > 0) break;
    if (plan.method !== "safe" && plan.steps.length > 1) {
      let fitted = null;
      for (let k = plan.steps.length - 1; k >= 1; k--) {
        const partial = tryFitPlan(plan, k);
        if (partial.ok) {
          fitted = {partial, k};
          break;
        }
      }
      if (fitted) {
        fitted.partial.commit();
        wavePlans.push(plan);
        partialMaterials = true;
        stepCap = fitted.k;
        break;
      }
    }
    blockedReason = attempt.reason;
    break;
  }

  const withdraw = [
    ...withdrawEq,
    ...[...withdrawMatBySid.entries()].map(([sid, qty]) => ({sid, qty})),
  ];
  return {wavePlans, withdraw, partialMaterials, stepCap, blockedReason};
}

export function batchPlan(view, storage, equipment, useStorageMaterials, catalog) {
  const withdraw = equipment.filter(plan => plan.source === "storage")
    .map(({item}) => ({sid: item.sid, qty: 1}));
  const materials = new Map();
  let steps = 0;
  let zeny = 0;
  for (const plan of equipment) {
    for (const [id, name, , price = 0] of plan.steps) {
      const material = materials.get(id) ?? {id, name, qty: 0};
      material.qty++;
      materials.set(id, material);
      steps++;
      if (plan.method !== "skill") zeny += price;
    }
  }

  for (const material of materials.values()) {
    const stacks = view.snapshot.inventory.filter(item => item.itemId === material.id);
    const locked = stacks.findIndex(item => item.locked);
    const usable = stacks.slice(0, locked < 0 ? stacks.length : locked).reduce((sum, item) => sum + item.qty, 0);
    // The game consumes from the first stack of this material, regardless of its lock.
    if (locked >= 0 && usable < material.qty) {
      throw new Error(`${material.name} 的上鎖堆疊會被精練優先消耗，請先整理背包。`);
    }
    material.missing = Math.max(0, material.qty - usable);
    let remaining = material.missing;
    for (const item of useStorageMaterials ? storage?.items ?? [] : []) {
      if (remaining === 0) break;
      if (item.itemId !== material.id || item.locked) continue;
      const qty = Math.min(remaining, item.qty);
      if (qty > 0) withdraw.push({sid: item.sid, qty});
      remaining -= qty;
    }
    if (remaining) throw new Error(`材料不足，缺少 ${material.name} ×${remaining}。`);
  }

  const needsWithdraw = withdraw.length > 0;
  if (needsWithdraw && view.snapshot.activity === "dead") {
    throw new Error("角色目前處於死亡狀態，無法使用倉庫。");
  }
  const fee = needsWithdraw ? storage?.fees?.[view.snapshot.mapId] : 0;
  if (!Number.isFinite(fee)) throw new Error("請先讓角色回到有卡普拉倉庫服務的城鎮。");
  if (fee + zeny > view.snapshot.character.zeny) throw new Error(`Zeny 不足，精練與倉庫費合計 ${fee + zeny} Zeny。`);

  let waves = needsWithdraw ? 1 : 0;
  let firstWave = null;
  if (needsWithdraw && catalog) {
    firstWave = planNextRefineWave(view, storage, equipment, useStorageMaterials, catalog);
    if (!firstWave.wavePlans.length) {
      throw new Error(firstWave.blockedReason ?? "目前負重或背包空間不足以領取倉庫物品。");
    }
    if (firstWave.wavePlans.length < equipment.length || firstWave.partialMaterials) {
      const done = Math.max(1, firstWave.wavePlans.length - (firstWave.partialMaterials ? 0.5 : 0));
      waves = Math.max(2, Math.ceil(equipment.length / done));
    }
  } else if (withdraw.length > maxWithdrawEntries) {
    waves = Math.ceil(withdraw.length / maxWithdrawEntries);
  }
  return {withdraw, needsWithdraw, fee, waves, steps, zeny, materials: [...materials.values()]};
}

export function guardedCommand(view, command) {
  if (!Number.isInteger(view.commandRevision)) throw new Error("無法確認角色狀態版本。");
  return {commandId: crypto.randomUUID(), expectedCommandRevision: view.commandRevision, command};
}

export function nextRefineCommand(view, catalog, planned, uid, level) {
  const item = view.snapshot.inventory.find(item => item.uid === uid);
  const current = equipmentPlan(view, catalog, item, planned.target, "bag", planned.mode);
  const index = level - planned.from;
  if (!current || current.item.itemId !== planned.item.itemId || current.from !== level || current.method !== planned.method ||
      current.rates[0] !== planned.rates[index] || current.steps[0][0] !== planned.steps[index][0]) {
    throw new Error("裝備或角色狀態已變更。");
  }
  const [material, name] = current.steps[0];
  const stack = view.snapshot.inventory.find(item => item.itemId === material);
  if (!(stack?.qty >= 1)) throw new Error(`材料不足，缺少 ${name}。`);
  if (stack.locked) throw new Error(`${name} 已上鎖。`);
  if (current.method === "safe") {
    batchPlan(view, null, [current], false);
    return guardedCommand(view, {type: "refineSafe", uid});
  }
  if (current.method === "npc") {
    if (view.snapshot.character.zeny < current.steps[0][3]) throw new Error("Zeny 不足。");
    return guardedCommand(view, {type: "refine", uid});
  }
  if (!(view.snapshot.character.sp >= 5)) throw new Error("SP 不足。");
  return guardedCommand(view, {type: "refine", uid, skill: true});
}

export function associateWithdrawnEquipment(before, after, chosen) {
  const stored = chosen.filter(plan => plan.source === "storage");
  const oldUids = new Set(before.snapshot.inventory.map(item => item.uid));
  const newEquipment = after.snapshot.inventory
    .filter(item => !oldUids.has(item.uid) && stored.some(plan => plan.item.itemId === item.itemId))
    .sort((a, b) => a.uid - b.uid);
  // The game allocates backpack UIDs in the order of non-stackable withdrawal entries.
  if (newEquipment.length !== stored.length || stored.some(({item}, index) => {
    const moved = newEquipment[index];
    return moved.itemId !== item.itemId || (moved.refine ?? 0) !== (item.refine ?? 0) ||
      JSON.stringify(moved.cards ?? []) !== JSON.stringify(item.cards ?? []) ||
      moved.locked || moved.broken || moved.unidentified || moved.qty !== 1;
  })) throw new Error("無法確認取出裝備的背包位置。");

  const uidBySid = new Map(stored.map(({item}, index) => [item.sid, newEquipment[index].uid]));
  return chosen.map(plan => ({
    ...plan,
    uid: plan.source === "bag" ? plan.item.uid : uidBySid.get(plan.item.sid),
  }));
}


export function refineOutcome(view, plan, level) {
  const updated = view.snapshot.inventory.find(item => item.uid === plan.uid);
  if (!updated && plan.rates[level - plan.from] < 100) return "failure";
  if (updated?.itemId === plan.item.itemId && updated.refine === (plan.method === "safe" ? plan.target : level + 1) && !updated.broken) return "success";
  throw new Error("伺服器未確認預期精練結果。");
}

// Remove the temporary item first so restoring an accessory uses its original slot.
export async function restoreEquipment(view, original, temporaryUid, catalog, send) {
  const equipment = view.snapshot.equipment;
  const temporarySlot = Object.keys(equipment).find(slot => equipment[slot] === temporaryUid);
  const unexpected = Object.keys(equipment).some(slot =>
    equipment[slot] != null && equipment[slot] !== temporaryUid && equipment[slot] !== original[slot]);
  if (unexpected) throw new Error("裝備欄已有其他變動。");
  if (temporarySlot) {
    view = await send(view, {type: "unequip", slot: temporarySlot});
    if (view.snapshot.equipment[temporarySlot] != null) throw new Error("暫時穿戴的防具未卸下。");
  }

  for (const [slot, uid] of Object.entries(original)) {
    if (uid == null || view.snapshot.equipment[slot] === uid) continue;
    const item = view.snapshot.inventory.find(item => item.uid === uid);
    if (!item) throw new Error("原裝備已不在背包。");
    const command = {type: "equip", uid};
    if (slot === "shield" && catalog.weaponIds.includes(item.itemId)) command.hand = "left";
    view = await send(view, command);
    if (view.snapshot.equipment[slot] !== uid) throw new Error("原裝備無法回到原本欄位。");
  }
  const slots = new Set([...Object.keys(view.snapshot.equipment), ...Object.keys(original)]);
  if ([...slots].some(slot => (view.snapshot.equipment[slot] ?? null) !== (original[slot] ?? null))) {
    throw new Error("原裝備欄位未完整還原。");
  }
  return view;
}
