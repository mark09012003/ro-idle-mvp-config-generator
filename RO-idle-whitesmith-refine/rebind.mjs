export function ruleReferences(rules) {
  const refs = new Map();
  for (const rule of rules) {
    for (const slot of ["weapon", "shield", "ammo", "gear"]) {
      const values = slot === "gear" ? rule.gear ?? [] : [rule[slot]];
      for (const uid of values) {
        if (!Number.isSafeInteger(uid) || uid < 1) continue;
        if (!refs.has(uid)) refs.set(uid, new Set());
        refs.get(uid).add(slot);
      }
    }
  }
  return refs;
}

export function suitableItem(item, slots, definitions) {
  const allowed = definitions[item.itemId]?.[1];
  if (!allowed || item.broken || item.unidentified) return false;
  return [...slots].every(slot => {
    if (slot === "gear") return allowed.some(part => !["weapon", "shield", "ammo"].includes(part));
    return allowed.includes(slot) || (slot === "shield" && allowed.includes("weapon"));
  });
}

export function itemFingerprint(item) {
  const stable = value => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const cards = [...(item.cards ?? [])];
  while (cards.length && !cards.at(-1)) cards.pop();
  return JSON.stringify([item.itemId, item.refine ?? 0, cards, stable(item.forged) ?? null,
    Boolean(item.broken), Boolean(item.unidentified)]);
}

export function remapRules(rules, mapping, inventory) {
  const byUid = new Map(inventory.map(item => [item.uid, item]));
  return rules.map(rule => {
    const next = {...rule};
    for (const slot of ["weapon", "shield", "ammo"]) {
      const replacement = mapping.get(rule[slot]);
      if (replacement == null) continue;
      next[slot] = replacement;
      if (slot === "ammo") next.ammoId = byUid.get(replacement).itemId;
    }
    if (rule.gear) next.gear = rule.gear.map(uid => mapping.get(uid) ?? uid);
    if (new Set(next.gear).size !== (next.gear?.length ?? 0) && next.gear?.some((uid, index) => uid !== rule.gear[index])) {
      throw new Error("同一條規則的不同裝備不能綁到同一件。");
    }
    if (next.weapon != null && next.weapon === next.shield && rule.weapon !== rule.shield) {
      throw new Error("同一條規則的主手與副手不能綁到同一件。");
    }
    return next;
  });
}
