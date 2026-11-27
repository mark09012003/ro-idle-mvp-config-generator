// SPDX-License-Identifier: GPL-3.0-only
import { createGameState, type GameState, type ActiveMonster, type ActiveBuff } from "./src/game/sim/state";
import { autoEquipFor, derived, equipBagAmmo, monsterAttack, moveTime, nextEventTime, observeDamage, performMobSkill, processAt, receiveHealing, setDamageImmunity } from "./src/game/sim/engine";
import { SONGS, type PerformerCtx } from "./src/game/combat/songs";
import { defaultAutoConfig } from "./src/game/ai/config";
import { MONSTERS, type MonsterDef } from "./src/game/data/monsters";
import { MAPS } from "./src/game/data/maps";
import { JOBS } from "./src/game/data/jobs";
import { isUpper } from "./src/game/data/jobFamily";
import { SKILLS, atLv } from "./src/game/data/skills";
import { canAttackWithSkill } from "./src/game/combat/skillEffects";
import { cardfixPermille, monsterDefender, playerHitRate, playerCritRate } from "./src/game/combat/damage";
import { effectiveMonster, POISON_INTERVAL_MS, STATUS_NAMES, type MobStatusId, type MobStatuses } from "./src/game/combat/monsterStatus";
import { buffDisplayName, getBuff, isKnownBuff } from "./src/game/data/buffs";
import { elementModifier } from "./src/game/data/elements";
import { getItem, ITEMS, registerItemDefs } from "./src/game/data/items";
import { getAmmo, getEquipped, SLOT_NAMES } from "./src/game/items/equipment";
import { PETS, PET_INTIMATE, petOf } from "./src/game/data/pets";
import { AILMENT_NAMES, BLEEDING_TICK_MS } from "./src/game/combat/ailments";
import { randInt } from "./src/game/core/rng";
import { NEVER } from "./src/game/config/gameplay";
import type { GameSnapshot } from "./src/game/view";

export const targets = [...MONSTERS.values()].filter(monster => monster.hp > 0)
  .map(({id, name, lv, hp, element, elementLv, race, size, def, mdef, boss}) =>
    ({id, name, lv, hp, element, elementLv, race, size, def, mdef, boss: !!boss}));

const MONSTER_SKILL_NAMES = new Map<string, string>();
for (const mob of MONSTERS.values()) {
  for (const entry of mob.skills ?? []) {
    if (entry.skill && entry.name && !MONSTER_SKILL_NAMES.has(entry.skill)) {
      MONSTER_SKILL_NAMES.set(entry.skill, entry.name);
    }
  }
}

function skillDisplayName(id: string, monsterId?: number) {
  if (monsterId !== undefined) {
    const mobSkill = MONSTERS.get(monsterId)?.skills?.find(entry => entry.skill === id && entry.name);
    if (mobSkill?.name) return mobSkill.name;
  }
  return SKILLS.get(id)?.name ?? MONSTER_SKILL_NAMES.get(id) ?? id;
}

export function builderCatalog() {
  const jobs = Object.values(JOBS).map(job => {
    const from = job.jobChange?.from ?? null;
    const tier = !from ? 0 : job.id === "supernovice" ? 1 : (from === "novice" || from === "novice_high") ? 1 : 2;
    return {
      id: job.id,
      name: job.name,
      upper: isUpper(job.id),
      tier,
      maxJobLv: job.maxJobLv,
      from,
      rebirthOf: job.jobChange?.rebirthOf ? [...job.jobChange.rebirthOf] : null,
      skillTree: job.skillTree.map(entry => {
        const sk = SKILLS.get(entry.id);
        return {
          id: entry.id,
          name: sk?.name ?? entry.id,
          maxLv: entry.maxLv,
          requires: entry.requires ? {...entry.requires} : null,
          questJobLv: entry.questJobLv ?? null,
          minJobLv: entry.minJobLv ?? null,
          attack: canAttackWithSkill(entry.id),
          kind: sk?.kind ?? "passive",
          desc: sk?.desc ?? "",
        };
      }),
    };
  });
  const pets = PETS.map(p => ({
    mob: p.mob,
    egg: p.egg,
    name: p.name,
    gen: p.gen,
    loyalText: [...p.loyalText],
    loyalUnsupported: p.loyalUnsupported ? [...p.loyalUnsupported] : [],
    hasBonus: Object.keys(p.loyal).length > 0,
  }));
  return {
    jobs,
    pets,
    defaultConfig: defaultAutoConfig(),
  };
}

export function attackSkills(snapshot: GameSnapshot) {
  return Object.entries(snapshot.character.skills ?? {}).flatMap(([id, lv]) => {
    const skill = SKILLS.get(id);
    return skill && lv > 0 && canAttackWithSkill(id) ? [{id, name: skill.name, lv}] : [];
  });
}

