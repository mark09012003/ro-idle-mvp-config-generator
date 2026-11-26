(() => {
  "use strict";
  const jobs = globalThis.roArcherTree;
  const firstJob = [["AC_DOUBLE",5],["AC_SHOWER",10],["AC_OWL",10],["AC_VULTURE",1],
    ["AC_CONCENTRATION",10],["AC_VULTURE",10],["AC_DOUBLE",9]];
  const sniper = [["SN_SHARPSHOOTING",5],["HT_BEASTBANE",1],["HT_FALCON",1],["SN_SIGHT",10]];
  const destinations = {novice:"archer", novice_high:"archer_high", archer:"hunter", archer_high:"sniper"};
  const fee = 1285000;

  function planArcher(character) {
    const {job, baseLv, jobLv, rebirth} = character;
    if (!Object.hasOwn(jobs, job) || (rebirth && rebirth.from !== "hunter")) {
      return {stop: true, message: "目前角色不在弓箭手／獵人轉生路線。"};
    }
    const levels = {...character.skills};
    let points = character.skillPoints;
    if (!Number.isInteger(points) || points < 0 || !Number.isInteger(jobLv) || !Number.isInteger(baseLv)) {
      return {stop: true, message: "角色的等級或技能點資料不完整。"};
    }
    const tree = jobs[job].skillTree;
    const byId = new Map(tree.map(skill => [skill.id, skill]));
    const skills = [];
    function canLearn(entry) {
      return entry && (levels[entry.id] ?? 0) < entry.maxLv &&
        jobLv >= (entry.minJobLv ?? 0) && jobLv >= (entry.questJobLv ?? 0) &&
        (entry.questJobLv !== undefined || points > 0) &&
        Object.entries(entry.requires ?? {}).every(([id, lv]) => (levels[id] ?? 0) >= lv);
    }
    function learn(entry) {
      levels[entry.id] = (levels[entry.id] ?? 0) + 1;
      if (entry.questJobLv === undefined) points--;
      skills.push(entry.id);
    }
    function applyOrder(order) {
      for (const [id, goal] of order) {
        const entry = byId.get(id);
        while ((levels[id] ?? 0) < goal && canLearn(entry)) learn(entry);
        if ((levels[id] ?? 0) < goal) return false;
      }
      return true;
    }
    function fillRemaining() {
      const one = jobs[jobs[job].jobChange.from].skillTree;
      const inherited = new Set(one.map(entry => entry.id));
      const filler = tree.filter(entry => !inherited.has(entry.id) && entry.questJobLv === undefined);
      while (points > 0) {
        const next = filler.find(canLearn);
        if (!next) break;
        learn(next);
      }
    }

    let ready = true;
    let waiting = "等待下一次升級。";
    if (job === "novice" || job === "novice_high") {
      applyOrder([["NV_BASIC",9],["NV_FIRSTAID",1]]);
      ready = (levels.NV_BASIC ?? 0) >= 9 && (levels.NV_FIRSTAID ?? 0) >= 1;
    } else if (job === "archer" || job === "archer_high") {
      ready = applyOrder(firstJob);
      if (ready && points > 0) {
        return {stop: true, message: "一轉技能已有額外配點，請確認後再轉職。"};
      }
    } else if (job === "hunter") {
      fillRemaining();
    } else {
      ready = applyOrder(sniper);
      if (ready && baseLv >= 75) {
        ready = applyOrder([["SN_WINDWALK",10]]);
        if (ready) fillRemaining();
      } else if (ready) {
        ready = false;
        waiting = "保留技能點，等待 Base 75 再學風之步。";
      }
    }

    if (skills.length) return {command: {type:"learnSkills", skills}};
    const destination = destinations[job];
    if (destination) {
      const rule = jobs[destination].jobChange;
      if (ready && jobLv >= rule.minJobLv && (!rule.spendAllSkillPoints || points === 0) &&
          Object.entries(rule.skills).every(([id, lv]) => (levels[id] ?? 0) >= lv)) {
        return {command: {type:"jobChange", job:destination}};
      }
    } else if (ready && baseLv >= 99 && jobLv >= (job === "hunter" ? 50 : 70)) {
      const cycle = rebirth ? (rebirth.count ?? 0) + 1 : 0;
      if (job === "sniper" && cycle >= 10 && points === 0) {
        return {stop: true, message: "已完成第 10 次轉生，達到 Base 99／Job 70。"};
      }
      if (points > 0) return {stop: true, message: "仍有技能點，但目前沒有可自動分配的技能。"};
      if (!(character.zeny >= fee)) return {stop: true, message: "轉生需要 1,285,000 Zeny，補足後可重新啟用。"};
      return {command: {type:"rebirth"}};
    }
    return {message: waiting};
  }

  globalThis.roPlanArcher = planArcher;
})();
