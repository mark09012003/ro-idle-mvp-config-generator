const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const gameTab = new URL(location.href).searchParams.get("gameTab");
const number = new Intl.NumberFormat("zh-TW", {maximumFractionDigits: 2});
const format = value => Number.isFinite(value) ? number.format(value) : "—";
const seconds = ms => `${format(ms / 1000)} 秒`;
const element = {
  neutral:"無", water:"水", earth:"地", fire:"火", wind:"風",
  poison:"毒", holy:"聖", dark:"暗", ghost:"念", undead:"不死",
};
const race = {
  formless:"無形", undead:"不死", brute:"動物", plant:"植物", insect:"昆蟲", fish:"魚貝",
  demon:"惡魔", demihuman:"人形", angel:"天使", dragon:"龍",
};
const size = {small:"小型", medium:"中型", large:"大型"};
let worker, snapshot, scenario, targets = [], skills = [], sequence = 0;
const requests = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker("worker.js", {type:"module"});
  worker.onmessage = ({data}) => {
    const task = requests.get(data.id);
    if (!task) return;
    requests.delete(data.id);
    clearTimeout(task.timeout);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve(data.result);
  };
  worker.onerror = () => resetWorker("無法啟動戰鬥引擎，請確認擴充資料完整並重新載入。");
  return worker;
}

function resetWorker(message) {
  worker?.terminate();
  worker = null;
  for (const task of requests.values()) {
    clearTimeout(task.timeout);
    task.reject(new Error(message));
  }
  requests.clear();
}

function engine(action, options) {
  return new Promise((resolve, reject) => {
    const thread = getWorker();
    const id = ++sequence;
    const timeout = setTimeout(() => resetWorker("本機試算逾時，請改用較短的模擬時間。"), 20000);
    requests.set(id, {resolve, reject, timeout});
    thread.postMessage({id, action, snapshot: action === "targets" ? undefined : snapshot, options});
  });
}

async function readCharacter() {
  if (!globalThis.chrome?.scripting) throw new Error("請從 Chrome 工具列開啟已安裝的擴充。");
  const id = Number(gameTab);
  if (!gameTab || !/^\d+$/.test(gameTab) || !Number.isSafeInteger(id)) {
    throw new Error("請從 Chrome 工具列開啟單怪 DPS 試算。");
  }
  let tab;
  try { tab = await chrome.tabs.get(id); }
  catch { throw new Error("原本的遊戲分頁已關閉，請到遊戲分頁重新開啟 DPS 試算。"); }
  if (!tab?.url || new URL(tab.url).origin !== host || new URL(tab.url).pathname.startsWith("/info")) {
    throw new Error("請先到 ro-idle.app 進入角色，再開啟擴充。");
  }
  const [reply] = await chrome.scripting.executeScript({
    target:{tabId:tab.id},
    func: async allowedOrigin => {
      try {
        if (location.origin !== allowedOrigin) throw new Error("請回到遊戲分頁。");
        function currentName() {
          const classic = [...document.querySelectorAll(".xp-title .caption")]
            .map(node => node.textContent.trim().match(/^RO放置仙境 - \[(.+)\] .+ Lv\.\d+ \/ Job \d+$/)?.[1])
            .find(Boolean);
          const modern = document.querySelector('.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child');
          const text = modern && [...modern.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent).join("").trim();
          return classic || text;
        }
        const name = currentName();
        if (!name) throw new Error("找不到目前角色，請先進入遊戲畫面。");
        async function get(path) {
          const response = await fetch(path, {credentials:"same-origin", signal:AbortSignal.timeout(10000)});
          if (!response.ok) throw new Error(`讀取角色失敗（HTTP ${response.status}）。`);
          return response.json();
        }
        const {characters} = await get("/api/characters");
        const matches = characters?.filter(entry => entry.name === name);
        if (matches?.length !== 1 || !Number.isSafeInteger(matches[0].id)) throw new Error("無法確認目前角色。");
        const id = matches[0].id;
        const view = await get(`/api/characters/${id}?deferCatchup=1`);
        if (currentName() !== name || view.characterId !== id || view.snapshot?.character?.name !== name) {
          throw new Error("角色已切換，請更新角色後重試。");
        }
        // The server's derived panel already includes its active effects. Only
        // forward the base character and the inputs the local engine can recompute.
        const {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet} = view.snapshot;
        return {snapshot:{character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet}};
      } catch (error) {
        return {error: error.name === "TimeoutError" ? "讀取角色逾時。" : error.message};
      }
    },
    args:[host],
  });
  const result = reply?.result;
  if (!result?.snapshot?.config || !Array.isArray(result.snapshot.inventory) || !result.snapshot.equipment) {
    throw new Error(result?.error ?? "角色快照不完整。");
  }
  return result.snapshot;
}

