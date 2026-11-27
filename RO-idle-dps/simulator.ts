// SPDX-License-Identifier: GPL-3.0-only
import { createGameState, type GameState, type ActiveMonster } from "./src/game/sim/state";
import { derived, moveTime, nextEventTime, processAt } from "./src/game/sim/engine";
import { defaultAutoConfig } from "./src/game/ai/config";
import { MONSTERS, type MonsterDef } from "./src/game/data/monsters";
import { MAPS } from "./src/game/data/maps";
import { SKILLS, atLv } from "./src/game/data/skills";
import { canAttackWithSkill } from "./src/game/combat/skillEffects";
import { monsterDefender, playerHitRate, playerCritRate } from "./src/game/combat/damage";
import { elementModifier } from "./src/game/data/elements";
import { registerItemDefs } from "./src/game/data/items";
import { withPetBuff } from "./src/game/sim/pet";
import { NEVER } from "./src/game/config/gameplay";
import type { GameSnapshot } from "./src/game/view";

export const targets = [...MONSTERS.values()].filter(monster => monster.hp > 0)
  .map(({id, name, lv}) => ({id, name, lv}));

export function attackSkills(snapshot: GameSnapshot) {
  return Object.entries(snapshot.character.skills ?? {}).flatMap(([id, lv]) => {
    const skill = SKILLS.get(id);
    return skill && lv > 0 && canAttackWithSkill(id) ? [{id, name: skill.name, lv}] : [];
  });
}

type Options = {monsterId: number; mode: "normal" | "skill" | "auto"; skill?: string; level?: number; seconds: number};
type DamageLine = {name: string; damage: number; hits: number; casts: number; castMs: number; delayMs: number; cooldownMs: number};

function setup(snapshot: GameSnapshot, options: Options, seed: number) {
  const state = createGameState(snapshot.character.name, seed, {exp:0, drop:0});
  state.character = structuredClone(snapshot.character);
  state.inventory = {items: structuredClone(snapshot.inventory),
    nextUid: Math.max(0, ...snapshot.inventory.map(item => item.uid)) + 1};
  state.equipment = {...snapshot.equipment};
  state.buffs = withPetBuff(snapshot.buffs ?? [], snapshot).map(buff => ({
    ...structuredClone(buff),
    until: "remainingMs" in buff ? Math.max(0, Number(buff.remainingMs)) : NEVER,
  }));
  state.ailments = Object.fromEntries((snapshot.ailments ?? []).map(ailment =>
    [ailment.id, {until: ailment.remainingMs, lv: ailment.lv ?? 1}]));
  if (snapshot.cart) state.cart = {items: [], nextUid: 1};
  const config = defaultAutoConfig();
  const loaded = snapshot.config;
  const map = [snapshot.mapId, loaded.lockMap, config.lockMap].find(id => MAPS.get(id)?.type !== "town" && MAPS.has(id))!;
  state.mapId = map;
  state.saveMap = map;
  state.entitlement.noIncome = true;
  state.config = {
    ...config,
    lockMap: map,
    autoLoot: false,
    stopOnOverweight: false,
    autoBuy: {...config.autoBuy, enabled: false},
    statsAddAuto: {...config.statsAddAuto, enabled: false},
    hpPotion: loaded.hpPotion ?? config.hpPotion,
    spPotion: loaded.spPotion ?? config.spPotion,
    buffPotion: loaded.buffPotion ?? config.buffPotion,
    autoBerserk: loaded.autoBerserk,
    recovery: loaded.recovery ?? config.recovery,
    sit: options.mode === "auto" ? loaded.sit ?? config.sit : {...config.sit, enabled: false},
  };
  if (options.mode === "auto") {
    state.config.skills = (loaded.skills ?? []).filter(skill => skill.use !== "escape");
    state.config.equipRules = loaded.equipRules;
    state.config.combat = loaded.combat ?? config.combat;
  } else if (options.mode === "skill") {
    const selected = attackSkills(snapshot).find(skill => skill.id === options.skill);
    if (!selected || !Number.isInteger(options.level) || options.level! < 1 || options.level! > selected.lv) {
      throw new Error("請選擇角色已學會的攻擊技能和等級。");
    }
    state.config.skills = [{skill:selected.id, lv:options.level!, use:"attack", percent:0}];
  }
  return state;
}