const manualBuffIds = [
  "AL_BLESSING", "AL_INCAGI", "AL_ANGELUS", "AC_CONCENTRATION", "SN_SIGHT", "SN_WINDWALK",
  "PR_IMPOSITIO", "PR_SUFFRAGIUM", "PR_ASPERSIO", "PR_BENEDICTIO", "PR_GLORIA", "PR_MAGNIFICAT", "PR_KYRIE", "HP_ASSUMPTIO",
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
const previewBuffs = (snapshot: GameSnapshot) => snapshot.buffs ?? [];

function ammoChoices(snapshot: GameSnapshot) {
  const quantities = new Map<number, number>();
  const stacks = new Map(snapshot.inventory.map(item => [item.uid, item]));
  const configured = new Set<number>();
  for (const rule of snapshot.config.equipRules ?? []) {
    if (rule.enabled === false) continue;
    const id = (rule.ammo != null ? stacks.get(rule.ammo)?.itemId : undefined) ?? rule.ammoId;
    if (id) configured.add(id);
  }
  for (const item of snapshot.inventory) {
    if (item.qty > 0) quantities.set(item.itemId, (quantities.get(item.itemId) ?? 0) + item.qty);
  }
  return [...ITEMS.values()].flatMap(def => def.category === "ammo" ? [{
    id:def.id, name:def.name, element:def.element,
    quantity:quantities.get(def.id) ?? 0, configured:configured.has(def.id),
  }] : []).sort((a,b) => Number(b.quantity > 0) - Number(a.quantity > 0) ||
    Number(b.configured) - Number(a.configured) || a.id - b.id);
}

export function scenarioCatalog(snapshot: GameSnapshot) {
  registerItemDefs(snapshot.heldItems ?? []);
  return {
    ammo: ammoChoices(snapshot),
    active: previewBuffs(snapshot).map((buff, index) => ({
      index, id: buff.id, name: buffDisplayName(buff.id), level: "lv" in buff ? buff.lv : undefined,
      remainingMs: "remainingMs" in buff ? Number(buff.remainingMs) : undefined,
      group: buffGroup({...buff, until: NEVER} as ActiveBuff),
    })),
    buffs: [...manualBuffIds, ...songIds].map(id => ({
      id, name:buffDisplayName(id), max:maximumBuffLevel(id),
      group: buffGroup({id, lv: maximumBuffLevel(id), until: NEVER} as ActiveBuff),
      ...(songIds.includes(id) && {stats:songStats[id], lessonName:id.startsWith("DC_") ? "練習舞蹈等級" : "操控樂器等級"}),
    })),
    statuses: Object.entries(manualStatuses).map(([id, max]) => ({id, name:STATUS_NAMES[id as MobStatusId], max})),
  };
}

const EDITABLE_SLOTS = [
  "headTop", "headMid", "headLow", "weapon", "shield",
  "armor", "garment", "shoes", "accessory1", "accessory2",
] as const;
type EditableSlot = typeof EDITABLE_SLOTS[number];
const HEAD_SLOTS: readonly EditableSlot[] = ["headTop", "headMid", "headLow"];
const TWO_HANDED_WEAPON_TYPES = new Set(["2hSword", "2hSpear", "2hAxe", "2hMace", "2hStaff", "bow", "katar"]);

type EquipOverride = {itemId: number | null; refine?: number; cards?: number[]};
type EquipOverrides = Partial<Record<EditableSlot, EquipOverride>>;

export function equipmentCatalog(snapshot: GameSnapshot) {
  registerItemDefs(snapshot.heldItems ?? []);
  const job = snapshot.character.job;
  const baseLv = snapshot.character.baseLv;
  const canDualWield = job === "assassin" || job === "assassin_cross" || (snapshot.character.skills?.AS_LEFT ?? 0) > 0;
  const stackByUid = new Map(snapshot.inventory.map(item => [item.uid, item]));
  const equipped = Object.fromEntries(EDITABLE_SLOTS.map(slot => {
    const uid = snapshot.equipment[slot];
    const stack = uid !== undefined ? stackByUid.get(uid) : undefined;
    const def = stack ? ITEMS.get(stack.itemId) : undefined;
    if (!stack || def?.category !== "equipment") return [slot, null];
    return [slot, {
      itemId: stack.itemId,
      refine: stack.refine ?? 0,
      cards: (stack.cards ?? []).filter((id): id is number => typeof id === "number" && id > 0),
      broken: !!stack.broken,
    }];
  })) as Record<EditableSlot, {itemId: number; refine: number; cards: number[]; broken: boolean} | null>;
  const owned = snapshot.inventory.flatMap(stack => {
    const def = ITEMS.get(stack.itemId);
    if (def?.category !== "equipment") return [];
    return [{
      uid: stack.uid,
      itemId: stack.itemId,
      refine: stack.refine ?? 0,
      cards: (stack.cards ?? []).filter((id): id is number => typeof id === "number" && id > 0),
      broken: !!stack.broken,
    }];
  });
  const items = [...ITEMS.values()].flatMap(def => {
    if (def.category !== "equipment") return [];
    const jobMatch = def.jobs === "all" || def.jobs.includes(job);
    const equippable = baseLv >= def.equipLevel && jobMatch;
    return [{
      id: def.id,
      name: def.name,
      slots: [...def.slots],
      weaponType: def.weaponType ?? null,
      weaponLevel: def.weaponLevel ?? null,
      atk: def.atk ?? 0,
      def: def.def ?? 0,
      equipLevel: def.equipLevel ?? 0,
      equippable,
      jobMatch,
      cardSlots: def.cardSlots ?? 0,
      refineable: !!def.refineable,
      desc: def.desc ?? "",
    }];
  }).sort((a, b) => Number(b.equippable) - Number(a.equippable) || a.id - b.id);
  const cards = [...ITEMS.values()].flatMap(def => {
    if (def.category !== "card") return [];
    return [{
      id: def.id,
      name: def.name,
      slotType: def.slotType,
      desc: def.desc ?? "",
    }];
  }).sort((a, b) => a.id - b.id);
  return {
    slots: EDITABLE_SLOTS.map(id => ({id, name: SLOT_NAMES[id]})),
    job,
    baseLv,
    canDualWield,
    equipped,
    owned,
    items,
    cards,
  };
}

type Effect = {id: string; level: number; seconds: number; performer?: Partial<PerformerCtx["stats"]> & {lesson?: number}};
type Scenario = {includeActive?: number[]; keepActiveBuffs?: boolean; buffs?: Effect[]; statuses?: Effect[]; autoBuffs?: boolean; ammoItemId?: number; equipOverrides?: EquipOverrides};

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
  if (active.id === "BS_OVERTHRUST" || active.id === "WS_OVERTHRUSTMAX") return "overthrust";
  if (active.id === "PR_KYRIE" || active.id === "HP_ASSUMPTIO") return "kyrie-assumptio";
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
    if (Number.isFinite(remaining) && remaining > 0) {
      add({...structuredClone(buff), until: scenario.keepActiveBuffs ? NEVER : remaining});
    }
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

type Options = {monsterId: number; mode: "normal" | "skill" | "auto"; skill?: string; level?: number; seconds: number; counterattack?: boolean; invincible?: boolean; unlimitedSp?: boolean; scenario?: Scenario};
type HitRange = {min: number; max: number; count: number};
type DamageLine = {normal?: HitRange; critical?: HitRange; name: string; damage: number; hits: number; casts: number; castMs: number; delayMs: number; cooldownMs: number};

function applyEquipOverrides(state: GameState, snapshot: GameSnapshot, overrides?: EquipOverrides): Set<EditableSlot> {
  const lockedSlots = new Set<EditableSlot>();
  if (!overrides) return lockedSlots;
  const entries = EDITABLE_SLOTS.filter(slot => Object.prototype.hasOwnProperty.call(overrides, slot));
  if (!entries.length) return lockedSlots;
  const stackByUid = new Map(snapshot.inventory.map(item => [item.uid, item]));
  for (const slot of entries) {
    const patch = overrides[slot];
    if (!patch) continue;
    lockedSlots.add(slot);
    if (patch.itemId === null) {
      delete state.equipment[slot];
      continue;
    }
    const def = ITEMS.get(patch.itemId);
    if (!def || def.category !== "equipment") {
      throw new Error(`指定的裝備 #${patch.itemId} 不存在或無法裝備。`);
    }
    if (HEAD_SLOTS.includes(slot)) {
      for (const other of HEAD_SLOTS) {
        if (other === slot) continue;
        const otherUid = state.equipment[other];
        if (otherUid === undefined) continue;
        const otherStack = state.inventory.items.find(item => item.uid === otherUid);
        const otherDef = otherStack ? ITEMS.get(otherStack.itemId) : undefined;
        if (otherDef?.category === "equipment" && otherDef.slots.some(s => def.slots.includes(s))) {
          delete state.equipment[other];
          lockedSlots.add(other);
        }
      }
    }
    if (slot === "weapon" && def.weaponType && TWO_HANDED_WEAPON_TYPES.has(def.weaponType)) {
      delete state.equipment.shield;
      lockedSlots.add("shield");
    }
    if (slot === "shield" && state.equipment.weapon !== undefined) {
      const wStack = state.inventory.items.find(item => item.uid === state.equipment.weapon);
      const wDef = wStack ? ITEMS.get(wStack.itemId) : undefined;
      if (wDef?.category === "equipment" && wDef.weaponType && TWO_HANDED_WEAPON_TYPES.has(wDef.weaponType)) {
        delete state.equipment.weapon;
        lockedSlots.add("weapon");
      }
    }
    const maxCards = def.cardSlots ?? 0;
    const refine = def.refineable ? Math.max(0, Math.min(10, Math.trunc(patch.refine ?? 0))) : 0;
    const cards = (patch.cards ?? [])
      .filter((id): id is number => Number.isInteger(id) && id > 0 && ITEMS.get(id)?.category === "card")
      .slice(0, maxCards);
    const originalUid = snapshot.equipment[slot];
    const originalStack = originalUid !== undefined ? stackByUid.get(originalUid) : undefined;
    const forged = originalStack && originalStack.itemId === patch.itemId && originalStack.forged
      ? structuredClone(originalStack.forged)
      : undefined;
    const uid = state.inventory.nextUid++;
    state.inventory.items.push({
      uid,
      itemId: patch.itemId,
      qty: 1,
      ...(refine > 0 ? {refine} : {}),
      ...(cards.length > 0 ? {cards} : {}),
      ...(forged ? {forged} : {}),
    });
    state.equipment[slot] = uid;
  }
  return lockedSlots;
}

function setup(snapshot: GameSnapshot, options: Options, seed: number) {
  const state = createGameState(snapshot.character.name, seed, {exp:0, drop:0});
  state.character = structuredClone(snapshot.character);
  state.inventory = {items: structuredClone(snapshot.inventory),
    nextUid: Math.max(0, ...snapshot.inventory.map(item => item.uid)) + 1};
  state.equipment = {...snapshot.equipment};
  const lockedSlots = applyEquipOverrides(state, snapshot, options.scenario?.equipOverrides);
  state.buffs = initialBuffs(snapshot, options.scenario);
  state.ailments = Object.fromEntries((snapshot.ailments ?? []).map(ailment =>
    [ailment.id, {until: ailment.remainingMs, lv: ailment.lv ?? 1}]));
  if (snapshot.cart) state.cart = {items: [], nextUid: 1};
  if (snapshot.pet?.mob) {
    const petDef = petOf(snapshot.pet.mob);
    if (petDef) {
      state.pet = {
        mob: snapshot.pet.mob,
        egg: snapshot.pet.egg ?? petDef.egg,
        intimacy: snapshot.pet.intimacy ?? PET_INTIMATE.max,
        hunger: snapshot.pet.hunger ?? 100,
        nextHungerAt: NEVER,
        ...(snapshot.pet.name ? {name: snapshot.pet.name} : {}),
        ...(snapshot.pet.equip ? {equip: snapshot.pet.equip} : {}),
      };
    }
  }
  const config = defaultAutoConfig();
  const loaded = snapshot.config;
  const chosenAmmo = options.scenario?.ammoItemId;
  if (chosenAmmo !== undefined) {
    const stack = state.inventory.items.filter(item => item.itemId === chosenAmmo && item.qty > 0)
      .sort((a, b) => b.qty - a.qty || a.uid - b.uid)[0];
    if (ITEMS.get(chosenAmmo)?.category !== "ammo") throw new Error("指定的道具不是箭矢。");
    if (stack) state.equipment.ammo = stack.uid;
    else {
      const uid = state.inventory.nextUid++;
      state.inventory.items.push({uid, itemId:chosenAmmo, qty:1000});
      state.equipment.ammo = uid;
    }
  }
  const map = [snapshot.mapId, loaded.lockMap, config.lockMap].find(id => MAPS.get(id)?.type !== "town" && MAPS.has(id))!;
  state.mapId = map;
  state.saveMap = map;
  state.entitlement.noIncome = true;
  state.config = {
    ...config,
    lockMap: map,
    autoLoot: false,
    stopOnOverweight: false,
    autoBuy: {
      ...config.autoBuy, enabled:false,
      arrows: {...config.autoBuy.arrows, itemId:chosenAmmo ?? loaded.autoBuy?.arrows?.itemId ?? config.autoBuy.arrows.itemId},
      quivers: loaded.autoBuy?.quivers ?? [],
      quiverBelow: loaded.autoBuy?.quiverBelow ?? 0,
    },
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
    state.config.equipRules = structuredClone(loaded.equipRules ?? []).flatMap(rule => {
      if (chosenAmmo !== undefined) {
        delete rule.ammo;
        delete rule.ammoId;
      } else if (rule.ammo === undefined && rule.ammoId !== undefined) {
        rule.ammo = state.inventory.items.find(item => item.itemId === rule.ammoId && item.qty > 0)?.uid;
      }
      if (lockedSlots.has("weapon")) delete rule.weapon;
      if (lockedSlots.has("shield")) delete rule.shield;
      if (lockedSlots.size > 0 && rule.gear?.length) {
        rule.gear = rule.gear.filter(uid => {
          const stack = state.inventory.items.find(item => item.uid === uid);
          const def = stack ? ITEMS.get(stack.itemId) : undefined;
          if (!def || def.category !== "equipment") return false;
          return !def.slots.some(s => lockedSlots.has(s as EditableSlot));
        });
        if (!rule.gear.length) delete rule.gear;
      }
      return rule.weapon !== undefined || rule.shield !== undefined || rule.ammo !== undefined || rule.gear?.length ? [rule] : [];
    });
    state.config.combat = loaded.combat ?? config.combat;
  } else if (options.mode === "skill") {
    const selected = attackSkills(snapshot).find(skill => skill.id === options.skill);
    if (!selected || !Number.isInteger(options.level) || options.level! < 1 || options.level! > selected.lv) {
      throw new Error("請選擇角色已學會的攻擊技能和等級。");
    }
    state.config.skills = buildSkillModeConfig(state, selected.id, options.level!);
  }
  const stats = derived(state);
  state.character.hp = Math.min(state.character.hp, stats.maxHp);
  state.character.sp = options.unlimitedSp ? stats.maxSp : Math.min(state.character.sp, stats.maxSp);
  return state;
}

const MONK_COMBO_CHAIN = ["MO_CHAINCOMBO", "MO_COMBOFINISH", "CH_TIGERFIST", "CH_CHAINCRUSH"] as const;
const SPHERE_ATTACK_SKILLS = new Set([
  "MO_FINGEROFFENSIVE", "MO_INVESTIGATE", "MO_COMBOFINISH",
  "CH_TIGERFIST", "CH_CHAINCRUSH", "MO_EXTREMITYFIST", "CH_PALMSTRIKE",
]);
const EXPLOSION_ATTACK_SKILLS = new Set(["MO_EXTREMITYFIST", "CH_PALMSTRIKE"]);
const HIDING_ATTACK_SKILLS = new Set(["AS_GRIMTOOTH", "RG_RAID"]);

function buildSkillModeConfig(state: GameState, selectedId: string, selectedLv: number) {
  const learned = state.character.skills ?? {};
  const list: {skill: string; lv: number; use: "attack" | "buff"; percent: number}[] = [];
  const added = new Set<string>();
  const pushSkill = (id: string, lv: number, use: "attack" | "buff") => {
    if (lv <= 0 || added.has(id)) return;
    added.add(id);
    list.push({skill: id, lv, use, percent: 0});
  };

  const attackList: {id: string; lv: number}[] = [];
  const comboIdx = MONK_COMBO_CHAIN.indexOf(selectedId as typeof MONK_COMBO_CHAIN[number]);
  if (comboIdx >= 0) {
    attackList.push({id: selectedId, lv: selectedLv});
    for (let i = comboIdx - 1; i >= 0; i--) {
      const prevId = MONK_COMBO_CHAIN[i];
      const prevLv = learned[prevId] ?? 0;
      if (prevLv > 0) attackList.push({id: prevId, lv: prevLv});
    }
  } else {
    attackList.push({id: selectedId, lv: selectedLv});
  }

  const needsExplosion = attackList.some(a => EXPLOSION_ATTACK_SKILLS.has(a.id));
  const needsSpheres = needsExplosion || attackList.some(a => SPHERE_ATTACK_SKILLS.has(a.id));
  const needsCartBoost = selectedId === "WS_CARTTERMINATION";
  const needsCart = needsCartBoost || selectedId === "MC_CARTREVOLUTION";
  const needsHiding = HIDING_ATTACK_SKILLS.has(selectedId);

  if (needsCart && !state.cart) {
    state.cart = {items: [], nextUid: 1};
  }
  if (needsSpheres) {
    if ((learned.CH_SOULCOLLECT ?? 0) > 0) pushSkill("CH_SOULCOLLECT", learned.CH_SOULCOLLECT, "buff");
    else if ((learned.MO_CALLSPIRITS ?? 0) > 0) pushSkill("MO_CALLSPIRITS", learned.MO_CALLSPIRITS, "buff");
  }
  if (needsExplosion && (learned.MO_EXPLOSIONSPIRITS ?? 0) > 0) {
    pushSkill("MO_EXPLOSIONSPIRITS", learned.MO_EXPLOSIONSPIRITS, "buff");
  }
  if (needsCartBoost && (learned.WS_CARTBOOST ?? 0) > 0) {
    pushSkill("WS_CARTBOOST", learned.WS_CARTBOOST, "buff");
  }
  if (needsHiding && (learned.TF_HIDING ?? 0) > 0) {
    pushSkill("TF_HIDING", learned.TF_HIDING, "buff");
  }

  for (const a of attackList) {
    pushSkill(a.id, a.lv, "attack");
  }
  return list;
}

const NON_OFFENSIVE_MOB_SKILLS = new Set([
  "NPC_EMOTION", "NPC_EMOTION_ON", "NPC_RANDOMMOVE", "NPC_RUN", "AL_TELEPORT",
  "NPC_SUMMONSLAVE", "NPC_CALLSLAVE", "NPC_SUMMONMONSTER", "NPC_ALLHEAL", "AL_HEAL",
  "NPC_METAMORPHOSIS", "NPC_POWERUP", "NPC_AGIUP", "NPC_KEEPING", "NPC_DEFENDER",
  "NPC_MAGICMIRROR", "NPC_STONESKIN", "HP_ASSUMPTIO", "CR_REFLECTSHIELD", "CR_AUTOGUARD",
  "NPC_INVISIBLE", "TF_HIDING", "AS_CLOAKING", "NPC_REBIRTH", "NPC_ATTRICHANGE",
  "NPC_CHANGEFIRE", "NPC_CHANGEGROUND", "NPC_CHANGEHOLY", "NPC_CHANGETELEKINESIS",
  "NPC_CHANGEUNDEAD", "NPC_CHANGEWATER", "NPC_CHANGEWIND", "NPC_SMOKING", "NPC_SPEEDUP",
  "NPC_BARRIER", "PR_LEXAETERNA", "SM_ENDURE", "KN_TWOHANDQUICKEN", "MG_ENERGYCOAT",
  "CR_DEFENDER", "AL_INCAGI", "AL_BLESSING", "AL_ANGELUS", "PR_KYRIE", "PR_SANCTUARY",
  "WZ_SIGHTRASHER", "MG_SIGHT", "AL_RUWACH", "AL_PNEUMA", "MG_SAFETYWALL",
]);

export function monsterSkills(monsterId: number) {
  const mob = MONSTERS.get(monsterId);
  if (!mob) return [];
  const result: {key: string; skill: string; name: string; lv: number; element?: string}[] = [
    {key: "__normal__", skill: "__normal__", name: "怪物普攻", lv: 1, element: mob.element},
  ];
  const seen = new Set<string>();
  for (const entry of mob.skills ?? []) {
    if (!entry.skill || NON_OFFENSIVE_MOB_SKILLS.has(entry.skill)) continue;
    if (entry.target === "self" && entry.skill !== "NPC_SELFDESTRUCTION" && entry.skill !== "NPC_EARTHQUAKE" && entry.skill !== "NPC_PULSESTRIKE") continue;
    const key = `${entry.skill}@${entry.lv}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      key,
      skill: entry.skill,
      name: skillDisplayName(entry.skill, monsterId),
      lv: entry.lv,
      element: entry.element,
    });
  }
  return result;
}

export function testMonsterSkill(
  snapshot: GameSnapshot,
  options: {monsterId: number; skill: string; lv?: number; mode?: Options["mode"]; scenario?: Scenario; samples?: number}
) {
  const monster = MONSTERS.get(options.monsterId);
  if (!monster) throw new Error("請先選擇有效怪物。");
  registerItemDefs(snapshot.heldItems ?? []);
  const samples = Math.max(20, Math.min(400, options.samples ?? 200));
  const isNormal = options.skill === "__normal__";
  const skillEntry = isNormal
    ? null
    : (monster.skills ?? []).find(e => e.skill === options.skill && (options.lv == null || e.lv === options.lv))
      ?? (monster.skills ?? []).find(e => e.skill === options.skill);
  if (!isNormal && !skillEntry) throw new Error("此怪物沒有該技能。");

  let maxHp = 1;
  let hits = 0, misses = 0, blocked = 0, lethalCount = 0;
  let totalDamage = 0, hitDamageSum = 0;
  let minHit = Infinity, maxHit = 0;
  const ailments = new Map<string, number>();
  const sampleRolls: number[] = [];

  for (let i = 0; i < samples; i++) {
    const simOpts: Options = {
      monsterId: options.monsterId,
      mode: options.mode === "auto" ? "auto" : "normal",
      seconds: 30,
      counterattack: true,
      invincible: true,
      scenario: options.scenario,
    };
    const state = setup(snapshot, simOpts, 71001 + 3571 * i);
    setDamageImmunity(state);
    prepareEncounter(state, simOpts);
    const d = derived(state);
    if (i === 0) maxHp = d.maxHp;
    state.character.hp = d.maxHp;
    const mob = state.monsters[0];
    let trialDamage = 0;
    let trialResult: string | null = null;
    observeDamage(state, (_src, dmg) => {
      if (dmg > 0) trialDamage += dmg;
    });
    const emit = (ev: {type: string; result?: string; ailment?: string}) => {
      if ((ev.type === "monsterAttack" || ev.type === "mobSkill") && ev.result) {
        trialResult = ev.result;
      }
      if (ev.type === "ailmentStart" && ev.ailment) {
        const label = AILMENT_NAMES[ev.ailment as keyof typeof AILMENT_NAMES] ?? ev.ailment;
        ailments.set(label, (ailments.get(label) ?? 0) + 1);
      }
    };
    if (isNormal) {
      monsterAttack(state, mob, emit);
    } else {
      performMobSkill(state, mob, skillEntry!, emit);
    }
    if (trialDamage > 0) {
      hits++;
      hitDamageSum += trialDamage;
      totalDamage += trialDamage;
      if (trialDamage < minHit) minHit = trialDamage;
      if (trialDamage > maxHit) maxHit = trialDamage;
      if (trialDamage >= d.maxHp) lethalCount++;
    } else if (trialResult === "blocked") {
      blocked++;
    } else {
      misses++;
    }
    if (sampleRolls.length < 10) sampleRolls.push(trialDamage);
  }

  return {
    monsterName: monster.name,
    skill: options.skill,
    skillName: isNormal ? "怪物普攻" : skillDisplayName(options.skill, options.monsterId),
    lv: isNormal ? 1 : skillEntry!.lv,
    samples,
    maxHp,
    hits,
    misses,
    blocked,
    hitRate: (hits / samples) * 100,
    missRate: (misses / samples) * 100,
    blockRate: (blocked / samples) * 100,
    min: hits ? minHit : 0,
    max: hits ? maxHit : 0,
    avgHit: hits ? hitDamageSum / hits : 0,
    avgAll: totalDamage / samples,
    lethalCount,
    lethalRate: (lethalCount / samples) * 100,
    ailments: [...ailments.entries()].map(([name, count]) => ({name, rate: (count / samples) * 100}))
      .sort((a, b) => b.rate - a.rate),
    sampleRolls,
  };
}

export function previewCharacter(snapshot: GameSnapshot, scenario?: Scenario, mode: Options["mode"] = "normal", monsterId = 0) {
  registerItemDefs(snapshot.heldItems ?? []);
  const options: Options = {monsterId, mode:mode === "auto" ? "auto" : "normal", seconds:30};
  function panel(state: GameState) {
    const stats = derived(state);
    return {
      ...Object.fromEntries(Object.entries(stats.total).map(([key, value]) => [key.toUpperCase(), value])),
      "最大 HP":stats.maxHp, "最大 SP":stats.maxSp,
      "前 ATK":stats.statusAtk,
      "後 ATK":stats.weaponAtk + stats.atkBonus + stats.refineAtk,
      "精煉 ATK":stats.refineAtk,
      ASPD:stats.aspd, HIT:stats.hit, FLEE:stats.flee,
      CRIT:stats.crit, DEF:stats.hardDefShown, MDEF:stats.hardMdef,
      "MATK 下限":stats.matkMin, "MATK 上限":stats.matkMax,
    };
  }
  const hasEquipOverrides = !!scenario?.equipOverrides && Object.keys(scenario.equipOverrides).length > 0;
  const current = setup(snapshot, {...options, scenario}, 1);
  const baseline = setup(snapshot, {...options, scenario:{ammoItemId:scenario?.ammoItemId}}, 1);
  const modifier = prepareEncounter(current, {...options, scenario});
  prepareEncounter(baseline, {...options, scenario:{statuses:scenario?.statuses}});
  const base = panel(baseline);
  const equipment = getEquipped(current.inventory, current.equipment).map(({slot, stack, def}) => ({
    slot:SLOT_NAMES[slot], name:def.name, refine:stack.refine ?? 0, broken:!!stack.broken,
    cards:(stack.cards ?? []).filter(Boolean).map(id => ITEMS.get(id)?.name ?? `#${id}`),
  }));
  const ammo = getAmmo(current.inventory, current.equipment);
  const stats = derived(current);
  const rule = current.config.equipRules?.[current.ai.autoEquipIdx ?? -1];
  const ruleAmmoId = rule?.ammoId ?? (rule?.ammo == null ? undefined : snapshot.inventory.find(item => item.uid === rule.ammo)?.itemId);
  const missingRuleAmmo = ruleAmmoId && !current.inventory.items.some(item => item.itemId === ruleAmmoId && item.qty > 0)
    ? ITEMS.get(ruleAmmoId)?.name ?? `#${ruleAmmoId}`
    : !ammo && rule?.ammo != null ? `UID ${rule.ammo}` : undefined;
  const allocated = Object.fromEntries(Object.entries(baseline.character.stats)
    .map(([key, value]) => [key.toUpperCase(), value]));
  const petDef = current.pet ? petOf(current.pet.mob) : undefined;
  const activePet = current.pet && petDef ? {
    mob: current.pet.mob,
    name: current.pet.name || petDef.name,
    species: petDef.name,
    loyal: current.pet.intimacy >= PET_INTIMATE.loyal,
    loyalText: [...petDef.loyalText],
  } : null;
  return {
    base, current:current.buffs.length || hasEquipOverrides ? panel(current) : null, hasEquipOverrides,
    pet: activePet,
    atkDetail: {
      statusAtk: stats.statusAtk,
      weaponAtk: stats.weaponAtk,
      atkBonus: stats.atkBonus,
      refineAtk: stats.refineAtk,
      overrefine: stats.overrefine,
      arrowAtk: stats.arrowAtk,
      masteryAtk: stats.passive.masteryAtk,
    },
    names:current.buffs.map(buff => buffDisplayName(buff.id)), allocated, equipment,
    weaponType:stats.weaponType, attackElement:stats.attackElement, missingRuleAmmo,
    ammo:ammo ? {name:ammo.def.name, atk:ammo.def.atk, element:ammo.def.element, quantity:ammo.stack.qty,
      fromBag:ammo.stack.uid !== snapshot.equipment.ammo, manual:scenario?.ammoItemId !== undefined,
      simulated:!snapshot.inventory.some(item => item.uid === ammo.stack.uid),
      fromRule:modifier === "rule"} : null,
  };
}

