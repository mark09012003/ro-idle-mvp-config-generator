export function weaponPlan(view, catalog, uid) {
  const snapshot = view?.snapshot;
  const character = snapshot?.character;
  const skill = character?.skills?.WS_WEAPONREFINE;
  if (character?.job !== "whitesmith" || !Number.isInteger(skill) || skill < 1 ||
      view.running !== false || !Array.isArray(snapshot.inventory) || !snapshot.equipment) return null;
  const weapon = snapshot.inventory.find(item => item.uid === uid);
  const definition = catalog.weapon[weapon?.itemId];
  if (!definition || weapon.locked || weapon.unidentified || weapon.broken ||
      Object.values(snapshot.equipment).includes(uid)) return null;
  const [name, level] = definition;
  const from = weapon.refine ?? 0;
  const steps = catalog.steps[level] ?? [];
  const target = Math.min(skill, steps.length);
  if (!Number.isInteger(from) || from < 0 || from >= target) return null;
  return {uid, itemId: weapon.itemId, name, from, target, materials: steps.slice(from, target)};
}

export function nextRefineCommand(view, catalog, planned, commandId) {
  const current = weaponPlan(view, catalog, planned.uid);
  if (!current || current.itemId !== planned.itemId || current.from < planned.from ||
      current.from >= planned.target || current.target < planned.target) {
    throw new Error("武器或角色狀態已變更，請更新背包後再試。");
  }
  if (!Number.isInteger(view.commandRevision)) throw new Error("無法確認角色狀態版本。");
  const [material, name] = current.materials[0];
  const amount = view.snapshot.inventory
    .filter(item => item.itemId === material && !item.locked)
    .reduce((sum, item) => sum + item.qty, 0);
  if (!Number.isFinite(amount) || amount < 1) throw new Error(`材料不足：${name}。`);
  if (!(view.snapshot.character.sp >= 5)) throw new Error("SP 不足。");
  return {
    commandId,
    expectedCommandRevision: view.commandRevision,
    command: {type: "refine", uid: current.uid, skill: true},
  };
}