function replaceTarget(state: GameState, target: MonsterDef): ActiveMonster {
  const monster: ActiveMonster = {
    uid: state.nextMonsterUid++, monsterId: target.id, hp: target.hp, distance: 1,
    aggro: false, arriveAt: state.time, engageAt: state.time, nextAttackAt: NEVER,
    skillReadyAt: Object.fromEntries((target.skills ?? []).map((_, index) => [index, NEVER])),
  };
  state.monsters = [monster];
  state.targetUid = monster.uid;
  state.activity = {kind:"attacking", targetUid: monster.uid};
  state.timers.nextAmbush = NEVER;
  return monster;
}

export function simulate(snapshot: GameSnapshot, options: Options) {
  const monster = MONSTERS.get(options.monsterId);
  if (!monster || ![30, 60, 120].includes(options.seconds)) throw new Error("請選擇有效怪物與試算時間。");
  registerItemDefs(snapshot.heldItems ?? []);
  const duration = options.seconds * 1000;
  const trials = 16;
  const lines = new Map<string, DamageLine>();
  const line = (id: string) => {
    if (!lines.has(id)) lines.set(id, {name: SKILLS.get(id)?.name ?? id, damage:0, hits:0, casts:0, castMs:0, delayMs:0, cooldownMs:0});
    return lines.get(id)!;
  };
  let total = 0, kills = 0, casts = 0, endingSp = 0;
  const killTimes: number[] = [];
  let panel;
  for (let run = 0; run < trials; run++) {
    const state = setup(snapshot, options, 91237 + 7919 * run);
    let current = replaceTarget(state, monster);
    let firstKill = false;
    let credited = 0;
    if (!panel) {
      const stats = derived(state);
      const defender = monsterDefender(monster);
      panel = {
        element: stats.attackElement, interval: stats.attackIntervalMs, aspd: stats.aspd,
        hit: playerHitRate(stats, monster), crit: playerCritRate(stats, monster),
        modifier: elementModifier(stats.attackElement, monster.element, monster.elementLv),
        def: monster.def, mdef: defender.mdef, map: MAPS.get(state.mapId)?.name,
      };
    }
    for (let steps = 0; steps < 15000; steps++) {
      const next = nextEventTime(state);
      if (next > duration || state.activity.kind === "stopped" || state.activity.kind === "dead") break;
      moveTime(state, Math.max(state.time, next));
      processAt(state, event => {
        if (event.type === "skillCast") {
          const entry = line(event.skill);
          entry.casts++;
          entry.castMs += event.castMs;
          entry.delayMs += event.delayMs ?? 0;
          const def = SKILLS.get(event.skill);
          entry.cooldownMs += atLv(def?.cooldownMs ?? [], event.lv) ?? 0;
          casts++;
        }
        if ((event.type === "playerAttack" || event.type === "skillHit" || event.type === "homunAttack") &&
            event.uid === current.uid && event.damage > 0) {
          const entry = line(event.type === "playerAttack" ? "普攻" : event.type === "homunAttack" ? "生命體" : event.skill);
          const damage = Math.min(event.damage, Math.max(0, monster.hp - credited));
          credited += damage;
          entry.damage += damage;
          entry.hits++;
        }
      });
      if (current.hp <= 0 && !state.monsters.includes(current)) {
        total += monster.hp;
        kills++;
        if (!firstKill) {
          killTimes.push(state.time);
          firstKill = true;
        }
        current = replaceTarget(state, monster);
        credited = 0;
      } else if (!state.monsters.includes(current) || current.monsterId !== monster.id) break;
      if (steps === 14999) throw new Error("模擬事件超過上限，請改用較短的試算時間。");
    }
    total += Math.max(0, monster.hp - current.hp);
    endingSp += state.character.sp;
  }
  return {monster: {name:monster.name, lv:monster.lv, hp:monster.hp, element:monster.element,
    elementLv:monster.elementLv, race:monster.race, size:monster.size}, panel,
    dps: total / trials / options.seconds,
    averageKill: killTimes.length ? killTimes.reduce((sum, t) => sum + t, 0) / killTimes.length : null,
    killedTrials: killTimes.length, kills, casts, endingSp:endingSp / trials, trials, seconds:options.seconds,
    lines: [...lines.values()].sort((a,b) => b.damage - a.damage)
      .map(entry => ({...entry, share:total ? entry.damage / total : 0})),
  };
}
