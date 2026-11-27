"""Add optional undying mode (still recording real incoming damage), HP-loss observations, and monsterAttack export to the pinned engine."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
declaration = """
const damageObservers = new WeakMap<GameState, (source: string, lostHp: number) => void>();

export function setDamageImmunity(s: GameState) { s.gmNoDeath = true; }

export function observeDamage(s: GameState, onDamage: (source: string, lostHp: number) => void) {
  damageObservers.set(s, onDamage);
}
"""
anchor = "function damagePlayer(s: GameState, emit: Emit, damage:"
assert source.count(anchor) == 1
source = source.replace(anchor, declaration + "\n" + anchor)

def replace_once(old, new):
    global source
    if source.count(old) != 1:
        raise ValueError(f"Upstream damage path changed: {old}")
    source = source.replace(old, new)

replace_once("  if (!devoted) c.hp = Math.max(hpFloor(s), c.hp - damage);", """  if (!devoted) {
    const before = c.hp;
    c.hp = Math.max(hpFloor(s), c.hp - damage);
    damageObservers.get(s)?.('怪物普攻', s.gmNoDeath ? damage : before - c.hp);
  }""")

replace_once("""  c.hp = Math.max(hpFloor(s), c.hp - damage);
  noteBigHit(s, damage);""", """  const before = c.hp;
  c.hp = Math.max(hpFloor(s), c.hp - damage);
  damageObservers.get(s)?.(skill ?? '怪物技能', s.gmNoDeath ? damage : before - c.hp);
  noteBigHit(s, damage);""")

for label, expression in (
    ("致命毒", "deadlyPoisonDamage(d.maxHp, c.hp, true)"),
    ("中毒", "playerPoisonDamage(d.maxHp, c.hp)"),
    ("石化", "stoneDamage(d.maxHp, c.hp)"),
):
    replace_once(f"c.hp -= {expression};", f"""{{
      const damage = {expression};
      const before = c.hp;
      c.hp = Math.max(hpFloor(s), c.hp - damage);
      damageObservers.get(s)?.('{label}', s.gmNoDeath ? damage : before - c.hp);
    }}""")

replace_once("""    c.hp = Math.max(hpFloor(s), c.hp - dmg);
    emit({ type: 'ailmentDamage', ailment: 'bleeding'""", """    const before = c.hp;
    c.hp = Math.max(hpFloor(s), c.hp - dmg);
    damageObservers.get(s)?.('出血', s.gmNoDeath ? dmg : before - c.hp);
    emit({ type: 'ailmentDamage', ailment: 'bleeding'""")

replace_once("function equipBagAmmo(", "export function equipBagAmmo(")
replace_once("function autoEquipFor(", "export function autoEquipFor(")
replace_once("function monsterAttack(", "export function monsterAttack(")

# Preserve the actual skill critical roll in the emitted event for the simulation log.
damage_path = path.parent.parent / "combat" / "damage.ts"
damage_source = damage_path.read_text()
old_return = """  if (!o.noCards) dmg = applyCardRates(dmg, d, mob, o.noEnchants);
  return { kind: 'hit', damage: dmg * o.hits, elementMod, hits: o.hits };"""
assert damage_source.count(old_return) == 1
damage_source = damage_source.replace(old_return,
    old_return.replace("hits: o.hits };", "hits: o.hits, crit: critical };"))
old_type = "hits: number; baseMiss?: true };"
assert damage_source.count(old_type) == 1
damage_source = damage_source.replace(old_type, "hits: number; baseMiss?: true; crit?: boolean };")

# Keep the real pre-defense hand totals and the proc roll, even on misses or blocks.
attack_start = damage_source.index("export function playerAttack(")
attack_end = damage_source.index("\nfunction handDamage(", attack_start)
attack = damage_source[attack_start:attack_end]
for old, new in [
    ("return { kind: 'miss' };", "return { kind: 'miss', ...(double ? { doubleAttack: true as const } : {}) };"),
    ("dual: { right: r, left: l } };", "dual: { right: r, left: l }, ...(double ? { doubleAttack: true as const } : {}) };"),
    ("...(double ? { hits } : {})", "...(double ? { hits, doubleAttack: true as const } : {})"),
]:
    assert attack.count(old) == 1
    attack = attack.replace(old, new)
damage_source = damage_source[:attack_start] + attack + damage_source[attack_end:]
damage_source = damage_source.replace("| { kind: 'miss' }\n  | { kind: 'perfectDodge' }", "| { kind: 'miss'; doubleAttack?: true }\n  | { kind: 'perfectDodge' }", 1)
damage_source = damage_source.replace("hits?: number; dual?:", "hits?: number; doubleAttack?: true; dual?:", 1)
damage_path.write_text(damage_source)
replace_once("    // 雙刀的左右手、拳刃的附加傷害明細：", """    ...('doubleAttack' in raw && raw.doubleAttack ? { doubleAttack: true } : {}),
    ...(out.kind === 'hit' && out.dual ? { dualBeforeDefense: out.dual } : {}),
    // 雙刀的左右手、拳刃的附加傷害明細：""")
replace_once("""      type: 'skillHit', skill: id, lv, uid: m.uid, monsterId: m.monsterId, result: id === 'ASC_BREAKER' && damage > 0 ? 'hit' : guarded || prot.blocked ? 'miss' : out.kind,
      damage,""", """      type: 'skillHit', skill: id, lv, uid: m.uid, monsterId: m.monsterId, result: id === 'ASC_BREAKER' && damage > 0 ? 'hit' : guarded || prot.blocked ? 'miss' : out.kind,
      ...(out.kind === 'hit' && 'crit' in out && out.crit && !guarded && !prot.blocked && damage > 0 ? { crit: true } : {}),
      damage,""")
replace_once("    let breakerMisc = 0;", """    const breakerPhysicalMiss = id === 'ASC_BREAKER' && out.kind !== 'hit';
    let breakerMisc = 0;""")
replace_once("""    const damage = prot.damage + (id === 'ASC_BREAKER' ? mobDefense(s, m, emit, breakerMisc, 'misc').damage : 0);""",
    """    const breakerInt = id === 'ASC_BREAKER' ? mobDefense(s, m, emit, breakerMisc, 'misc').damage : 0;
    const damage = prot.damage + breakerInt;""")
replace_once("""      ...(out.kind === 'hit' && 'crit' in out && out.crit && !guarded && !prot.blocked && damage > 0 ? { crit: true } : {}),""",
    """      ...(out.kind === 'hit' && 'crit' in out && out.crit && !guarded && !prot.blocked && damage > 0 ? { crit: true } : {}),
      ...(id === 'ASC_BREAKER' ? { breaker: { physical: prot.damage, intelligence: breakerInt, missed: breakerPhysicalMiss } } : {}),""")
path.write_text(source)
