// SPDX-License-Identifier: GPL-3.0-only
import { createGameState, type GameState, type ActiveMonster, type ActiveBuff } from "./src/game/sim/state";
import { derived, moveTime, nextEventTime, observeDamage, processAt, receiveHealing } from "./src/game/sim/engine";
import { SONGS, type PerformerCtx } from "./src/game/combat/songs";
import { defaultAutoConfig } from "./src/game/ai/config";
import { MONSTERS, type MonsterDef } from "./src/game/data/monsters";
import { MAPS } from "./src/game/data/maps";
import { SKILLS, atLv } from "./src/game/data/skills";
import { canAttackWithSkill } from "./src/game/combat/skillEffects";
import { monsterDefender, playerHitRate, playerCritRate } from "./src/game/combat/damage";
import { effectiveMonster, POISON_INTERVAL_MS, STATUS_NAMES, type MobStatusId, type MobStatuses } from "./src/game/combat/monsterStatus";
import { buffDisplayName, getBuff, isKnownBuff } from "./src/game/data/buffs";
import { elementModifier } from "./src/game/data/elements";
import { getItem, ITEMS, registerItemDefs } from "./src/game/data/items";
import { getAmmo, getEquipped, SLOT_NAMES } from "./src/game/items/equipment";
import { withPetBuff } from "./src/game/sim/pet";
import { AILMENT_NAMES, BLEEDING_TICK_MS } from "./src/game/combat/ailments";
import { randInt } from "./src/game/core/rng";
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

const manualBuffIds = [
  "AL_BLESSING", "AL_INCAGI", "AL_ANGELUS", "AC_CONCENTRATION", "SN_SIGHT", "SN_WINDWALK",
  "PR_IMPOSITIO", "PR_SUFFRAGIUM", "PR_ASPERSIO", "PR_BENEDICTIO", "HP_ASSUMPTIO",
  "MG_ENERGYCOAT", "BS_ADRENALINE", "BS_WEAPONPERFECT", "BS_OVERTHRUST", "BS_MAXIMIZE",
  "KN_TWOHANDQUICKEN", "AS_ENCHANTPOISON", "SA_FLAMELAUNCHER", "SA_FROSTWEAPON",
  "SA_LIGHTNINGLOADER", "SA_SEISMICWEAPON", "itemEndowWater",
  "aspdPotion1", "aspdPotion2", "aspdPotion3", "resistFire", "resistWater", "resistWind", "resistEarth",
  "strFood5", "agiFood5", "vitFood5", "intFood5", "dexFood5", "lukFood5",
].filter(isKnownBuff);
const songStats: Record<string, readonly (keyof PerformerCtx["stats"])[]> = {
  BA_WHISTLE:["agi", "luk"],
  BA_ASSASSINCROSS:["agi"],
  BA_POEMBRAGI:["dex", "int"],
  BA_APPLEIDUN:["vit"],
  DC_HUMMING:["dex"],
  DC_FORTUNEKISS:["luk"],
  DC_SERVICEFORYOU:["int"],
};
const songIds = Object.keys(songStats).filter(id => SONGS[id]?.party && SKILLS.has(id));
const manualStatuses: Partial<Record<MobStatusId, number>> = {
  aeterna:1, provoke:10, quagmire:5, crucis:10, decagi:10, mindBreaker:5,
  freeze:1, stone:1, stun:1, sleep:1, silence:1, blind:1, poison:1, deadlyPoison:1, bleeding:1,
  spiderweb:1, fogwall:1, agiup:1, autoguard:10, defender:5, assumptio:5, reflectShield:10, powerup:1,
};
const maximumBuffLevel = (id: string) => SKILLS.get(id)?.maxLv ?? 1;
const previewBuffs = (snapshot: GameSnapshot) => withPetBuff(snapshot.buffs ?? [], snapshot);

export function scenarioCatalog(snapshot: GameSnapshot) {
  return {
    active: previewBuffs(snapshot).map((buff, index) => ({
      index, name: buffDisplayName(buff.id), level: "lv" in buff ? buff.lv : undefined,
    })),
    buffs: [...manualBuffIds, ...songIds].map(id => ({
      id, name:buffDisplayName(id), max:maximumBuffLevel(id),
      ...(songIds.includes(id) && {stats:songStats[id], lessonName:id.startsWith("DC_") ? "練習舞蹈等級" : "操控樂器等級"}),
    })),
    statuses: Object.entries(manualStatuses).map(([id, max]) => ({id, name:STATUS_NAMES[id as MobStatusId], max})),
  };
}

