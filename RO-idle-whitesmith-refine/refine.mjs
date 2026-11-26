export function skillLevel(view) {
  const character = view?.snapshot?.character;
  const skill = character?.skills?.WS_WEAPONREFINE;
  return character?.job === "whitesmith" && Number.isInteger(skill) ? Math.min(10, skill) : 0;
}

export function weaponPlan(view, catalog, weapon, targetLevel, source = "bag") {
  const snapshot = view?.snapshot;
  const definition = catalog.weapon[weapon?.itemId];
  if (view?.running !== false || skillLevel(view) < 1 || !definition ||
      weapon.qty !== 1 || weapon.locked || weapon.unidentified || weapon.broken ||
      (source === "bag" && Object.values(snapshot.equipment ?? {}).includes(weapon.uid))) return null;

  const [name, level] = definition;
  const from = weapon.refine ?? 0;
  const steps = catalog.steps[level];
  const jobLv = snapshot.character.jobLv;
  if (!Number.isInteger(jobLv) || !Number.isInteger(from) || from < 0) return null;

  const rates = steps.map(([, , rate]) => Math.max(0, Math.min(100, rate + Math.trunc((jobLv - 50) / 2))));
  const firstRisk = rates.findIndex(rate => rate < 100);
  const safe = firstRisk < 0 ? rates.length : firstRisk;
  const target = targetLevel || Math.min(skillLevel(view), safe);
  if (target <= from || target > skillLevel(view) || target > steps.length) return null;
  return {source, weapon, name, from, target, steps: steps.slice(from, target), rates: rates.slice(from, target)};
}

export function batchPlan(view, storage, weapons) {
  const withdraw = weapons.filter(plan => plan.source === "storage")
    .map(({weapon}) => ({sid: weapon.sid, qty: 1}));
  const materials = new Map();
  let steps = 0;
  for (const plan of weapons) {
    for (const [id, name] of plan.steps) {
      const material = materials.get(id) ?? {id, name, qty: 0};
      material.qty++;
      materials.set(id, material);
      steps++;
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
    for (const item of storage?.items ?? []) {
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
  if (withdraw.length && view.snapshot.character.zeny < fee) throw new Error(`Zeny 不足，倉庫費 ${fee} Zeny。`);
  if (withdraw.length > 100) throw new Error("一次最多取出 100 項，請減少這批的武器數量。");
  return {withdraw, fee, steps, materials: [...materials.values()]};
}

export function guardedCommand(view, command) {
  if (!Number.isInteger(view.commandRevision)) throw new Error("無法確認角色狀態版本。");
  return {commandId: crypto.randomUUID(), expectedCommandRevision: view.commandRevision, command};
}

export function nextRefineCommand(view, catalog, planned, uid, level) {
  const item = view.snapshot.inventory.find(item => item.uid === uid);
  const current = weaponPlan(view, catalog, item, planned.target);
  const index = level - planned.from;
  if (!current || current.weapon.itemId !== planned.weapon.itemId || current.from !== level ||
      current.rates[0] !== planned.rates[index] || current.steps[0][0] !== planned.steps[index][0]) {
    throw new Error("武器或角色狀態已變更。");
  }
  const [material, name] = current.steps[0];
  const stack = view.snapshot.inventory.find(item => item.itemId === material);
  if (!(stack?.qty >= 1)) throw new Error(`材料不足，缺少 ${name}。`);
  if (stack.locked) throw new Error(`${name} 已上鎖。`);
  if (!(view.snapshot.character.sp >= 5)) throw new Error("SP 不足。");
  return guardedCommand(view, {type: "refine", uid, skill: true});
}

export function associateWithdrawnWeapons(before, after, chosen) {
  const stored = chosen.filter(plan => plan.source === "storage");
  const oldUids = new Set(before.snapshot.inventory.map(item => item.uid));
  const newWeapons = after.snapshot.inventory
    .filter(item => !oldUids.has(item.uid) && stored.some(plan => plan.weapon.itemId === item.itemId))
    .sort((a, b) => a.uid - b.uid);
  // The game allocates backpack UIDs in the order of non-stackable withdrawal entries.
  if (newWeapons.length !== stored.length || stored.some(({weapon}, index) => {
    const moved = newWeapons[index];
    return moved.itemId !== weapon.itemId || (moved.refine ?? 0) !== (weapon.refine ?? 0) ||
      JSON.stringify(moved.cards ?? []) !== JSON.stringify(weapon.cards ?? []) ||
      moved.locked || moved.broken || moved.unidentified || moved.qty !== 1;
  })) throw new Error("無法確認取出武器的背包位置。");

  const uidBySid = new Map(stored.map(({weapon}, index) => [weapon.sid, newWeapons[index].uid]));
  return chosen.map(plan => ({
    ...plan,
    uid: plan.source === "bag" ? plan.weapon.uid : uidBySid.get(plan.weapon.sid),
  }));
}


export function refineOutcome(view, plan, level) {
  const updated = view.snapshot.inventory.find(item => item.uid === plan.uid);
  if (!updated && plan.rates[level - plan.from] < 100) return "failure";
  if (updated?.itemId === plan.weapon.itemId && updated.refine === level + 1 && !updated.broken) return "success";
  throw new Error("伺服器未確認預期精練結果。");
}