function replaceTarget(state: GameState, target: MonsterDef, options: Options): ActiveMonster {
  const counterattack = !!(options.counterattack || options.invincible);
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

function prepareEncounter(state: GameState, options: Options) {
  const target = MONSTERS.get(options.monsterId);
  const before = state.equipment.ammo;
  if (target) {
    const monster = replaceTarget(state, target, options);
    if (options.mode === "auto") autoEquipFor(state, () => {}, monster);
  }
  if (before !== state.equipment.ammo && getAmmo(state.inventory, state.equipment)) return "rule";
  const weaponType = derived(state).weaponType;
  if (["bow", "instrument", "whip"].includes(weaponType) && !getAmmo(state.inventory, state.equipment)) {
    equipBagAmmo(state, () => {});
  }
  return null;
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
    if (!lines.has(id)) lines.set(id, {name: skillDisplayName(id), damage:0, hits:0, casts:0, castMs:0, delayMs:0, cooldownMs:0});
    return lines.get(id)!;
  };
  function noteHit(entry: DamageLine, critical: boolean, raw: number) {
    const slot = critical ? "critical" : "normal";
    const range = entry[slot];
    if (!range) entry[slot] = {min:raw, max:raw, count:1};
    else {
      range.min = Math.min(range.min, raw);
      range.max = Math.max(range.max, raw);
      range.count++;
    }
  }
  let total = 0, kills = 0, casts = 0, endingSp = 0;
  let summonCount = 0, summonKills = 0, summonDamage = 0;
  const counterattack = !!(options.counterattack || options.invincible);
  const killTimes: number[] = [];
  const deathTimes: number[] = [];
  const timeline: {at: number; text: string; hp: number; kind: string}[] = [];
  let timelineCount = 0;
  const received = new Map<string, number>();
  let damageTaken = 0, timeExposed = 0, endingHp = 0;
  let panel;
  for (let run = 0; run < trials; run++) {
    const state = setup(snapshot, options, 91237 + 7919 * run);
    if (options.invincible) setDamageImmunity(state);
    prepareEncounter(state, options);
    let current = state.monsters[0];
    const pulses = songs.filter(song => song.heal > 0).map(song => ({...song, at:song.interval,
      buff:state.buffs.find(buff => buff.id === song.id)}));
    function record(text: string, kind = "system") {
      if (run !== 0) return;
      timelineCount++;
      if (timeline.length < 1000) timeline.push({at:state.time, text, hp:state.character.hp, kind});
    }
    const summonHp = new Map<number, number>();
    if (counterattack) observeDamage(state, (id, damage) => {
      if (damage <= 0) return;
      const name = skillDisplayName(id);
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
        cardRate:cardfixPermille(stats, target) / 1000,
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
          record(`${MONSTERS.get(event.monsterId)?.name ?? "怪物"} 開始詠唱 ${skillDisplayName(event.skill, event.monsterId)}（${event.castMs / 1000} 秒）`, "monster");
        }
        if (event.type === "mobSkill") {
          const name = MONSTERS.get(event.monsterId)?.name ?? "怪物";
          const skill = skillDisplayName(event.skill, event.monsterId);
          const outcome = event.result === "miss" ? "（未命中）" : event.heal ? `（回復 ${event.heal} HP）` : "";
          record(`${name} 使用 ${skill}${outcome}`, "monster");
          if (event.summoned?.length) {
            summonCount += event.summoned.length;
            const names = event.summoned.map(id => MONSTERS.get(id)?.name ?? `#${id}`);
            record(`${name} 召喚 ${names.join("、")}`, "monster");
            for (const minion of state.monsters) {
              if (minion.masterUid !== undefined && !summonHp.has(minion.uid)) summonHp.set(minion.uid, minion.hp);
            }
          }
        }
        if (event.type === "monsterAttack") {
          const name = MONSTERS.get(event.monsterId)?.name ?? "怪物";
          const outcome = event.damage > 0 ? "命中" : event.result === "blocked" ? "被擋下" : event.result === "miss" ? "未命中" : options.invincible ? "未扣 HP" : "未造成傷害";
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
          record(`詠唱中斷 · ${skillDisplayName(event.skill)}`);
        }
        if (event.type === "ailmentStart") {
          record(`狀態 · ${AILMENT_NAMES[event.ailment] ?? event.ailment}`);
        }
        if (event.type === "useItem" && (event.hp > 0 || event.sp > 0)) {
          record(`使用 ${getItem(event.itemId).name} · HP +${event.hp}／SP +${event.sp}`);
        }
        if (event.type === "death") record("角色倒下");
        if ((event.type === "playerAttack" || event.type === "skillHit" || event.type === "homunAttack") &&
            event.damage > 0) {
          const entry = line(event.type === "playerAttack" ? "普攻" : event.type === "homunAttack" ? "生命體" : event.skill);
          if (event.uid === current.uid) {
            const damage = Math.min(event.damage, Math.max(0, monster.hp - credited));
            const critical = event.result === "crit" || ("crit" in event && event.crit === true);
            noteHit(entry, critical, event.damage);
            credited += damage;
            entry.damage += damage;
            entry.hits++;
            const effective = damage < event.damage ? `（有效 ${damage}）` : "";
            record(`${entry.name} · ${critical ? "爆擊 " : ""}造成 ${event.damage} 傷害${effective}`, "player");
          } else {
            const prior = summonHp.get(event.uid);
            if (prior === undefined) return;
            const hpLeft = Math.max(0, event.hpLeft);
            const damage = hpLeft > 0 ? event.damage : Math.min(event.damage, prior);
            summonDamage += damage;
            summonHp.set(event.uid, hpLeft);
            record(`${entry.name} 命中召喚物 ${MONSTERS.get(event.monsterId)?.name ?? "小怪"} · ${damage} 傷害`, "player");
          }
        }
        if (event.type === "kill" && event.uid !== current.uid && summonHp.has(event.uid)) {
          summonKills++;
          summonHp.delete(event.uid);
          record(`擊倒召喚物 ${MONSTERS.get(event.monsterId)?.name ?? "小怪"}`, "player");
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
        summonHp.clear();
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
  const defense = counterattack ? {
    averageDamage: damageTaken / trials, damagePerSecond: timeExposed ? damageTaken * 1000 / timeExposed : 0,
    endingHp: endingHp / trials, deaths: deathTimes.length,
    averageDeath: deathTimes.length ? deathTimes.reduce((sum, time) => sum + time, 0) / deathTimes.length : null,
    received: [...received].map(([name, amount]) => ({name, average: amount / trials}))
      .sort((a, b) => b.average - a.average),
  } : null;
  return {monster: {name:monster.name, lv:monster.lv, hp:monster.hp, element:monster.element,
    elementLv:monster.elementLv, race:monster.race, size:monster.size}, panel,
    defense, songs, timeline, timelineCount, invincible:!!options.invincible, dps: total / trials / options.seconds,
    summons: {count:summonCount, kills:summonKills, dps:summonDamage / trials / options.seconds,
      totalDps:(total + summonDamage) / trials / options.seconds},
    averageKill: killTimes.length ? killTimes.reduce((sum, t) => sum + t, 0) / killTimes.length : null,
    killedTrials: killTimes.length, kills, casts, endingSp:endingSp / trials, unlimitedSp:options.unlimitedSp ?? false, trials, seconds:options.seconds,
    lines: [...lines.values()].sort((a,b) => b.damage - a.damage)
      .map(entry => ({...entry, share:total ? entry.damage / total : 0})),
  };
}