type Effect = {id: string; level: number; seconds: number; performer?: Partial<PerformerCtx["stats"]> & {lesson?: number}};
type Scenario = {includeActive?: number[]; buffs?: Effect[]; statuses?: Effect[]; autoBuffs?: boolean};

function effectTime(effect: Effect, max: number) {
  if (!Number.isInteger(effect.level) || effect.level < 1 || effect.level > max ||
      !Number.isInteger(effect.seconds) || effect.seconds < 0 || effect.seconds > 120) {
    throw new Error("請確認效果等級及持續秒數。");
  }
  return effect.seconds * 1000;
}

function songParameters(effect: Effect) {
  const entry = SONGS[effect.id];
  const stats = {str:1, agi:1, vit:1, int:1, dex:1, luk:1};
  const lesson = effect.performer?.lesson ?? 10;
  if (!Number.isInteger(lesson) || lesson < 0 || lesson > 10) throw new Error("操控樂器或練習舞蹈等級須為 0～10。");
  for (const key of songStats[effect.id]) {
    const value = effect.performer?.[key] ?? 90;
    if (!Number.isInteger(value) || value < 0 || value > 999) throw new Error(`演奏者 ${key.toUpperCase()} 須為 0～999。`);
    stats[key] = value;
  }
  const ctx = {stats, lesson};
  return {bonuses:entry.party!(effect.level, ctx), heal:entry.heal?.(effect.level, ctx) ?? 0, interval:entry.drainSec * 1000};
}

function buffGroup(active: ActiveBuff) {
  const definition = getBuff(active.id, active.lv, active.party);
  if ((active.bonuses ?? definition.bonuses).attackElement) return "attack-element";
  return definition.group;
}

function initialBuffs(snapshot: GameSnapshot, scenario?: Scenario): ActiveBuff[] {
  const buffs: ActiveBuff[] = [];
  function add(buff: ActiveBuff) {
    const group = buffGroup(buff);
    for (let index = buffs.length - 1; index >= 0; index--) {
      if (buffs[index].id === buff.id || (group && buffGroup(buffs[index]) === group)) buffs.splice(index, 1);
    }
    buffs.push(buff);
  }
  for (const [index, buff] of previewBuffs(snapshot).entries()) {
    if (!scenario?.includeActive?.includes(index) || !isKnownBuff(buff.id)) continue;
    const remaining = "remainingMs" in buff ? Number(buff.remainingMs) : NEVER;
    if (Number.isFinite(remaining) && remaining > 0) add({...structuredClone(buff), until:remaining});
  }
  for (const effect of scenario?.buffs ?? []) {
    if (!manualBuffIds.includes(effect.id) && !songIds.includes(effect.id)) throw new Error("所選 Buff 不支援手動加入。");
    const until = effectTime(effect, maximumBuffLevel(effect.id)) || NEVER;
    const song = songIds.includes(effect.id) ? songParameters(effect) : null;
    add({id:effect.id, lv:effect.level, until, ...(song && {party:true, bonuses:song.bonuses})});
  }
  return buffs;
}

function initialStatuses(effects: Effect[], time: number): MobStatuses {
  const status: MobStatuses = {};
  for (const effect of effects) {
    const id = effect.id as MobStatusId;
    const max = manualStatuses[id];
    if (!max) throw new Error("所選怪物狀態不支援手動加入。");
    const duration = effectTime(effect, max);
    if ((id === "stone" && status.freeze) || (id === "freeze" && status.stone)) {
      throw new Error("冰凍與石化請擇一設定。");
    }
    const nextTick = id === "poison" || id === "deadlyPoison" ? POISON_INTERVAL_MS
      : id === "bleeding" ? BLEEDING_TICK_MS : 0;
    status[id] = {lv:effect.level, until:duration ? time + duration : NEVER,
      ...(nextTick && {nextTick:time + nextTick})};
  }
  return status;
}

type Options = {monsterId: number; mode: "normal" | "skill" | "auto"; skill?: string; level?: number; seconds: number; counterattack?: boolean; unlimitedSp?: boolean; scenario?: Scenario};
type DamageLine = {name: string; damage: number; hits: number; casts: number; castMs: number; delayMs: number; cooldownMs: number};

