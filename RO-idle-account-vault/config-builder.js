(() => {
  "use strict";

  const rebirthJobCodes = new Map([
    ["novice_high", "novice"],
    ["swordman_high", "swordman"],
    ["mage_high", "mage"],
    ["archer_high", "archer"],
    ["acolyte_high", "acolyte"],
    ["thief_high", "thief"],
    ["merchant_high", "merchant"],
    ["lord_knight", "knight"],
    ["high_wizard", "wizard"],
    ["sniper", "hunter"],
    ["assassin_cross", "assassin"],
    ["high_priest", "priest"],
    ["whitesmith", "blacksmith"],
    ["paladin", "crusader"],
    ["champion", "monk"],
    ["stalker", "rogue"],
    ["professor", "sage"],
    ["clown", "bard"],
    ["gypsy", "dancer"],
    ["creator", "alchemist"],
  ]);

  function validateBase(base) {
    if (base?.format !== "ro-idle-autoconfig" || base.version !== 1 ||
        !base.config || typeof base.config !== "object" || Array.isArray(base.config) ||
        (base.config.macros != null && !Array.isArray(base.config.macros))) {
      throw new Error("請選擇遊戲匯出的第 1 版掛機設定 JSON。");
    }
  }

  function routeName(position, from, to) {
    const prefix = `${String(position + 1).padStart(2, "0")}_`;
    const describe = row => row.map.monsters.filter(monster => row.targets.includes(monster.id))
      .map(monster => monster.name).join("＋") || row.map.name;
    const shorten = (text, limit) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
    const separator = " → ";
    const capacity = 40 - prefix.length - separator.length;
    const start = describe(from);
    const end = describe(to);
    const endLimit = Math.min(end.length, capacity - Math.min(start.length, Math.floor(capacity / 2)));
    return prefix + shorten(start, capacity - endLimit) + separator + shorten(end, endLimit);
  }

  function generate(base, route, options) {
    if (base) validateBase(base);
    if (!route.length) throw new Error("請先加入至少一張地圖。");
    const template = base ?? {
      format: "ro-idle-autoconfig",
      version: 1,
      job: "",
      sections: ["map", "macros"],
      config: {},
    };
    if (new Set(route.map(row => row.map.id)).size !== route.length) {
      throw new Error("每張地圖只能加入巡迴一次。同圖的多隻 MVP 可以一起勾選。");
    }

    const baseMacros = options.macros.filter(macro =>
      !macro.steps.some(step => ["map", "profile"].includes(step.do)));
    const partyBelow = options.mode === "follower" && options.partyBelow !== "" ? Number(options.partyBelow) : null;
    if (partyBelow !== null && (!Number.isInteger(partyBelow) || partyBelow < 1 || partyBelow > 11)) {
      throw new Error("隊友人數請填 1～11，或留空。");
    }
    const buff = options.buff.trim().toUpperCase();
    if (options.mode === "leader" && buff && !/^[A-Z][A-Z0-9_]*$/.test(buff)) {
      throw new Error("請填入遊戲 Buff ID，例如 AL_INCAGI。");
    }
    const cooldown = Number(options.cooldown);
    if (!Number.isInteger(cooldown) || cooldown < 5 || cooldown > 86400) {
      throw new Error("換圖冷卻請填 5～86400 秒。");
    }
    const extraFly = options.mode === "follower" && options.fly && partyBelow !== null;
    const wait = options.waitForParty;
    const waitBelow = Number(options.waitBelow);
    const waitSeconds = Number(options.waitSeconds);
    const waitCooldown = Number(options.waitCooldown);
    const jobInput = options.mode === "follower" ? (options.targetJob ?? "").trim().toLowerCase() : "";
    const targetJob = rebirthJobCodes.get(jobInput) ?? jobInput;
    if (wait && (!Number.isInteger(waitBelow) || waitBelow < 1 || waitBelow > 11 ||
                 !Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 60 ||
                 !Number.isInteger(waitCooldown) || waitCooldown < 5 || waitCooldown > 86400)) {
      throw new Error("等待條件請填隊友 1～11 人、等待 1～60 秒、冷卻 5～86400 秒。");
    }
    if (wait && targetJob && !/^[a-z_]{1,32}$/.test(targetJob)) {
      throw new Error("標的角色職業 ID 格式有誤。");
    }
    const buffBeforeMove = options.mode === "leader" && options.buffBeforeMove;
    const routeBuffLevel = Number(options.routeBuffLevel);
    if (buffBeforeMove && (!buff || options.buffWhen !== "selfLacks" ||
        !Number.isInteger(routeBuffLevel) || routeBuffLevel < 1 || routeBuffLevel > 10)) {
      throw new Error("換圖前自補需要選擇「缺少 Buff 時換圖」及有效的技能等級。");
    }
    const standalone = options.castBuff;
    const castBuff = buffBeforeMove && (route.length > 1 || wait) && standalone?.target === "self" && standalone.skill === buff
      ? null : standalone;
    if (castBuff && (!/^[A-Z0-9_]{1,40}$/.test(castBuff.skill) ||
        !["self", "ally"].includes(castBuff.target) ||
        !Number.isInteger(castBuff.level) || castBuff.level < 1 || castBuff.level > 10 ||
        !Number.isInteger(castBuff.cooldown) || castBuff.cooldown < 5 || castBuff.cooldown > 86400)) {
      throw new Error("請選擇補放技能，並確認等級和冷卻時間。");
    }
    const capacity = Math.min(Number(options.groupSize), 10 - baseMacros.length - Number(Boolean(wait)) - Number(Boolean(castBuff)));
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("原有巨集已用完 10 個名額，請先移除幾條巨集。");
    }

    const groups = [];
    let group = [];
    let monsters = new Set();
    let rulesById = new Map();
    let targetStatus = new Map();
    for (const row of route) {
      const rowIds = row.map.monsters.map(monster => monster.id);
      if (rowIds.length > 200) throw new Error("單張地圖超出遊戲的 200 筆怪物規則上限。");
      const rowRules = row.map.monsters.map(monster => {
        const override = row.smallRules?.[monster.id];
        const selected = row.targets.includes(monster.id);
        const escape = override?.escape ?? (selected ? options.targetEscape : options.escape);
        const defaultAction = selected
          ? (options.targetAction || (options.mode === "leader" ? "priority" : "defend"))
          : (options.otherAction || "defend");
        const action = override?.action ?? defaultAction;
        return [monster.id, {monsterId: monster.id, action, ...(escape ? {escape} : {})}, selected];
      });
      const conflicts = rowRules.some(([id, rule, selected]) => {
        const prior = rulesById.get(id);
        return prior && (prior.action !== rule.action || prior.escape !== rule.escape ||
          (options.onlyMvp && targetStatus.get(id) !== selected));
      });
      if (group.length === capacity || new Set([...monsters, ...rowIds]).size > 200 || conflicts) {
        groups.push({segment: group, rulesById});
        group = [];
        monsters = new Set();
        rulesById = new Map();
        targetStatus = new Map();
      }
      group.push(row);
      for (const id of rowIds) monsters.add(id);
      for (const [id, rule, selected] of rowRules) {
        rulesById.set(id, rule);
        targetStatus.set(id, selected);
      }
    }
    if (group.length) groups.push({segment: group, rulesById});
    const label = index => String(index + 1).padStart(2, "0");

    return groups.map(({segment, rulesById}, index) => {
      const next = (index + 1) % groups.length;
      const profile = structuredClone(template);
      profile.name = label(index);
      profile.exportedAt = Date.now();
      if (Array.isArray(profile.sections)) {
        profile.sections = [...new Set([...profile.sections, "map", "macros"])];
      }
      const config = profile.config;
      config.lockMap = segment[0].map.id;
      const mapIds = segment.map(row => row.map.id);
      const targets = new Set(segment.flatMap(row => row.targets));
      if (options.onlyMvp && !targets.size) {
        throw new Error(`配置 ${label(index)} 沒有指定 MVP 或 Boss，無法使用只選指定目標。`);
      }
      config.monsterRules = [...rulesById.values()];
      const previousTargets = config.targets ?? {};
      config.targets = {
        ...previousTargets,
        priority: options.priority,
        minLv: Number(options.minLv),
        maxLv: Number(options.maxLv),
        avoidAggressive: options.avoidAggressive,
        whitelist: options.onlyMvp ? [...targets] : [],
        blacklist: (previousTargets.blacklist ?? []).filter(id => !targets.has(id)),
      };
      if (options.mode === "leader" && config.escape &&
          (!profile.sections || profile.sections.includes("escape"))) {
        config.escape = {
          ...config.escape,
          avoidMvp: false,
          dangerMonsters: (config.escape.dangerMonsters ?? []).filter(id => !targets.has(id)),
        };
      }
      const departure = options.departure ?? "auto";
      const departureAction = departure === "auto"
        ? (buffBeforeMove ? "teleport" : extraFly ? "fly" : "none")
        : departure;
      const departureStep = {
        teleport: {do: "skill", skill: "AL_TELEPORT", lv: 2},
        fly: {do: "item", itemId: 601},
        butterfly: {do: "butterfly"},
      }[departureAction];
      const moves = segment.flatMap((row, position) => {
        const last = position === segment.length - 1;
        const destination = last ? groups[next].segment[0] : segment[position + 1];
        if (destination.map.id === row.map.id) return [];
        const steps = [];
        if (buffBeforeMove) steps.push({do: "skill", skill: buff, lv: routeBuffLevel});
        if (departureStep) steps.push(departureStep);
        if (last && groups.length > 1) steps.push({do: "profile", name: label(next)});
        steps.push({do: "map", mapId: destination.map.id});
        const cond = {maps: [row.map.id]};
        if (options.mode === "leader") cond.engaged = false;
        if (buffBeforeMove) {
          cond.doing = ["searching", "idle"];
          cond.spAbove = 10;
        }
        if (options.mode === "follower" && partyBelow !== null) cond.partyBelow = partyBelow;
        if (options.mode === "leader" && buff) cond[options.buffWhen] = [buff];
        return [{name: routeName(position, row, destination), cooldownSec: cooldown, cond, steps}];
      });
      const flies = extraFly ? [{
        name: `隊友少於${partyBelow}人_使用蒼蠅翅膀`, cooldownSec: cooldown,
        cond: {maps: mapIds, partyBelow}, steps: [{do: "item", itemId: 601}],
      }] : [];
      const waiting = wait ? [{
        name: `隊友少於${waitBelow}人_${buffBeforeMove ? "補 Buff 並等待" : "等待"}`,
        cooldownSec: waitCooldown,
        cond: {
          ...(buffBeforeMove ? {} : {maps: mapIds, inParty: true}),
          engaged: false,
          partyBelow: waitBelow,
          ...(targetJob ? {allyJobs: [targetJob]} : {}),
        },
        steps: [...(buffBeforeMove ? [{do: "skill", skill: buff, lv: routeBuffLevel}] : []), {do: "wait", sec: waitSeconds}],
      }] : [];
      const buffMacros = castBuff ? [{
        name: ("補 Buff_" + (castBuff.name || castBuff.skill)).slice(0, 40),
        cooldownSec: castBuff.cooldown,
        cond: castBuff.target === "ally"
          ? {maps: mapIds, inParty: true, allyLacks: [castBuff.skill]}
          : {maps: mapIds, selfLacks: [castBuff.skill]},
        steps: [{do: "skill", skill: castBuff.skill, lv: castBuff.level, target: castBuff.target}],
      }] : [];
      const waitFirst = options.waitPosition === "top";
      const waitLast = options.waitPosition === "bottom" || buffBeforeMove;
      config.macros = [
        ...(waitFirst ? waiting : []),
        ...buffMacros, ...(!waitFirst && !waitLast ? waiting : []),
        ...structuredClone(baseMacros), ...moves, ...(moves.length ? [] : flies),
        ...(!waitFirst && waitLast ? waiting : []),
      ];
      if (config.profileSwitch?.length) delete config.profileSwitch;
      return {
        file: `${label(index)}.ro-idle.json`,
        profile,
        segment,
        next: groups.length > 1 ? label(next) : null,
      };
    });
  }

  globalThis.RoConfigBuilder = {validateBase, generate};
})();