function fillMonsters() {
  const term = $("search").value.trim().normalize("NFKC").toLowerCase();
  const current = $("monster").value;
  const found = targets.filter(({id,name}) => String(id).includes(term) || name.toLowerCase().includes(term));
  $("monster").replaceChildren(new Option(found.length ? "請選擇怪物" : "沒有符合的怪物", ""),
    ...found.map(({name,lv,id}) => new Option(`${name} · Lv ${lv} · #${id}`, id)));
  if (found.some(({id}) => String(id) === current)) $("monster").value = current;
  else if (term && found.length === 1) $("monster").value = String(found[0].id);
}

function fillLevels() {
  const skill = skills.find(entry => entry.id === $("skill").value);
  $("skill-level").replaceChildren(...Array.from({length:skill?.lv ?? 0}, (_, index) =>
    new Option(`Lv ${index + 1}`, index + 1)));
  if (skill) $("skill-level").value = String(skill.lv);
}

function renderScenario() {
  const ammo = $("ammo-choice");
  const selected = ammo.value;
  ammo.replaceChildren(new Option("沿用目前裝備與自動補箭", ""), ...scenario.ammo.map(arrow =>
    new Option(`${arrow.name} · ${element[arrow.element] ?? arrow.element} · 背包 ${format(arrow.quantity)} 支`, arrow.id)));
  if (scenario.ammo.some(arrow => String(arrow.id) === selected)) ammo.value = selected;
  ammo.disabled = !scenario.ammo.length;
  $("active-buffs").replaceChildren(...scenario.active.map(({index, name, level}) => {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = false;
    input.value = String(index);
    label.append(input, level ? `${name} Lv ${level}` : name);
    return label;
  }));
  if (!scenario.active.length) $("active-buffs").textContent = "角色目前沒有 Buff。";
  if (!$("extra-buffs").children.length) {
    $("extra-buffs").replaceChildren(...scenario.buffs.map(effectRow));
    $("monster-statuses").replaceChildren(...scenario.statuses.map(effectRow));
  }
  filterEffects("buff");
  filterEffects("status");
}

function numberField(text, name, initial, min, max) {
  const label = document.createElement("label");
  label.textContent = text;
  const input = document.createElement("input");
  input.type = "number";
  input.dataset.parameter = name;
  input.min = String(min);
  input.max = String(max);
  input.value = String(initial);
  input.required = true;
  label.append(input);
  return label;
}

function effectRow(definition) {
  const row = document.createElement("div");
  row.className = "effect-row";
  row.dataset.effect = definition.id;
  row.dataset.name = definition.name;
  const label = document.createElement("label");
  label.className = "check";
  const select = document.createElement("input");
  select.type = "checkbox";
  select.className = "effect-toggle";
  label.append(select, definition.name);
  const settings = document.createElement("fieldset");
  settings.className = "effect-parameters";
  settings.hidden = settings.disabled = true;
  settings.append(numberField("等級", "level", definition.max, 1, definition.max),
    numberField("持續（秒）", "seconds", 0, 0, 120));
  if (definition.stats) {
    for (const stat of definition.stats) settings.append(numberField(`演奏者 ${stat.toUpperCase()}`, stat, 90, 0, 999));
    settings.append(numberField(definition.lessonName, "lesson", 10, 0, 10));
  }
  select.onchange = () => {
    settings.hidden = settings.disabled = !select.checked;
    filterEffects(row.parentElement.id === "extra-buffs" ? "buff" : "status");
  };
  row.append(label, settings);
  return row;
}

