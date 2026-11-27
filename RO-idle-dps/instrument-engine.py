"""Add read-only HP-loss observations to the pinned upstream combat engine."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
declaration = "\nconst damageObservers = new WeakMap<GameState, (source: string, lostHp: number) => void>();\n\nexport function observeDamage(s: GameState, onDamage: (source: string, lostHp: number) => void) {\n  damageObservers.set(s, onDamage);\n}\n"
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
    damageObservers.get(s)?.('怪物普攻', before - c.hp);
  }""")

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
      const damage = {expression};
      c.hp -= damage;
      damageObservers.get(s)?.('{label}', damage);
    }}""")

replace_once("""    c.hp = Math.max(hpFloor(s), c.hp - dmg);
    emit({ type: 'ailmentDamage', ailment: 'bleeding'""", """    const before = c.hp;
    c.hp = Math.max(hpFloor(s), c.hp - dmg);
    damageObservers.get(s)?.('出血', before - c.hp);
    emit({ type: 'ailmentDamage', ailment: 'bleeding'""")
replace_once("function equipBagAmmo(", "export function equipBagAmmo(")
replace_once("function autoEquipFor(", "export function autoEquipFor(")
path.write_text(source)
