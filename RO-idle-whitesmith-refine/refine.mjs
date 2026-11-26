export function skillLevel(view) {
  const character = view?.snapshot?.character;
  const skill = character?.skills?.WS_WEAPONREFINE;
  return character?.job === "whitesmith" && Number.isInteger(skill) ? Math.min(10, skill) : 0;
}

export function equipmentPlan(view, catalog, item, targetLevel, source, mode) {
  const snapshot = view?.snapshot;
  const armor = mode === "armor";
  const definition = (armor ? catalog.armor : catalog.weapon)[item?.itemId];
  const cap = armor ? 10 : skillLevel(view);
  if (view?.running !== false || cap < 1 || !definition || item.qty !== 1 ||
      item.locked || item.unidentified || item.broken) return null;
  if (armor && !catalog.refineTowns.includes(snapshot.mapId)) return null;

  const worn = source === "bag" && Object.values(snapshot.equipment).includes(item.uid);
  if (worn && !armor) return null;
  const [name, level] = definition;
  const from = item.refine ?? 0;
  const steps = catalog.steps[level];
  const jobLv = snapshot.character.jobLv;
  if ((!armor && !Number.isInteger(jobLv)) || !Number.isInteger(from) || from < 0) return null;

  const bonus = armor ? 0 : Math.trunc((jobLv - 50) / 2);
  const rates = steps.map(([, , rate]) => Math.max(0, Math.min(100, rate + bonus)));
  const firstRisk = rates.findIndex(rate => rate < 100);
  const safe = firstRisk < 0 ? rates.length : firstRisk;
  const target = targetLevel || Math.min(cap, safe);
  if (target <= from || target > cap || target > steps.length || (armor && !worn && target !== safe)) return null;
  const method = armor ? (worn ? "npc" : "safe") : "skill";
  return {source, item, name, from, target, mode, method, steps: steps.slice(from, target), rates: rates.slice(from, target)};
}

export function batchPlan(view, storage, equipment, useStorageMaterials) {
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
      zeny += price;
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

  const fee = withdraw.length ? storage?.fees?.[view.snapshot.mapId] : 0;
  if (!Number.isFinite(fee)) throw new Error("請先讓角色回到有卡普拉倉庫服務的城鎮。");
  if (fee + zeny > view.snapshot.character.zeny) throw new Error(`Zeny 不足，精練與倉庫費合計 ${fee + zeny} Zeny。`);
  if (withdraw.length > 100) throw new Error("一次最多取出 100 項，請減少這批的武器數量。");
  return {withdraw, fee, steps, zeny, materials: [...materials.values()]};
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