const effectLists = {buff:"extra-buffs", status:"monster-statuses"};

function filterEffects(type) {
  const term = $(`${type}-filter`).value.trim().normalize("NFKC").toLowerCase();
  const rows = [...$(effectLists[type]).children];
  let visible = 0;
  let selected = 0;
  let hiddenSelected = 0;
  for (const row of rows) {
    const match = `${row.dataset.name} ${row.dataset.effect}`.normalize("NFKC").toLowerCase().includes(term);
    row.hidden = !match;
    if (match) visible++;
    if (row.querySelector(".effect-toggle").checked) {
      selected++;
      if (!match) hiddenSelected++;
    }
  }
  $(`${type}-count`).textContent = `顯示 ${visible} 項 · 已勾選 ${selected} 項` +
    (hiddenSelected ? `（${hiddenSelected} 項被篩選隱藏）` : "");
}

function readEffects(container) {
  return [...$(container).children].filter(row => row.querySelector(".effect-toggle").checked).map(row => {
    const {level, seconds, ...performer} = Object.fromEntries([...row.querySelectorAll("[data-parameter]")]
      .map(input => [input.dataset.parameter, Number(input.value)]));
    return {id:row.dataset.effect, level, seconds, performer};
  });
}

function readScenario() {
  return {
    includeActive: [...$("active-buffs").querySelectorAll("input:checked")].map(input => Number(input.value)),
    buffs: readEffects("extra-buffs"),
    statuses: readEffects("monster-statuses"),
    autoBuffs: $("auto-buffs").checked,
    ammoItemId: $("ammo-choice").value ? Number($("ammo-choice").value) : undefined,
  };
}

let statsVersion = 0;
let statsTimeout;
function scheduleStats() {
  clearTimeout(statsTimeout);
  statsTimeout = setTimeout(() => { void showStats(); }, 180);
}

function showEquipment({equipment, ammo, weaponType, attackElement}) {
  const arrow = ammo
    ? `${ammo.name} ×${format(ammo.quantity)} · 箭矢 ATK ${format(ammo.atk)} · ${element[ammo.element] ?? ammo.element}屬性${ammo.manual ? "（手動指定）" : ammo.fromBag ? "（從背包補上）" : ""}`
    : weaponType === "bow" ? "目前使用弓，箭矢欄和背包都沒有可用的散裝箭矢。" : "箭矢欄為空。";
  $("ammo-summary").textContent = `${arrow}　｜　起始普攻：${element[attackElement] ?? attackElement}屬性`;
  $("equipment-list").replaceChildren(...equipment.map(({slot, name, refine, broken, cards}) => {
    const row = document.createElement("li");
    row.textContent = `${slot} · ${refine ? `+${refine} ` : ""}${name}${broken ? "（損壞）" : ""}` +
      (cards.length ? ` · ${cards.join("、")}` : "");
    return row;
  }));
}

async function showStats() {
  if (!snapshot) return;
  const version = ++statsVersion;
  try {
    const preview = await engine("character", readScenario());
    const {base, current, names, allocated} = preview;
    if (version !== statsVersion) return;
    $("character-panel").hidden = false;
    $("stats-caption").textContent = current
      ? `基本素質＋額外加成 · ${names.join("、")}`
      : "基本素質＋額外加成 · 無起始 Buff";
    $("character-stats").replaceChildren(...Object.entries(base).map(([key, original]) => {
      const cell = document.createElement("div");
      const label = document.createElement("dt");
      label.textContent = key;
      const value = document.createElement("dd");
      const active = current?.[key] ?? original;
      if (Object.hasOwn(allocated, key)) {
        const split = total => {
          const extra = total - allocated[key];
          return `${format(allocated[key])} ${extra < 0 ? "−" : "+"} ${format(Math.abs(extra))}`;
        };
        value.textContent = split(active);
        value.title = `無 Buff：${split(original)} ＝ ${format(original)}${active !== original ? `。勾選後合計：${format(active)}` : ""}`;
      } else {
        value.textContent = format(original);
      }
      if (active !== original && !Object.hasOwn(allocated, key)) {
        const updated = document.createElement("small");
        updated.textContent = `→ ${format(active)}`;
        updated.dataset.direction = active > original ? "up" : "down";
        value.append(updated);
      }
      cell.append(label, value);
      return cell;
    }));
    showEquipment(preview);
  } catch (error) {
    if (version === statsVersion) $("stats-caption").textContent = error.message;
  }
}

