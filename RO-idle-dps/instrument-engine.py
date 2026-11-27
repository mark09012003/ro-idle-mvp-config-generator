"""Add optional incoming damage immunity and HP-loss observations to the pinned engine."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
declaration = "\nconst damageImmune = new WeakSet<GameState>();\n\nexport function setDamageImmunity(s: GameState) { damageImmune.add(s); }\n\nconst damageObservers = new WeakMap<GameState, (source: string, lostHp: number) => void>();\n\nexport function observeDamage(s: GameState, onDamage: (source: string, lostHp: number) => void) {\n  damageObservers.set(s, onDamage);\n}\n"
anchor = "function damagePlayer(s: GameState, emit: Emit, damage:"
assert source.count(anchor) == 1
source = source.replace(anchor, declaration + "\n" + anchor)

def replace_once(old, new):
    global source
    if source.count(old) != 1:
        raise ValueError(f"Upstream damage path changed: {old}")
    source = source.replace(old, new)

replace_once("  if (!devoted) c.hp = Math.max(hpFloor(s), c.hp - damage);", """  if (damageImmune.has(s)) damage = 0;
  if (!devoted) {
    const before = c.hp;
    c.hp = Math.max(hpFloor(s), c.hp - damage);
    damageObservers.get(s)?.('怪物普攻', before - c.hp);
  }""")

replace_once("""  if (basilicaInside(s) && !getMonster(monsterId).boss) return false;
  if (damage <= 0) return false;""", """  if (basilicaInside(s) && !getMonster(monsterId).boss) return false;
  if (damage <= 0 || damageImmune.has(s)) return false;""")

replace_once("""  c.hp = Math.max(hpFloor(s), c.hp - damage);
  noteBigHit(s, damage);""", """  const before = c.hp;
  c.hp = Math.max(hpFloor(s), c.hp - damage);
  damageObservers.get(s)?.(skill ?? '怪物技能', before - c.hp);
  noteBigHit(s, damage);""")

for label, expression in (
    ("致命毒", "deadlyPoisonDamage(d.maxHp, c.hp, true)"),
    ("中毒", "playerPoisonDamage(d.maxHp, c.hp)"),
    ("石化", "stoneDamage(d.maxHp, c.hp)"),
):
    replace_once(f"c.hp -= {expression};", f"""{{
      const damage = damageImmune.has(s) ? 0 : {expression};
      c.hp -= damage;
      damageObservers.get(s)?.('{label}', damage);
    }}""")

replace_once("""    c.hp = Math.max(hpFloor(s), c.hp - dmg);
    emit({ type: 'ailmentDamage', ailment: 'bleeding'""", """    const before = c.hp;
    if (!damageImmune.has(s)) c.hp = Math.max(hpFloor(s), c.hp - dmg);
    damageObservers.get(s)?.('出血', before - c.hp);
    emit({ type: 'ailmentDamage', ailment: 'bleeding'""")
replace_once("function equipBagAmmo(", "export function equipBagAmmo(")
replace_once("function autoEquipFor(", "export function autoEquipFor(")
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
damage_path.write_text(damage_source.replace(old_type, "hits: number; baseMiss?: true; crit?: boolean };"))
replace_once("""      type: 'skillHit', skill: id, lv, uid: m.uid, monsterId: m.monsterId, result: id === 'ASC_BREAKER' && damage > 0 ? 'hit' : guarded || prot.blocked ? 'miss' : out.kind,
      damage,""", """      type: 'skillHit', skill: id, lv, uid: m.uid, monsterId: m.monsterId, result: id === 'ASC_BREAKER' && damage > 0 ? 'hit' : guarded || prot.blocked ? 'miss' : out.kind,
      ...(out.kind === 'hit' && 'crit' in out && out.crit && !guarded && !prot.blocked && damage > 0 ? { crit: true } : {}),
      damage,""")
path.write_text(source)
