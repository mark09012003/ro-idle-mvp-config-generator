import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadArcherGlobals() {
  const ctx = {globalThis: {}, structuredClone};
  ctx.globalThis = ctx;
  for (const file of ["archer-tree.js", "archer-plan.js", "archer-timing.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(dir, file), "utf8"), ctx, {filename: file});
  }
  return ctx;
}

test("planArcher spends overflow first-job points even at Job <= 40 when core skills are already met", () => {
  const {roPlanArcher} = loadArcherGlobals();
  const res = structuredClone(roPlanArcher({
    job: "archer",
    baseLv: 50,
    jobLv: 40,
    skillPoints: 2,
    zeny: 0,
    skills: {AC_DOUBLE: 5, AC_SHOWER: 10, AC_OWL: 10, AC_VULTURE: 4, AC_CONCENTRATION: 10},
  }));
  assert.deepEqual(res, {command: {type: "learnSkills", skills: ["AC_VULTURE", "AC_VULTURE"]}});
});

test("planArcher blocks rebirth when vending or cart has items, and stops after 10th rebirth cap", () => {
  const {roPlanArcher} = loadArcherGlobals();
  const baseSniper = {
    job: "sniper",
    baseLv: 99,
    jobLv: 70,
    skillPoints: 0,
    zeny: 2_000_000,
    rebirth: {from: "hunter", count: 8},
    skills: {
      AC_DOUBLE: 5, AC_SHOWER: 10, AC_OWL: 10, AC_VULTURE: 10, AC_CONCENTRATION: 10,
      SN_SHARPSHOOTING: 5, HT_BEASTBANE: 1, HT_FALCON: 1, SN_SIGHT: 10, SN_WINDWALK: 10,
    },
  };
  assert.deepEqual(structuredClone(roPlanArcher(baseSniper, {vend: {title: "open"}})), {
    stop: true,
    message: "擺攤中無法轉生，收攤後可重新啟用。",
  });
  assert.deepEqual(structuredClone(roPlanArcher(baseSniper, {cart: {items: [{uid: 1}]}})), {
    stop: true,
    message: "手推車內仍有物品，清空後可重新啟用。",
  });
  assert.deepEqual(structuredClone(roPlanArcher(baseSniper, {})), {command: {type: "rebirth"}});

  const tenthRebirth = {...baseSniper, rebirth: {from: "hunter", count: 9}};
  const done = roPlanArcher(tenthRebirth, {});
  assert.equal(done.stop, true);
  assert.match(done.message, /保留第 11 轉自行選系/);
});

test("archer windwalk threshold decreases by 1 per subsequent rebirth", () => {
  const {roArcherWindwalkBase, roPlanArcher} = loadArcherGlobals();
  assert.equal(roArcherWindwalkBase({from: "hunter"}), 75);
  assert.equal(roArcherWindwalkBase({from: "hunter", count: 1}), 74);
  assert.equal(roArcherWindwalkBase({from: "hunter", count: 9}), 66);

  const waiting = roPlanArcher({
    job: "sniper",
    baseLv: 73,
    jobLv: 40,
    skillPoints: 5,
    zeny: 0,
    rebirth: {from: "hunter", count: 1},
    skills: {
      AC_DOUBLE: 5, AC_SHOWER: 10, AC_OWL: 10, AC_VULTURE: 10, AC_CONCENTRATION: 10,
      SN_SHARPSHOOTING: 5, HT_BEASTBANE: 1, HT_FALCON: 1, SN_SIGHT: 10,
    },
  });
  assert.match(waiting.message, /等待 Base 74/);
});

test("archer-timing records detailed skill and base level milestones across a rebirth cycle", () => {
  const {roArcherTiming} = loadArcherGlobals();
  let rounds = [];
  const t0 = 1_700_000_000_000;
  rounds = roArcherTiming.recordProgress(rounds, {
    job: "archer_high", baseLv: 30, jobLv: 35, rebirth: {from: "hunter"},
    skills: {AC_CONCENTRATION: 10},
  }, t0, true);
  assert.equal(rounds.length, 1);
  assert.ok(rounds[0].events.some(e => e.key === "skill:conc10" && e.kind === "skill"));

  rounds = roArcherTiming.recordProgress(rounds, {
    job: "sniper", baseLv: 75, jobLv: 45, rebirth: {from: "hunter"},
    skills: {AC_CONCENTRATION: 10, SN_SHARPSHOOTING: 5, SN_SIGHT: 10, SN_WINDWALK: 10},
  }, t0 + 600_000, false);
  const keys = new Set(rounds[0].events.map(e => e.key));
  for (const expected of ["job:sniper", "skill:sharp5", "skill:sight10", "base:70", "windwalkBase", "windwalk"]) {
    assert.ok(keys.has(expected), `missing milestone ${expected}`);
  }

  rounds = roArcherTiming.recordProgress(rounds, {
    job: "sniper", baseLv: 99, jobLv: 70, rebirth: {from: "hunter"},
    skills: {AC_CONCENTRATION: 10, SN_SHARPSHOOTING: 5, SN_SIGHT: 10, SN_WINDWALK: 10},
  }, t0 + 3_600_000, false);
  const keys2 = new Set(rounds[0].events.map(e => e.key));
  for (const expected of ["base:80", "base:90", "base:95", "jobCap", "baseCap", "max"]) {
    assert.ok(keys2.has(expected), `missing milestone ${expected}`);
  }
});