$("scenario").addEventListener("input", event => {
  if (event.target.type !== "search") scheduleStats();
});
$("ammo-choice").onchange = scheduleStats;
$("buff-filter").oninput = () => filterEffects("buff");
$("status-filter").oninput = () => filterEffects("status");

async function load() {
  $("fields").disabled = $("refresh").disabled = true;
  $("character-panel").hidden = true;
  statsVersion++;
  $("result").hidden = true;
  $("status").textContent = "正在讀取角色資料…";
  try {
    [snapshot, targets] = await Promise.all([readCharacter(), engine("targets")]);
    [skills, scenario] = await Promise.all([engine("skills"), engine("scenario")]);
    renderScenario();
    $("role").textContent = `${snapshot.character.name} · Base ${snapshot.character.baseLv}／Job ${snapshot.character.jobLv}`;
    $("skill").replaceChildren(...skills.map(({id,name}) => new Option(name,id)));
    $("mode").options[1].disabled = !skills.length;
    if (!skills.length && $("mode").value === "skill") $("mode").value = "normal";
    $("skill-fields").hidden = $("mode").value !== "skill";
    fillLevels();
    fillMonsters();
    $("fields").disabled = false;
    $("status").textContent = "";
    await showStats();
  } catch (error) {
    snapshot = null;
    $("role").textContent = "尚未讀取角色";
    $("status").textContent = error.message;
  } finally {
    $("refresh").disabled = false;
  }
}

function showDefense(defense, trials) {
  $("defense").hidden = !defense;
  if (!defense) return;
  $("taken").textContent = format(defense.averageDamage);
  $("incoming-dps").textContent = format(defense.damagePerSecond);
  $("survival").textContent = `存活 ${trials - defense.deaths}／${trials} 次 · 期末平均 HP ${format(defense.endingHp)}` +
    (defense.averageDeath === null ? "" : ` · 倒下樣本平均撐 ${seconds(defense.averageDeath)}`);
  $("incoming-sources").textContent = defense.received.length
    ? `平均承傷來源　${defense.received.map(({name, average}) => `${name} ${format(average)}`).join(" · ")}`
    : "這些樣本中沒有受到怪物傷害。";
}

function showTimeline(timeline, total) {
  $("timeline-title").textContent = total > timeline.length
    ? `對戰紀錄 · 第 1 次模擬（前 ${timeline.length} 筆）`
    : "對戰紀錄 · 第 1 次模擬";
  $("timeline").replaceChildren(...timeline.map(({at, text, hp, kind}) => {
    const row = document.createElement("li");
    row.dataset.kind = kind;
    const time = document.createElement("time");
    const stamp = (at / 1000).toFixed(2);
    time.textContent = stamp.padStart(6, "0");
    const content = document.createElement("span");
    content.textContent = text;
    const health = document.createElement("span");
    health.className = "log-hp";
    health.textContent = `HP ${format(hp)}`;
    row.append(time, content, health);
    return row;
  }));
}

