const assert = require("node:assert/strict");

require("../logs-model.js");

const text = (seq, category, value = "畫面文字") => ({
  id: "text-" + value,
  kind: "遊戲文字",
  seq,
  category,
  text: value,
});
const event = (id, seq, type) => ({
  id,
  kind: "事件 JSON",
  seq,
  data: {seq, body: {type}},
});

{
  const rows = [
    text(100, "combat", "畫面只捕捉到一次攻擊"),
    event("attack-1", 100, "playerAttack"),
    event("attack-2", 100, "monsterAttack"),
    event("attack-3", 100, "playerAttack"),
  ];
  const result = CombatLogs.dedupeRenderedEvents(rows);
  assert.equal(result.length, 3, "一筆畫面文字只能抵消一筆同批次原始事件");
  assert.equal(result.filter(row => row.kind === "事件 JSON").length, 2);
}

assert.equal(CombatLogs.mvpIndexRelevant(event("attack", 400, "playerAttack")), true);
assert.equal(CombatLogs.mvpIndexRelevant(event("mob-skill", 400, "mobSkill")), true);
assert.equal(CombatLogs.mvpIndexRelevant(event("buff", 400, "buffStart")), false);
assert.equal(CombatLogs.translateSkillCodes("黃金蟲 使用 NPC_SUMMONSLAVE Lv.10。"), "黃金蟲 使用 召喚隨從 Lv.10。");
assert.equal(CombatLogs.translateSkillCodes("使用 NPC_UNKNOWN_ATTACK"), "使用 怪物技能「UNKNOWN ATTACK」");
assert.equal(CombatLogs.translateMonsterIds("怪物 #1364 離開戰鬥。"), "風靈龜 離開戰鬥。");
assert.equal(CombatLogs.translateMonsterIds("怪物 #9999 離開戰鬥。", new Map([[9999, "測試怪物"]])), "測試怪物 離開戰鬥。");

{
  const labels = {skills: {PR_LEXAETERNA: "天使之怒"}};
  const battle = {monsterId: 1477, monsterName: "古埃及王"};
  const describe = body => CombatLogs.describeArchivedEvent({data: {body}}, new Map(), labels, battle);
  assert.equal(describe({type: "monsterAttack", monsterId: 1477, damage: 0}), "古埃及王 的攻擊 · 0 點傷害。");
  assert.equal(describe({type: "mobSkill", monsterId: 1477, skill: "NPC_STONESKIN"}), "古埃及王 使用 鋼筋鐵骨。");
  assert.equal(describe({type: "buffStart", skill: "PR_LEXAETERNA"}), "天使之怒 效果開始。");
  assert.equal(describe({type: "statusEnd", status: "stun", monsterId: 1477}), "stun 狀態結束 · 古埃及王。");
  assert.equal(describe({type: "system", message: "切換戰鬥狀態"}), "系統：切換戰鬥狀態");
  assert.equal(describe({type: "devotionHit", ally: "十字軍", target: "祭司", damage: 1234}), "十字軍 代替 祭司承受 1,234 點傷害。");
  assert.equal(describe({type: "monsterLeave", monsterId: 1477}), "古埃及王 離開戰鬥。");
}

{
  const battle = {id: "battle", monsterId: 1477, monsterName: "古埃及王", startedAt: 1000, endedAt: 2000, sequences: new Set([10])};
  assert.equal(CombatLogs.directlyRelatedToMvp({eventAt: 1500, data: {body: {type: "support"}}}, battle), true,
    "王戰期間的隊友輔助應納入明細");
  assert.equal(CombatLogs.directlyRelatedToMvp({eventAt: 1500, data: {body: {type: "devotionHit", damage: 100}}}, battle), true,
    "王戰期間的隊友代扛傷害應納入明細");
  assert.equal(CombatLogs.directlyRelatedToMvp({eventAt: 1500, data: {body: {type: "partyGuard"}}}, battle), true,
    "未來新增的隊伍防護事件也應納入明細");
  assert.equal(CombatLogs.directlyRelatedToMvp({eventAt: 1500, data: {body: {type: "drop", monsterId: 999}}}, battle), false,
    "其他怪物的掉落仍應排除");
}

{
  const rows = [
    text(200, "skill", "技能文字"),
    event("attack", 200, "playerAttack"),
    event("skill", 200, "skillHit"),
  ];
  const result = CombatLogs.dedupeRenderedEvents(rows);
  assert.deepEqual(result.map(row => row.id), ["text-技能文字", "attack"], "不同類別不能互相抵消");
}

{
  const rows = [
    text(300, "loot", "MVP！打倒了阿特羅斯"),
    event("drop", 300, "drop"),
    event("mvp", 300, "mvp"),
  ];
  const result = CombatLogs.dedupeRenderedEvents(rows);
  assert.deepEqual(result.map(row => row.id), ["text-MVP！打倒了阿特羅斯", "drop"], "MVP 結算只抵消結算事件，不應吃掉落事件");
}

{
  const rows = [
    text(500, "system", "隊友替我承受了傷害"),
    event("devotion", 500, "devotionHit"),
  ];
  const result = CombatLogs.dedupeRenderedEvents(rows);
  assert.deepEqual(result.map(row => row.id), ["text-隊友替我承受了傷害"],
    "同一則已收到的遊戲文字應優先於分類不同的事件重建文字");
}

console.log("logs-model dedupe tests passed");
