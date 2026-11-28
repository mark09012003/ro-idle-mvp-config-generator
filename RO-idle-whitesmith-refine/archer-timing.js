(() => {
  const jobs = {
    novice: "初學者", novice_high: "進階初學者", archer: "弓箭手",
    archer_high: "進階弓箭手", hunter: "獵人", sniper: "神射手",
  };

  function recordProgress(history, character, at, confirmedRebirth = false) {
    if (!Object.hasOwn(jobs, character.job) || (character.rebirth && character.rebirth.from !== "hunter")) return null;
    const cycle = character.rebirth ? (character.rebirth.count ?? 0) + 1 : 0;
    const rounds = structuredClone(history);
    const previous = rounds.at(-1);
    if (previous && previous.cycle > cycle) return null;
    let changed = false;
    if (!previous || previous.cycle !== cycle) {
      if (previous && !previous.end) {
        if (confirmedRebirth && cycle === previous.cycle + 1) {
          previous.end = at;
          previous.events.push({key: "rebirth", kind: "rebirth", label: "下一次轉生", at, baseLv: character.baseLv, jobLv: character.jobLv, job: character.job});
        } else {
          previous.partial = true;
          previous.events.push({key: "gap", kind: "start", label: "恢復觀測時已進入下一輪", at});
        }
      }
      rounds.push({cycle, start: at, partial: !confirmedRebirth, events: [
        {key: "start", kind: "start", label: confirmedRebirth ? "轉生完成" : "開始觀測", at, baseLv: character.baseLv, jobLv: character.jobLv, job: character.job},
      ]});
      changed = true;
    }

    const round = rounds.at(-1);
    const add = (key, label, kind = "level") => {
      if (round.events.some(event => event.key === key)) return;
      round.events.push({key, kind, label, at, baseLv: character.baseLv, jobLv: character.jobLv, job: character.job});
      changed = true;
    };
    if (!round.end) {
      add(`job:${character.job}`, `${jobs[character.job]} · Base ${character.baseLv}／Job ${character.jobLv}`, "job");
      if ((character.skills?.AC_CONCENTRATION ?? 0) >= 10) {
        add("skill:conc10", "心神凝聚 Lv.10", "skill");
      }
      if (character.job === "sniper" && (character.skills?.SN_SHARPSHOOTING ?? 0) >= 5) {
        add("skill:sharp5", "銳利射擊 Lv.5", "skill");
      }
      if (character.job === "sniper" && (character.skills?.SN_SIGHT ?? 0) >= 10) {
        add("skill:sight10", "狙殺瞄準 Lv.10", "skill");
      }
      const isSecondJob = character.job === "hunter" || character.job === "sniper";
      if (isSecondJob && character.baseLv >= 70) add("base:70", "達 Base 70", "level");
      if (character.job === "sniper" && !round.events.some(event => event.key === "base75")) {
        const threshold = globalThis.roArcherWindwalkBase(character.rebirth);
        if (character.baseLv >= threshold) add("windwalkBase", `達風之步門檻 Base ${threshold}`, "skill");
      }
      if (character.job === "sniper" && (character.skills?.SN_WINDWALK ?? 0) >= 10) add("windwalk", "風之步 Lv.10", "skill");
      if (isSecondJob && character.baseLv >= 80) add("base:80", "達 Base 80", "level");
      if (isSecondJob && character.baseLv >= 90) add("base:90", "達 Base 90", "level");
      if (isSecondJob && character.baseLv >= 95) add("base:95", "達 Base 95", "level");
      const target = {hunter: 50, sniper: 70}[character.job];
      if (target && character.jobLv >= target) add("jobCap", `達 Job ${target}`, "cap");
      if (character.baseLv >= 99) add("baseCap", "達 Base 99", "cap");
      if (target && character.baseLv >= 99 && character.jobLv >= target) {
        add("max", `達滿等目標 Base 99／Job ${target}`, "cap");
        if (cycle >= 10 && character.job === "sniper") round.end = at;
      }
    }
    return changed ? rounds.slice(-20) : null;
  }

  globalThis.roArcherTiming = {recordProgress, key: id => `archer-timing-v1:${id}`};
})();
