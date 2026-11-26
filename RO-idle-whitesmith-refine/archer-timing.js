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
          previous.events.push({label: "下一次轉生", at});
        } else {
          previous.partial = true;
          previous.events.push({label: "恢復觀測時已進入下一輪", at});
        }
      }
      rounds.push({cycle, start: at, partial: !confirmedRebirth, events: [
        {key: "start", label: confirmedRebirth ? "轉生完成" : "開始觀測", at},
      ]});
      changed = true;
    }

    const round = rounds.at(-1);
    const add = (key, label) => {
      if (round.events.some(event => event.key === key)) return;
      round.events.push({key, label, at});
      changed = true;
    };
    if (!round.end) {
      add(`job:${character.job}`, `${jobs[character.job]} · Base ${character.baseLv}／Job ${character.jobLv}`);
      if (character.job === "sniper" && !round.events.some(event => event.key === "base75")) {
        const threshold = globalThis.roArcherWindwalkBase(character.rebirth);
        if (character.baseLv >= threshold) add("windwalkBase", `神射手達風之步門檻 Base ${threshold}`);
      }
      if (character.job === "sniper" && (character.skills?.SN_WINDWALK ?? 0) >= 10) add("windwalk", "風之步 10");
      const target = {hunter: 50, sniper: 70}[character.job];
      if (target && character.jobLv >= target) add("jobCap", `達 Job ${target}`);
      if (character.baseLv >= 99) add("baseCap", "達 Base 99");
      if (target && character.baseLv >= 99 && character.jobLv >= target) {
        add("max", "達到 Base／Job 目標");
        if (cycle >= 10 && character.job === "sniper") round.end = at;
      }
    }
    return changed ? rounds.slice(-20) : null;
  }

  globalThis.roArcherTiming = {recordProgress, key: id => `archer-timing-v1:${id}`};
})();