function setup(snapshot: GameSnapshot, options: Options, seed: number) {
  const state = createGameState(snapshot.character.name, seed, {exp:0, drop:0});
  state.character = structuredClone(snapshot.character);
  state.inventory = {items: structuredClone(snapshot.inventory),
    nextUid: Math.max(0, ...snapshot.inventory.map(item => item.uid)) + 1};
  state.equipment = {...snapshot.equipment};
  state.buffs = initialBuffs(snapshot, options.scenario);
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
    spPotion: options.unlimitedSp ? {...config.spPotion, enabled:false} : loaded.spPotion ?? config.spPotion,
    buffPotion: options.scenario?.autoBuffs ? loaded.buffPotion ?? config.buffPotion : {...config.buffPotion, enabled:false},
    autoBerserk: options.scenario?.autoBuffs ? loaded.autoBerserk : false,
    recovery: loaded.recovery ?? config.recovery,
    sit: options.mode === "auto" ? loaded.sit ?? config.sit : {...config.sit, enabled: false},
  };
  if (options.mode === "auto") {
    state.config.skills = (loaded.skills ?? []).filter(skill =>
      skill.use !== "escape" && (options.scenario?.autoBuffs || skill.use !== "buff"));
    state.config.equipRules = loaded.equipRules;
    state.config.combat = loaded.combat ?? config.combat;
  } else if (options.mode === "skill") {
    const selected = attackSkills(snapshot).find(skill => skill.id === options.skill);
    if (!selected || !Number.isInteger(options.level) || options.level! < 1 || options.level! > selected.lv) {
      throw new Error("請選擇角色已學會的攻擊技能和等級。");
    }
    state.config.skills = [{skill:selected.id, lv:options.level!, use:"attack", percent:0}];
  }
  const stats = derived(state);
  state.character.hp = Math.min(state.character.hp, stats.maxHp);
  state.character.sp = options.unlimitedSp ? stats.maxSp : Math.min(state.character.sp, stats.maxSp);
  return state;
}

export function previewCharacter(snapshot: GameSnapshot, scenario?: Scenario) {
  registerItemDefs(snapshot.heldItems ?? []);
  const options: Options = {monsterId:0, mode:"normal", seconds:30};
  function panel(state: GameState) {
    const stats = derived(state);
    return {
      ...Object.fromEntries(Object.entries(stats.total).map(([key, value]) => [key.toUpperCase(), value])),
      "最大 HP":stats.maxHp, "最大 SP":stats.maxSp, ASPD:stats.aspd, HIT:stats.hit, FLEE:stats.flee,
      CRIT:stats.crit, DEF:stats.hardDefShown, MDEF:stats.hardMdef,
      "MATK 下限":stats.matkMin, "MATK 上限":stats.matkMax,
    };
  }
  const current = setup(snapshot, {...options, scenario}, 1);
  const baseline = setup(snapshot, options, 1);
  const base = panel(baseline);
  const equipment = getEquipped(baseline.inventory, baseline.equipment).map(({slot, stack, def}) => ({
    slot:SLOT_NAMES[slot], name:def.name, refine:stack.refine ?? 0, broken:!!stack.broken,
    cards:(stack.cards ?? []).filter(Boolean).map(id => ITEMS.get(id)?.name ?? `#${id}`),
  }));
  const ammo = getAmmo(baseline.inventory, baseline.equipment);
  const stats = derived(current);
  const allocated = Object.fromEntries(Object.entries(baseline.character.stats)
    .map(([key, value]) => [key.toUpperCase(), value]));
  return {
    base, current:current.buffs.length ? panel(current) : null,
    names:current.buffs.map(buff => buffDisplayName(buff.id)), allocated, equipment,
    weaponType:stats.weaponType, attackElement:stats.attackElement,
    ammo:ammo ? {name:ammo.def.name, atk:ammo.def.atk, element:ammo.def.element, quantity:ammo.stack.qty} : null,
  };
}

