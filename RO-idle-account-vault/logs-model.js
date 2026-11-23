
globalThis.CombatLogs = {
  monsterAliases: new Map([
    [1364, "風靈龜"], [1594, "水靈龜"], [1600, "火焰龜"], [1601, "果樹龜"], [1602, "岩石龜"],
  ]),
  skillAliases: {
    NPC_SUMMONSLAVE: "召喚隨從",
    NPC_CALLSLAVE: "召回隨從",
    NPC_SUMMONMONSTER: "召喚魔物",
    NPC_POWERUP: "力量提升",
    NPC_AGIUP: "敏捷提升",
    NPC_SELFDESTRUCTION: "自爆",
    NPC_CRITICALSLASH: "致命攻擊",
    NPC_DARKBREATH: "黑暗吐息",
    NPC_DARKBLESSING: "黑暗祝福",
    NPC_BARRIER: "防護罩",
    NPC_REBIRTH: "重生",
    NPC_EARTHQUAKE: "地震連繫",
    NPC_PULSESTRIKE: "脈震衝撞",
    NPC_STONESKIN: "鋼筋鐵骨",
    NPC_WIDESILENCE: "廣範圍沉默",
  },
  mvpIndexTypes: new Set([
    "found", "ambush", "targetSwitch", "playerAttack", "monsterAttack", "skillHit", "monsterSkill", "mobSkill",
    "devoted", "devotionHit", "kill", "mvp", "worldMvp", "death", "stop", "mapChange", "teleport", "arrive",
  ]),
  mvpContextTypes: new Set([
    "support", "devoted", "devotionHit", "heal", "buffStart", "buffEnd", "statusStart", "statusEnd",
    "monsterJoin", "monsterLeave",
  ]),
  eventTime(row) {
    const time = row.eventAt ?? row.data?.wallMs ?? row.wallMs ?? row.receivedAt;
    return Number.isFinite(time) ? time : row.receivedAt;
  },
  dayKey(time) {
    return new Date(time).toLocaleDateString("sv-SE", {timeZone: "Asia/Taipei"});
  },
  skillName(code, labels = {}) {
    if (!code) return "技能";
    if (labels.skills?.[code]) return labels.skills[code];
    if (this.skillAliases[code]) return this.skillAliases[code];
    const [prefix, ...parts] = String(code).split("_");
    const readable = parts.join(" ") || String(code);
    return prefix === "NPC" ? `怪物技能「${readable}」` : readable;
  },
  translateSkillCodes(text, labels = {}) {
    return String(text || "").replace(/\b[A-Z]{2,}_[A-Z0-9_]+\b/g, code => this.skillName(code, labels));
  },
  translateMonsterIds(text, names = new Map()) {
    return String(text || "").replace(/怪物\s*#(\d+)/g, (source, id) =>
      names.get(Number(id)) || this.monsterAliases.get(Number(id)) || source);
  },
  categories: {all: "全部", combat: "戰鬥", skill: "技能", exp: "經驗值", loot: "掉寶", system: "系統", warn: "警告"},
  category(row) {
    if (row.category && this.categories[row.category]) return row.category;
    const body = row.data?.body || {};
    const type = body.type || "";
    if (/^(exp|baseLevelUp|jobLevelUp)$/.test(type)) return "exp";
    if (/^(estimate|unpicked|worldMvpNote|worldMvp|mvp|drop|pickup)$/.test(type)) return "loot";
    if (/^(pickupFail|death|weight|noPotion|searchSlow)$/.test(type)) return "warn";
    if (/skill|spell|buff|support|heal/i.test(type)) return "skill";
    if (/attack|found|ambush|kill|target|searching|luring|devot/i.test(type)) return "combat";
    const text = row.text || "";
    if (/死亡|負重|背包已滿|無法撿取|沒有可用的回復|警告/.test(text)) return "warn";
    if (/EXP|Level 提升|經驗值|技能點|屬性點/.test(text) && !/MVP/.test(text)) return "exp";
    if (/MVP|掉落|撿取|撿到|獲得物品|隊伍分配|稀有|卡片/.test(text)) return "loot";
    if (/技能|施放|詠唱|念咒|效果開始|效果結束|使用.+Lv|治癒|SP 消耗/.test(text)) return "skill";
    if (/攻擊|傷害|擊敗|鎖定目標|發現|搜尋|引怪|Miss|迴避|暴擊|衝過來/.test(text)) return "combat";
    return "system";
  },
  marker(row) {
    const body = row.data?.body;
    if (body?.type) return body.type === "mvp" || body.type === "worldMvp";
    const text = (row.text || "").replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, "").trim();
    return /^★?\s*MVP[！!]\s*打倒了/.test(text) ||
      /^★?\s*【MVP】你的隊伍在.+搶到了/.test(text) ||
      /^【MVP】.+被別的隊伍搶走了/.test(text);
  },
  mvpIndexRelevant(row) {
    if (this.marker(row) || this.mvpText(row)) return true;
    return this.mvpIndexTypes.has(row.data?.body?.type);
  },
  dedupeRenderedEvents(rows) {
    const rendered = new Map();
    const renderedBySequence = new Map();
    const matchKey = row => {
      const seq = row.seq ?? row.data?.seq;
      if (seq == null) return "";
      return seq + ":" + (this.marker(row) ? "mvp-result" : this.category(row));
    };
    for (const row of rows) {
      if (row.kind !== "遊戲文字") continue;
      const key = matchKey(row);
      if (key) rendered.set(key, (rendered.get(key) ?? 0) + 1);
      const seq = row.seq ?? row.data?.seq;
      if (seq != null) renderedBySequence.set(String(seq), (renderedBySequence.get(String(seq)) ?? 0) + 1);
    }
    const hidden = new Set();
    for (const row of rows) {
      if (row.kind === "遊戲文字") continue;
      const key = matchKey(row);
      const remaining = key ? rendered.get(key) ?? 0 : 0;
      if (!remaining) continue;
      hidden.add(row);
      if (remaining === 1) rendered.delete(key);
      else rendered.set(key, remaining - 1);
      const seq = row.seq ?? row.data?.seq;
      const sequenceRemaining = renderedBySequence.get(String(seq)) ?? 0;
      if (sequenceRemaining <= 1) renderedBySequence.delete(String(seq));
      else renderedBySequence.set(String(seq), sequenceRemaining - 1);
    }
    for (const row of rows) {
      if (row.kind === "遊戲文字" || hidden.has(row)) continue;
      const seq = row.seq ?? row.data?.seq;
      if (seq == null) continue;
      const remaining = renderedBySequence.get(String(seq)) ?? 0;
      if (!remaining) continue;
      hidden.add(row);
      if (remaining === 1) renderedBySequence.delete(String(seq));
      else renderedBySequence.set(String(seq), remaining - 1);
    }
    return rows.filter(row => !hidden.has(row));
  },
  mvpText(row) {
    const text = (row.text || "").replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, "")
      .replace(/^\[HP[^\]]*\]\s*/i, "").trim();
    const reward = text.match(/^★?\s*MVP[！!]\s*打倒了\s*([^：:！!。]+)/);
    if (reward) return {monster: reward[1].trim(), result: "取得 MVP 獎勵"};
    const won = text.match(/^★?\s*【MVP】你的隊伍在.+搶到了\s*([^：:！!。]+)/);
    if (won) return {monster: won[1].trim(), result: "隊伍獲勝"};
    const lost = text.match(/^【MVP】\s*(.+?)\s*被別的隊伍搶走了/);
    if (lost) return {monster: lost[1].trim(), result: "其他隊伍獲勝"};
    const found = text.match(/^(?:發現|鎖定目標[：:]?)\s*(.+?)(?:\s+Lv\.|[！!。]|$)/);
    if (found) return {monster: found[1].trim(), found: true};
    for (const pattern of [
      /^攻擊\s+(.+?)\s*(?:[—–─━]{1,2}|，|,)/,
      /^(?:開始詠唱|施放|使用).+?[→➜]\s*(.+?)(?:\s*[（(]|[！!。]|$)/,
      /對\s+(.+?)\s+造成\s*[\d,]+\s*點?傷害/,
      /^(?:成功擊敗|打倒了)\s*(.+?)[！!。]$/,
    ]) {
      const hit = text.match(pattern);
      if (hit) return {monster: hit[1].trim()};
    }
    return null;
  },
  indexMvpText(rows, pending) {
    const summaries = [];
    rows.sort((a, b) => this.eventTime(a) - this.eventTime(b) || (a.seq ?? 0) - (b.seq ?? 0));
    for (const row of rows) {
      const time = this.eventTime(row);
      const characterKey = row.characterKey;
      if (["death", "stop", "mapChange", "teleport", "arrive"].includes(row.data?.body?.type)) {
        for (const [key, state] of pending) if (state.characterKey === characterKey) pending.delete(key);
        continue;
      }
      const match = this.mvpText(row);
      if (!match?.monster) continue;
      const key = JSON.stringify([characterKey, match.monster]);
      const previous = pending.get(key);
      const start = previous && !match.found && time >= previous.lastAt && time - previous.lastAt <= 120000
        ? previous.startedAt : time;
      if (match.result) {
        summaries.push({id: "notice:" + row.id, characterKey, characterId: row.characterId, character: row.character,
          account: row.account, monsterName: match.monster, startedAt: start, endedAt: time, seq: row.seq,
          result: match.result, textContext: true, notice: true});
        pending.delete(key);
      } else {
        pending.set(key, {characterKey, startedAt: start, lastAt: time});
      }
      for (const [id, state] of pending) if (time - state.lastAt > 120000) pending.delete(id);
    }
    return summaries;
  },
  buildMvpIndex(records, pending = new Map()) {
    const battles = [];
    const combatTypes = new Set(["found", "ambush", "targetSwitch", "playerAttack", "monsterAttack", "skillHit", "monsterSkill", "mobSkill", "devoted", "devotionHit", "kill"]);
    records.sort((a, b) => String(a.characterId).localeCompare(String(b.characterId)) || (a.eventAt || 0) - (b.eventAt || 0) || a.seq - b.seq);
    for (const record of records) {
      if (["death", "stop", "mapChange", "teleport", "arrive"].includes(record.type)) {
        for (const [key, battle] of pending) if ((battle.characterKey ?? battle.characterId) === (record.characterKey ?? record.characterId)) pending.delete(key);
      }
      const result = record.type === "mvp" || record.type === "worldMvp";
      if (!result && !combatTypes.has(record.type)) continue;
      if (record.monsterId == null) continue;
      const key = (record.characterKey ?? record.characterId) + ":" + record.monsterId;
      let battle = pending.get(key);
      const differentInstance = battle?.uid != null && record.uid != null && String(battle.uid) !== String(record.uid);
      const newEncounter = record.type === "found" || (battle?.closed && !result);
      if (!battle || differentInstance || newEncounter || record.seq < battle.end) {
        battle = {
          id: key + ":" + record.seq + ":" + (record.eventAt || 0),
          characterKey: record.characterKey, characterId: record.characterId, monsterId: record.monsterId,
          uid: record.uid, character: record.character, account: record.account,
          monsterName: record.monsterName,
          start: record.seq, end: record.seq,
          startedAt: record.eventAt, endedAt: record.eventAt,
          sequences: new Set(), closed: false
        };
        pending.set(key, battle);
      }
      if (record.uid != null) battle.uid = record.uid;
      battle.sequences.add(record.seq);
      battle.end = record.seq;
      battle.endedAt = record.eventAt;
      if (record.monsterName) battle.monsterName = record.monsterName;
      if (record.type === "kill") battle.closed = true;
      if (result) {
        battle.closed = true;
        battle.result = record.type === "mvp" ? "取得 MVP 獎勵" : record.won ? "隊伍獲勝" : "其他隊伍獲勝";
        battles.push(battle);
        pending.delete(key);
      }
    }
    return battles;
  },
  describeArchivedEvent(row, names, labels, battle) {
    const body = row.data?.body;
    if (!body || typeof body !== "object") return this.translateMonsterIds(this.translateSkillCodes(row.text, labels), names);
    const battleMonster = body.monsterId != null && battle.monsterId != null &&
      Number(body.monsterId) === Number(battle.monsterId) ? battle.monsterName : "";
    const monster = body.monsterName || names.get(Number(body.monsterId)) || this.monsterAliases.get(Number(body.monsterId)) || battleMonster ||
      (body.monsterId == null ? "" : "怪物 #" + body.monsterId) || battle.monsterName || "目標";
    const skill = this.skillName(body.skill, labels) + (body.lv ? " Lv." + body.lv : "");
    const effectKey = body.status ?? body.effect ?? body.buff ?? body.skill;
    const effect = body.statusName || body.effectName || (effectKey ? this.skillName(effectKey, labels) : "狀態效果");
    const item = labels.items?.[body.itemId] || (body.itemId == null ? "道具" : "道具 #" + body.itemId);
    const number = value => Number.isFinite(value) ? value.toLocaleString("zh-TW") : "";
    const damage = number(body.damage);
    const outcome = body.result === "miss" ? "Miss" : damage ? damage + " 點傷害" : "命中";
    const message = body.message || body.text || body.detail || body.reason || "";
    const target = body.targetName || body.target || "";
    const actor = [body.ally, body.sourceName, body.masterName, body.source,
      typeof body.master === "string" && body.master !== "master" ? body.master : ""].find(value => typeof value === "string" && value);
    const summoner = body.masterName || (typeof body.master === "string" && body.master !== "master" ? body.master : "");
    switch (body.type) {
      case "found": return "發現 " + monster + "。";
      case "ambush": return monster + " 主動衝過來！";
      case "targetSwitch": return `切換目標：${monster}${typeof body.ally === "string" ? "（支援 " + body.ally + "）" : ""}。`;
      case "skillCast": return `開始詠唱 ${skill} → ${monster}${Number.isFinite(body.castMs) ? "（" + body.castMs + " 毫秒）" : ""}。`;
      case "skillHit": return `${skill} → ${monster} · ${outcome}${body.hits > 1 ? "（" + body.hits + " 次）" : ""}。`;
      case "playerAttack": return `攻擊 ${monster} · ${outcome}。`;
      case "monsterAttack": return `${monster} 的攻擊 · ${outcome}。`;
      case "mobSkill":
      case "monsterSkill": return `${monster} 使用 ${skill}${damage ? " · " + outcome : ""}。`;
      case "buffStart": return `${effect} 效果開始${target ? "（" + target + "）" : ""}。`;
      case "buffEnd": return `${effect} 效果結束${target ? "（" + target + "）" : ""}。`;
      case "statusStart": return `${effect} 狀態開始${body.monsterId == null ? "" : " · " + monster}。`;
      case "statusEnd": return `${effect} 狀態結束${body.monsterId == null ? "" : " · " + monster}。`;
      case "support": return `${actor || "隊友"} 使用 ${skill} 支援${target ? " " + target : ""}。`;
      case "devoted": return `${actor || "隊友"} 保護${target ? " " + target : "隊友"}，準備代為承受傷害。`;
      case "devotionHit": return `${actor || "隊友"} 代替${target ? " " + target : "隊友"}承受 ${damage || number(body.amount) || "未知"} 點傷害。`;
      case "heal": return `${actor || "角色"} 恢復 ${number(body.amount ?? body.heal) || "未知"} HP。`;
      case "system": return message ? "系統：" + message : `系統事件${body.monsterId == null ? "" : " · " + monster}。`;
      case "monsterJoin": return `${monster} 加入戰鬥${summoner ? "（召喚者：" + summoner + "）" : ""}。`;
      case "monsterLeave": return `${monster} 離開戰鬥${summoner ? "（召喚者：" + summoner + "）" : ""}。`;
      case "kill": return "成功擊敗 " + monster + "！";
      case "mvp": return `MVP！打倒了 ${monster}${Number.isFinite(body.exp) ? " · MVP 經驗 " + number(body.exp) : ""}。`;
      case "worldMvp": return `${monster} · ${body.won ? "隊伍獲勝" : "其他隊伍獲勝"}。`;
      case "drop": return `${monster} 掉落 ${item} × ${body.qty ?? 1}。`;
      case "pickup": return `撿到 ${item} × ${body.qty ?? 1}。`;
      case "exp": return `獲得 Base EXP ${number(body.baseExp ?? body.exp) || 0} / Job EXP ${number(body.jobExp) || 0}。`;
      case "baseLevelUp": return `Base Level 提升至 ${body.level ?? body.lv ?? "未知"}。`;
      case "jobLevelUp": return `Job Level 提升至 ${body.level ?? body.lv ?? "未知"}。`;
      case "death": return "角色死亡。";
      default: {
        const facts = [message, body.skill ? "技能 " + skill : "", effectKey && !body.skill ? "效果 " + effect : "",
          body.monsterId == null ? "" : monster, target ? "目標 " + target : ""].filter(Boolean);
        return `戰鬥事件（${body.type || "未知類型"}）${facts.length ? " · " + [...new Set(facts)].join(" · ") : ""}。`;
      }
    }
  },
  mvpRespawn(respawn, lastKill, now, {encountered = false, unavailable = false, noCooldown = false} = {}) {
    const start = Array.isArray(respawn) && Number.isFinite(lastKill) ? lastKill + respawn[0] * 1000 : null;
    const end = start == null ? null : start + respawn[1] * 1000;
    const label = encountered ? "目前交戰／已遇到"
      : unavailable ? "冷卻中（遊戲回報）"
      : start == null ? (noCooldown ? "已重生（遊戲未列冷卻）" : "無法估算")
      : now < start ? "冷卻中（推估）"
      : now <= end ? "可能已重生"
      : "預估區間已過";
    return {label, start, end};
  },
  directlyRelatedToMvp(row, battle) {
    if (battle.id === "notice:" + row.id) return true;
    const body = row.data?.body;
    const time = this.eventTime(row);
    const duringBattle = Number.isFinite(time) && time >= battle.startedAt && time <= (battle.endedAt ?? battle.startedAt);
    const contextType = body?.type || "";
    if (duringBattle && (this.mvpContextTypes.has(contextType) || /support|devot|buff|status|heal|guard|protect|absorb|cover|party|ally/i.test(contextType))) return true;
    if (body?.monsterId != null && battle.monsterId != null) {
      return Number(body.monsterId) === Number(battle.monsterId);
    }
    if (row.kind === "遊戲文字") {
      const match = this.mvpText(row);
      if (match && battle.monsterName) return match.monster === battle.monsterName;
      if (battle.monsterName && (row.text || "").includes(battle.monsterName)) return true;
    }
    return battle.sequences?.has(row.seq ?? row.data?.seq) === true;
  },
  battle(row, battles) {
    if (row.kind === "遊戲文字") {
      const time = this.eventTime(row);
      const context = battles.find(item => item.textContext && (item.characterKey
        ? item.characterKey === row.characterKey : item.characterId === row.characterId) &&
        time >= item.startedAt && time <= item.endedAt);
      if (context) return context;
    }
    const seq = row.seq ?? row.data?.seq;
    if (seq != null && row.characterId) {
      const battle = battles.find(item => item.characterId === row.characterId && item.sequences?.has(seq) &&
        (!item.startedAt || (this.eventTime(row) >= item.startedAt && this.eventTime(row) <= item.endedAt)));
      if (battle) return battle;
    }
    if (this.marker(row)) return {id: "notice:" + row.id, notice: true};
    return null;
  }
};
