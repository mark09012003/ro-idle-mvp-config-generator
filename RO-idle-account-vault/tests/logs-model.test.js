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

console.log("logs-model dedupe tests passed");