function renderSongEffects(songs) {
  const block = $("song-effects");
  block.hidden = !songs.length;
  const labels = {flee:"迴避", perfectDodge:"完全迴避", songHaste:"攻速加成", castRate:"詠唱時間",
    delayRate:"施放延遲", maxHpRate:"最大 HP", hit:"命中", crit:"暴擊", maxSpRate:"最大 SP", useSpRate:"SP 消耗"};
  const percent = new Set(["perfectDodge","songHaste","castRate","delayRate","maxHpRate","maxSpRate","useSpRate"]);
  $("song-breakdown").replaceChildren(...songs.map(song => {
    const row = document.createElement("li");
    const effects = Object.entries(song.bonuses).map(([key,value]) =>
      `${labels[key] ?? key} ${value >= 0 ? "+" : ""}${format(value)}${percent.has(key) ? "%" : ""}`);
    if (song.heal > 0) effects.push(`每 ${seconds(song.interval)}回復 ${format(song.heal)} HP`);
    row.textContent = `${song.name} · ${effects.join("、")}`;
    return row;
  }));
}

function show(result) {
  const {monster,panel,lines} = result;
  $("target").textContent = `${monster.name} · Lv ${monster.lv}`;
  $("monster-stats").textContent = `HP ${format(monster.hp)} · ${element[panel.elementTarget] ?? panel.elementTarget} ${panel.elementLvTarget} · ${race[monster.race] ?? monster.race} · ${size[monster.size]} · DEF ${format(panel.def)}／MDEF ${format(panel.mdef)}`;
  $("dps").textContent = format(result.dps);
  $("ttk").textContent = result.averageKill == null ? "未擊殺" : seconds(result.averageKill);
  $("summary").textContent = `${result.trials} 次 × ${result.seconds} 秒 · ${result.killedTrials} 次完成首殺 · ${result.unlimitedSp ? "無限 SP" : `期末平均 SP ${format(result.endingSp)}`}`;
  $("combat-stats").textContent = `起始普攻：${element[panel.element] ?? panel.element}屬性 ×${format(panel.modifier / 100)} · ASPD ${format(panel.aspd)}／間隔 ${seconds(panel.interval)} · 命中 ${format(panel.hit)}% · 爆擊 ${format(panel.crit)}%`;
  const share = lines.reduce((sum, entry) => sum + entry.share, 0);
  const displayed = result.dps > 0 && share < 0.999 ? [...lines, {name:"其他傷害", share:1-share, casts:0}] : lines;
  $("damage").replaceChildren(...displayed.map(entry => {
    const row = document.createElement("tr");
    const timing = entry.casts ? [entry.castMs,entry.delayMs,entry.cooldownMs]
      .map(value => seconds(value / entry.casts)).join("／") : "—";
    for (const value of [entry.name, `${format(entry.share * 100)}%`, timing]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  renderSongEffects(result.songs);
  showDefense(result.defense, result.trials);
  showTimeline(result.timeline, result.timelineCount);
  $("result").hidden = false;
}

$("search").oninput = fillMonsters;
$("skill").onchange = fillLevels;
$("mode").onchange = () => { $("skill-fields").hidden = $("mode").value !== "skill"; };
$("refresh").onclick = load;
$("calculator").addEventListener("invalid", event => {
  const row = event.target.closest(".effect-row");
  if (!row) return;
  $("scenario").open = true;
  if (!row.hidden) return;
  const type = row.parentElement.id === "extra-buffs" ? "buff" : "status";
  $(`${type}-filter`).value = "";
  filterEffects(type);
}, true);
$("calculator").onsubmit = async event => {
  event.preventDefault();
  if (!snapshot) return;
  const options = {
    monsterId:Number($("monster").value), mode:$("mode").value,
    skill:$("skill").value, level:Number($("skill-level").value), seconds:Number($("seconds").value),
    counterattack:$("counterattack").checked,
    unlimitedSp:$("unlimited-sp").checked,
    scenario: readScenario(),
  };
  $("fields").disabled = $("refresh").disabled = true;
  $("result").hidden = true;
  $("status").textContent = "正在本機模擬戰鬥…";
  try {
    show(await engine("simulate", options));
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("fields").disabled = $("refresh").disabled = false;
  }
};
void load();