function replaceTarget(state: GameState, target: MonsterDef, options: Options): ActiveMonster {
  const counterattack = options.counterattack ?? false;
  const monster: ActiveMonster = {
    uid: state.nextMonsterUid++, monsterId: target.id, hp: target.hp, distance: 1,
    status: initialStatuses(options.scenario?.statuses ?? [], state.time),
    aggro: counterattack, arriveAt: state.time, engageAt: state.time,
    nextAttackAt: counterattack ? state.time + randInt(state.rng.encounter, 100, 500) : NEVER,
    ...(!counterattack && {skillReadyAt: Object.fromEntries((target.skills ?? []).map((_, index) => [index, NEVER]))}),
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
  const songs = (options.scenario?.buffs ?? []).filter(effect => songIds.includes(effect.id)).map(effect => {
    effectTime(effect, maximumBuffLevel(effect.id));
    return {id:effect.id, name:buffDisplayName(effect.id), ...songParameters(effect)};
  });
  const lines = new Map<string, DamageLine>();
  const line = (id: string) => {
    if (!lines.has(id)) lines.set(id, {name: SKILLS.get(id)?.name ?? id, damage:0, hits:0, casts:0, castMs:0, delayMs:0, cooldownMs:0});
    return lines.get(id)!;
  };
  let total = 0, kills = 0, casts = 0, endingSp = 0;
  const killTimes: number[] = [];
  const deathTimes: number[] = [];
  const timeline: {at: number; text: string; hp: number; kind: string}[] = [];
  let timelineCount = 0;
  const received = new Map<string, number>();
  let damageTaken = 0, timeExposed = 0, endingHp = 0;
  let panel;
  for (let run = 0; run < trials; run++) {
    const state = setup(snapshot, options, 91237 + 7919 * run);
    let current = replaceTarget(state, monster, options);
    const pulses = songs.filter(song => song.heal > 0).map(song => ({...song, at:song.interval,
      buff:state.buffs.find(buff => buff.id === song.id)}));
    function record(text: string, kind = "system") {
      if (run !== 0) return;
      timelineCount++;
      if (timeline.length < 1000) timeline.push({at:state.time, text, hp:state.character.hp, kind});
    }
    if (options.counterattack) observeDamage(state, (id, damage) => {
      if (damage <= 0) return;
      const name = SKILLS.get(id)?.name ?? id;
      damageTaken += damage;
      received.set(name, (received.get(name) ?? 0) + damage);
      record(`${name} · 受到 ${damage} 傷害`, "incoming");
    });
    record(`對戰開始 · ${monster.name}`);
    let firstKill = false;
    let credited = 0;
    if (!panel) {
      const stats = derived(state);
      const target = effectiveMonster(monster, current.status);
      const defender = monsterDefender(target);
      panel = {
        element: stats.attackElement, interval: stats.attackIntervalMs, aspd: stats.aspd,
        hit: playerHitRate(stats, target), crit: playerCritRate(stats, target),
        modifier: elementModifier(stats.attackElement, target.element, target.elementLv),
        def: target.def, mdef: defender.mdef, elementTarget:target.element, elementLvTarget:target.elementLv, map: MAPS.get(state.mapId)?.name,
      };
    }
    for (let steps = 0; steps < 15000; steps++) {
      const pulse = pulses.find(entry => entry.buff && state.buffs.includes(entry.buff) && entry.at < entry.buff.until);
      const engineTime = nextEventTime(state);
      const next = Math.min(engineTime, pulse?.at ?? NEVER);
      if (next > duration || state.activity.kind === "stopped" || state.activity.kind === "dead") break;
      moveTime(state, Math.max(state.time, next));
      if (pulse && pulse.at < engineTime) {
        const healed = receiveHealing(state, pulse.heal);
        if (healed > 0) record(`${pulse.name} · HP +${healed}`);
        pulse.at += pulse.interval;
        continue;
      }
      if (options.unlimitedSp) state.character.sp = derived(state).maxSp;
      processAt(state, event => {
        if (event.type === "skillCast") {
          const entry = line(event.skill);
          entry.casts++;
          entry.castMs += event.castMs;
          entry.delayMs += event.delayMs ?? 0;
          const def = SKILLS.get(event.skill);
          entry.cooldownMs += atLv(def?.cooldownMs ?? [], event.lv) ?? 0;
          casts++;
          record(`角色開始施放 ${entry.name}（詠唱 ${event.castMs / 1000} 秒）`, "player");
        }
        if (event.type === "mobSkillCast") {
          record(`${MONSTERS.get(event.monsterId)?.name ?? "怪物"} 開始詠唱 ${SKILLS.get(event.skill)?.name ?? event.skill}（${event.castMs / 1000} 秒）`, "monster");
        }
        if (event.type === "mobSkill") {
          const name = MONSTERS.get(event.monsterId)?.name ?? "怪物";
          const skill = SKILLS.get(event.skill)?.name ?? event.skill;
          const outcome = event.result === "miss" ? "（未命中）" : event.heal ? `（回復 ${event.heal} HP）` : "";
          record(`${name} 使用 ${skill}${outcome}`, "monster");
        }
        if (event.type === "monsterAttack") {
          const name = MONSTERS.get(event.monsterId)?.name ?? "怪物";
          const outcome = event.damage > 0 ? "命中" : event.result === "blocked" ? "被擋下" : event.result === "miss" ? "未命中" : "未造成傷害";
          record(`${name} 普攻 · ${outcome}`, "monster");
        }
        if (event.type === "statusStart" || event.type === "statusEnd") {
          const name = MONSTERS.get(event.monsterId)?.name ?? "怪物";
          record(`${name} ${event.type === "statusStart" ? "受到" : "解除"} ${STATUS_NAMES[event.status] ?? event.status}`, "monster");
        }
        if (event.type === "monsterLeave") {
          record(`${MONSTERS.get(event.monsterId)?.name ?? "怪物"} 離開戰鬥`, "monster");
        }
        if (event.type === "buffStart" || event.type === "buffEnd") {
          record(`角色 ${buffDisplayName(event.buffId)} ${event.type === "buffStart" ? "生效" : "結束"}`);
        }
        if (event.type === "playerAttack" && event.uid === current.uid && !event.damage) {
          record(`角色普攻 · ${event.result === "miss" ? "未命中" : "未造成傷害"}`, "player");
        }
        if (event.type === "skillInterrupt") {
          record(`詠唱中斷 · ${SKILLS.get(event.skill)?.name ?? event.skill}`);
        }
        if (event.type === "ailmentStart") {
          record(`狀態 · ${AILMENT_NAMES[event.ailment] ?? event.ailment}`);
        }
        if (event.type === "useItem" && (event.hp > 0 || event.sp > 0)) {
          record(`使用 ${getItem(event.itemId).name} · HP +${event.hp}／SP +${event.sp}`);
        }
        if (event.type === "death") record("角色倒下");
        if ((event.type === "playerAttack" || event.type === "skillHit" || event.type === "homunAttack") &&
            event.uid === current.uid && event.damage > 0) {
          const entry = line(event.type === "playerAttack" ? "普攻" : event.type === "homunAttack" ? "生命體" : event.skill);
          const damage = Math.min(event.damage, Math.max(0, monster.hp - credited));
          credited += damage;
          entry.damage += damage;
          entry.hits++;
          record(`${entry.name} · ${event.result === "crit" ? "爆擊 " : ""}造成 ${damage} 傷害`, "player");
        }
      });
      if (options.unlimitedSp && state.character.hp > 0) state.character.sp = derived(state).maxSp;
      if (current.hp <= 0 && !state.monsters.includes(current)) {
        total += monster.hp;
        kills++;
        if (!firstKill) {
          killTimes.push(state.time);
          firstKill = true;
        }
        record(`擊倒 ${monster.name}`);
        if (state.character.hp <= 0) {
          current.hp = monster.hp;
          break;
        }
        current = replaceTarget(state, monster, options);
        record(`下一隻 ${monster.name} 進入戰鬥`, "monster");
        credited = 0;
      } else if (!state.monsters.includes(current) || current.monsterId !== monster.id) break;
      if (steps === 14999) throw new Error("模擬事件超過上限，請改用較短的試算時間。");
    }
    total += Math.max(0, monster.hp - current.hp);
    endingSp += state.character.sp;
    endingHp += Math.max(0, state.character.hp);
    if (state.activity.kind === "dead" || state.character.hp <= 0) deathTimes.push(state.time);
    timeExposed += state.activity.kind === "dead" || state.activity.kind === "stopped" || !state.monsters.includes(current)
      ? Math.min(duration, state.time) : duration;
  }
  const defense = options.counterattack ? {
    averageDamage: damageTaken / trials, damagePerSecond: timeExposed ? damageTaken * 1000 / timeExposed : 0,
    endingHp: endingHp / trials, deaths: deathTimes.length,
    averageDeath: deathTimes.length ? deathTimes.reduce((sum, time) => sum + time, 0) / deathTimes.length : null,
    received: [...received].map(([name, amount]) => ({name, average: amount / trials}))
      .sort((a, b) => b.average - a.average),
  } : null;
  return {monster: {name:monster.name, lv:monster.lv, hp:monster.hp, element:monster.element,
    elementLv:monster.elementLv, race:monster.race, size:monster.size}, panel,
    defense, songs, timeline, timelineCount, dps: total / trials / options.seconds,
    averageKill: killTimes.length ? killTimes.reduce((sum, t) => sum + t, 0) / killTimes.length : null,
    killedTrials: killTimes.length, kills, casts, endingSp:endingSp / trials, unlimitedSp:options.unlimitedSp ?? false, trials, seconds:options.seconds,
    lines: [...lines.values()].sort((a,b) => b.damage - a.damage)
      .map(entry => ({...entry, share:total ? entry.damage / total : 0})),
  };
}
