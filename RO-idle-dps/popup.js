const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
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
let worker, snapshot, targets = [], skills = [], sequence = 0;
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
  const [tab] = await chrome.tabs.query({currentWindow:true, active:true});
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
        return {snapshot:view.snapshot};
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

async function load() {
  $("fields").disabled = $("refresh").disabled = true;
  $("result").hidden = true;
  $("status").textContent = "正在讀取角色資料…";
  try {
    [snapshot, targets] = await Promise.all([readCharacter(), engine("targets")]);
    skills = await engine("skills");
    $("role").textContent = `${snapshot.character.name} · Base ${snapshot.character.baseLv}／Job ${snapshot.character.jobLv}`;
    $("skill").replaceChildren(...skills.map(({id,name}) => new Option(name,id)));
    $("mode").options[1].disabled = !skills.length;
    if (!skills.length && $("mode").value === "skill") $("mode").value = "normal";
    $("skill-fields").hidden = $("mode").value !== "skill";
    fillLevels();
    fillMonsters();
    $("fields").disabled = false;
    $("status").textContent = "";
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
  $("timeline-title").textContent = defense.timelineCount > defense.timeline.length
    ? `第 1 次模擬的對戰過程（前 ${defense.timeline.length} 筆）`
    : "第 1 次模擬的對戰過程";
  $("timeline").replaceChildren(...defense.timeline.map(({at, text, hp}) => {
    const row = document.createElement("li");
    row.textContent = `${seconds(at)} · ${text} · HP ${format(hp)}`;
    return row;
  }));
}

function show(result) {
  const {monster,panel,lines} = result;
  $("target").textContent = `${monster.name} · Lv ${monster.lv}`;
  $("monster-stats").textContent = `HP ${format(monster.hp)} · ${element[monster.element] ?? monster.element} ${monster.elementLv} · ${race[monster.race] ?? monster.race} · ${size[monster.size]} · DEF ${format(panel.def)}／MDEF ${format(panel.mdef)}`;
  $("dps").textContent = format(result.dps);
  $("ttk").textContent = result.averageKill == null ? "未擊殺" : seconds(result.averageKill);
  $("summary").textContent = `${result.trials} 次 × ${result.seconds} 秒 · ${result.killedTrials} 次完成首殺 · 期末平均 SP ${format(result.endingSp)}`;
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
  showDefense(result.defense, result.trials);
  $("result").hidden = false;
}

$("search").oninput = fillMonsters;
$("skill").onchange = fillLevels;
$("mode").onchange = () => { $("skill-fields").hidden = $("mode").value !== "skill"; };
$("refresh").onclick = load;
$("calculator").onsubmit = async event => {
  event.preventDefault();
  if (!snapshot) return;
  const options = {
    monsterId:Number($("monster").value), mode:$("mode").value,
    skill:$("skill").value, level:Number($("skill-level").value), seconds:Number($("seconds").value),
    counterattack:$("counterattack").checked,
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
