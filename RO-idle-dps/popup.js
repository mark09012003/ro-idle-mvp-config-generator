const $ = id => document.getElementById(id);
const ASSET_VER = "20261128-6";
const host = "https://ro-idle.app";
const gameTab = new URL(location.href).searchParams.get("gameTab");
const isExtension = Boolean(globalThis.chrome?.scripting && gameTab);
const SAVED_STORAGE_KEY = "ro-idle-dps-imported-only-v1";
const THEME_STORAGE_KEY = "ro-idle-dps-theme";
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
const ELEMENT_BUFF_IDS = new Set([
  "PR_ASPERSIO", "AS_ENCHANTPOISON", "SA_FLAMELAUNCHER", "SA_FROSTWEAPON",
  "SA_LIGHTNINGLOADER", "SA_SEISMICWEAPON", "itemEndowWater",
]);
const ITEM_BUFF_PREFIXES = ["atkPotion", "matkPotion", "speedup", "aspdPotion", "resist", "strFood", "agiFood", "vitFood", "intFood", "dexFood", "lukFood"];

let worker, snapshot;
let scenario, targets = [], skills = [], sequence = 0;
let jobMap = new Map();
let savedCharacters = [];
let activeSavedKey = "";
let buffCategoryFilter = "all";
let useDirectEngine = false;
let directEnginePromise = null;
let targetsPromise = null;
let builderPromise = null;
const requests = new Map();

// =========================================================================
// Engine Worker + Direct Main-Thread Fallback
// =========================================================================

async function runDirectEngine(action, options) {
  if (!directEnginePromise) {
    directEnginePromise = import(`./engine.js?v=${ASSET_VER}`);
  }
  const eng = await directEnginePromise;
  return {
    targets: () => eng.targets,
    builder: () => eng.builderCatalog(),
    skills: () => eng.attackSkills(snapshot),
    scenario: () => eng.scenarioCatalog(snapshot),
    character: () => eng.previewCharacter(snapshot, options.scenario, options.mode, options.monsterId),
    mobSkills: () => eng.monsterSkills(options.monsterId),
    testMobSkill: () => eng.testMonsterSkill(snapshot, options),
    simulate: () => eng.simulate(snapshot, options),
  }[action]();
}

function fallbackToDirectEngine() {
  useDirectEngine = true;
  worker?.terminate();
  worker = null;
  const pending = [...requests.values()];
  requests.clear();
  for (const task of pending) {
    clearTimeout(task.timeout);
    runDirectEngine(task.action, task.options).then(task.resolve, task.reject);
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(`worker.js?v=${ASSET_VER}`, {type:"module"});
  worker.onmessage = ({data}) => {
    const task = requests.get(data.id);
    if (!task) return;
    requests.delete(data.id);
    clearTimeout(task.timeout);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve(data.result);
  };
  worker.onerror = () => fallbackToDirectEngine();
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
  if (useDirectEngine) return runDirectEngine(action, options);
  return new Promise((resolve, reject) => {
    let thread;
    try {
      thread = getWorker();
    } catch {
      useDirectEngine = true;
      runDirectEngine(action, options).then(resolve, reject);
      return;
    }
    const id = ++sequence;
    const timeout = setTimeout(() => resetWorker("本機試算逾時，請改用較短的模擬時間。"), 25000);
    requests.set(id, {resolve, reject, timeout, action, options});
    const noSnap = action === "targets" || action === "builder" || action === "mobSkills";
    thread.postMessage({id, action, snapshot: noSnap ? undefined : snapshot, options});
  });
}

function ensureTargets() {
  if (targets.length) return Promise.resolve(targets);
  if (!targetsPromise) {
    targetsPromise = engine("targets")
      .then(list => { targets = list; return list; })
      .catch(error => { targetsPromise = null; throw error; });
  }
  return targetsPromise;
}

function ensureJobNames() {
  if (jobMap.size) return Promise.resolve(jobMap);
  if (!builderPromise) {
    builderPromise = engine("builder")
      .then(info => {
        jobMap = new Map((info.jobs ?? []).map(j => [j.id, j]));
        return jobMap;
      })
      .catch(error => { builderPromise = null; throw error; });
  }
  return builderPromise;
}

// =========================================================================
// Snapshot Storage & Bookmarklet Import (Game Only, No JSON Import)
// =========================================================================

function normalizeSnapshot(raw) {
  const s = raw?.snapshot?.character ? raw.snapshot : raw;
  if (!s || typeof s !== "object" || !s.character?.name || !s.config || !Array.isArray(s.inventory) || !s.equipment) {
    throw new Error("角色快照格式不完整，請重新由 ro-idle.app 遊戲分頁透過書籤傳送。");
  }
  const {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet} = s;
  return {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet};
}

function charStorageKey(snap) {
  return `import::${snap.character.name}::${snap.character.job ?? ""}`;
}

function loadSavedList() {
  try {
    const raw = localStorage.getItem(SAVED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(e => e?.key && e?.snapshot?.character?.name) : [];
  } catch {
    return [];
  }
}

function persistSavedList() {
  try {
    localStorage.setItem(SAVED_STORAGE_KEY, JSON.stringify(savedCharacters));
  } catch {}
}

function upsertSavedCharacter(snap) {
  const key = charStorageKey(snap);
  const jobDef = jobMap.get(snap.character.job);
  const entry = {
    key,
    name: snap.character.name,
    baseLv: snap.character.baseLv,
    jobLv: snap.character.jobLv,
    job: snap.character.job ?? "",
    jobName: jobDef?.name ?? snap.character.job ?? "",
    savedAt: Date.now(),
    snapshot: structuredClone(snap),
  };
  savedCharacters = [entry, ...savedCharacters.filter(item => item.key !== key)].slice(0, 20);
  activeSavedKey = key;
  persistSavedList();
  renderSavedBar();
  return entry;
}

function formatTimeShort(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSavedBar() {
  if (isExtension) return;
  const sel = $("saved-character");
  if (!sel) return;
  if (!savedCharacters.length) {
    $("char-bar").hidden = true;
    return;
  }
  $("char-bar").hidden = false;
  sel.replaceChildren(...savedCharacters.map(entry => {
    const jName = entry.jobName || jobMap.get(entry.job)?.name || entry.job;
    return new Option(
      `${entry.name} · ${jName} · Lv ${entry.baseLv}/${entry.jobLv} · ${formatTimeShort(entry.savedAt)}`,
      entry.key
    );
  }));
  if (savedCharacters.some(entry => entry.key === activeSavedKey)) {
    sel.value = activeSavedKey;
    $("delete-saved").disabled = false;
  } else {
    $("delete-saved").disabled = true;
  }
}

function asciiEscape(str) {
  return str.replace(/[^\x20-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function buildBookmarklet(targetUrl) {
  const code = `(async()=>{const U=${JSON.stringify(targetUrl)};if(location.origin!=="https://ro-idle.app"){alert("請先切換到 https://ro-idle.app 遊戲分頁再執行此書籤。");return;}const w=window.open(U+"#waiting","ro_idle_dps");try{const g=async p=>{const r=await fetch(p,{credentials:"same-origin"});if(!r.ok)throw new Error("HTTP "+r.status);return r.json();};const {characters}=await g("/api/characters");if(!characters?.length)throw new Error("找不到角色，請確認已登入遊戲。");const c=[...document.querySelectorAll(".xp-title .caption")].map(n=>n.textContent.trim().match(/^RO放置仙境 - \\[(.+)\\] .+ Lv\\.\\d+ \\/ Job \\d+$/)?.[1]).find(Boolean);const m=document.querySelector('.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child');const mt=m&&[...m.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join("").trim();const cur=c||mt;const hit=cur?characters.filter(x=>x.name===cur):[];let t=hit.length===1?hit[0]:characters.length===1?characters[0]:null;if(!t){const pick=prompt("請輸入要載入的角色編號：\\n"+characters.map((x,i)=>(i+1)+". "+x.name+" (Lv."+(x.baseLv??"?")+")").join("\\n"),"1");if(pick===null){w?.close();return;}t=characters[Number(pick)-1];if(!t)throw new Error("角色編號無效。");}const v=await g("/api/characters/"+t.id+"?deferCatchup=1");const s=v.snapshot;if(!s?.character)throw new Error("角色快照不完整。");const snap={character:s.character,inventory:s.inventory,equipment:s.equipment,buffs:s.buffs,ailments:s.ailments,cart:s.cart,config:s.config,mapId:s.mapId,heldItems:s.heldItems,pet:s.pet};const o=new URL(U).origin;let ok=false;const onM=e=>{if(e.origin!==o)return;if(e.data?.type==="ro-dps-ready")w?.postMessage({type:"ro-dps-snapshot",snapshot:snap},o);if(e.data?.type==="ro-dps-ack"){ok=true;removeEventListener("message",onM);}};addEventListener("message",onM);if(w&&!w.closed){w.postMessage({type:"ro-dps-snapshot",snapshot:snap},o);for(let i=0;i<16&&!ok;i++){await new Promise(r=>setTimeout(r,250));if(!ok&&!w.closed)w.postMessage({type:"ro-dps-snapshot",snapshot:snap},o);}}removeEventListener("message",onM);if(ok)return;let h="";if(typeof CompressionStream==="function"){const cs=new CompressionStream("gzip");const wr=cs.writable.getWriter();wr.write(new TextEncoder().encode(JSON.stringify(snap)));wr.close();const b=new Uint8Array(await new Response(cs.readable).arrayBuffer());let bin="";for(let i=0;i<b.length;i+=32768)bin+=String.fromCharCode(...b.subarray(i,i+32768));h="#gz="+btoa(bin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}if(w&&!w.closed&&h&&h.length<60000){w.location.href=U+h;return;}if(h&&h.length<60000){location.href=U+h;return;}alert("跨分頁傳送失敗，請確認瀏覽器未封鎖彈出視窗後再重試。");}catch(e){alert("讀取角色失敗："+(e?.message||e));}})();`;
  return `javascript:${asciiEscape(code)}`;
}

async function decodeHashSnapshot() {
  const hash = location.hash;
  if (!hash || hash === "#waiting") return null;
  if (hash.startsWith("#gz=")) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("此瀏覽器不支援解壓縮書籤資料，請使用較新版本的瀏覽器。");
    }
    const b64 = hash.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const text = await new Response(ds.readable).text();
    history.replaceState(null, "", location.pathname + location.search);
    return normalizeSnapshot(JSON.parse(text));
  }
  return null;
}

async function readCharacterFromExtension() {
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
        const charId = matches[0].id;
        const view = await get(`/api/characters/${charId}?deferCatchup=1`);
        if (currentName() !== name || view.characterId !== charId || view.snapshot?.character?.name !== name) {
          throw new Error("角色已切換，請更新角色後重試。");
        }
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

// =========================================================================
// Tabs & Header
// =========================================================================

function switchTab(tabId) {
  for (const btn of document.querySelectorAll(".tab-btn")) {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.hidden = panel.id !== `tab-${tabId}`;
  }
}

function updateHeaderRole() {
  if (!snapshot) {
    $("role").textContent = "尚未匯入角色";
    return;
  }
  const c = snapshot.character;
  const jobName = jobMap.get(c.job)?.name ?? c.job;
  $("role").textContent = `${c.name} · ${jobName} · Base ${c.baseLv}／Job ${c.jobLv}`;
}

// =========================================================================
// Buffs & Monster Statuses
// =========================================================================

function buffCategoryOf(def) {
  if (def.id === "PA_GOSPEL" || def.id.startsWith("nativeInc") || def.id === "nativeScResist") return "gospel";
  if (def.stats) return "song";
  if (ELEMENT_BUFF_IDS.has(def.id)) return "element";
  if (ITEM_BUFF_PREFIXES.some(p => def.id.startsWith(p))) return "item";
  return "skill";
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

function effectRow(definition, isBuff = false) {
  const row = document.createElement("div");
  row.className = "effect-row";
  row.dataset.effect = definition.id;
  row.dataset.name = definition.name;
  if (definition.group) row.dataset.group = definition.group;
  if (isBuff) row.dataset.category = buffCategoryOf(definition);

  const label = document.createElement("label");
  label.className = "check";
  const select = document.createElement("input");
  select.type = "checkbox";
  select.className = "effect-toggle";
  const activeTag = document.createElement("span");
  activeTag.className = "effect-active-tag";
  activeTag.hidden = true;
  label.append(select, definition.name, activeTag);

  const settings = document.createElement("fieldset");
  settings.className = "effect-parameters";
  settings.hidden = settings.disabled = true;
  settings.append(
    numberField("等級", "level", definition.max, 1, definition.max),
    numberField("持續（秒）", "seconds", 0, 0, 120)
  );
  if (definition.maxCasters) {
    settings.append(numberField("施法者人數", "casterCount", 1, 1, definition.maxCasters));
  }
  if (definition.stats?.length) {
    for (const stat of definition.stats) settings.append(numberField(`演奏者 ${stat.toUpperCase()}`, stat, 90, 0, 999));
    settings.append(numberField(definition.lessonName, "lesson", 10, 0, 10));
  }
  select.onchange = () => {
    settings.hidden = settings.disabled = !select.checked;
    filterEffects(row.parentElement.id === "extra-buffs" ? "buff" : "status");
    updateBuffTabBadge();
  };
  row.append(label, settings);
  return row;
}

const effectLists = {buff: "extra-buffs", status: "monster-statuses"};

function filterEffects(type) {
  const term = $(`${type}-filter`).value.trim().normalize("NFKC").toLowerCase();
  const rows = [...$(effectLists[type]).children];
  let visible = 0, selected = 0, hiddenSelected = 0;
  for (const row of rows) {
    const textMatch = `${row.dataset.name} ${row.dataset.effect}`.normalize("NFKC").toLowerCase().includes(term);
    const catMatch = type !== "buff" || buffCategoryFilter === "all" || row.dataset.category === buffCategoryFilter;
    const match = textMatch && catMatch;
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
  return [...$(container).children]
    .filter(row => row.querySelector(".effect-toggle").checked)
    .map(row => {
      const {level, seconds: duration, casterCount, ...performer} = Object.fromEntries(
        [...row.querySelectorAll("[data-parameter]")].map(input => [input.dataset.parameter, Number(input.value)])
      );
      return {id: row.dataset.effect, level, seconds: duration, casterCount, performer};
    });
}

function updateMonsterStatusSummary() {
  const summary = $("monster-status-summary");
  if (!summary) return;
  const checkedRows = [...$("monster-statuses").children].filter(row => row.querySelector(".effect-toggle").checked);
  if (!checkedRows.length) {
    summary.textContent = "怪物起始狀態（未設定）";
    return;
  }
  const names = checkedRows.map(row => row.dataset.name);
  summary.textContent = `怪物起始狀態（已套用 ${checkedRows.length} 項：${names.slice(0, 3).join("、")}${names.length > 3 ? "…" : ""}）`;
}

function updateBuffTabBadge() {
  const activeCount = $("active-buffs").querySelectorAll("input:checked").length;
  const manualCount = $("extra-buffs").querySelectorAll(".effect-toggle:checked").length;
  const total = activeCount + manualCount;
  const badge = $("tab-badge-buffs");
  badge.hidden = total === 0;
  badge.textContent = String(total);
  updateMonsterStatusSummary();
}

function syncActiveBuffControls() {
  const boxes = [...$("active-buffs").querySelectorAll('input[type="checkbox"]')];
  const total = boxes.length;
  const checkedBoxes = boxes.filter(box => box.checked);
  const checked = checkedBoxes.length;

  $("snapshot-buff-card").hidden = total === 0;
  $("quick-active-buffs-wrap").hidden = total === 0;
  $("active-buffs-all").disabled = total === 0 || checked === total;
  $("active-buffs-none").disabled = checked === 0;

  const quick = $("quick-active-buffs");
  quick.checked = total > 0 && checked === total;
  quick.indeterminate = checked > 0 && checked < total;
  $("quick-active-buffs-label").textContent = checked > 0 && checked < total
    ? `套用角色目前身上的 Buff（已選 ${checked}／${total} 項）`
    : `套用角色目前身上的 Buff（共 ${total} 項）`;
  $("snapshot-buff-summary").textContent = `匯入遊戲身上的 Buff（已選 ${checked}／${total} 項）`;

  const activeIds = new Set();
  const activeGroups = new Set();
  for (const box of checkedBoxes) {
    const entry = scenario?.active?.[Number(box.value)];
    if (!entry) continue;
    if (entry.id) activeIds.add(entry.id);
    if (entry.group) activeGroups.add(entry.group);
  }
  for (const row of $("extra-buffs").children) {
    const tag = row.querySelector(".effect-active-tag");
    if (!tag) continue;
    const sameId = activeIds.has(row.dataset.effect);
    const sameGroup = !sameId && Boolean(row.dataset.group && activeGroups.has(row.dataset.group));
    const active = sameId || sameGroup;
    row.classList.toggle("is-active-from-snapshot", active);
    tag.hidden = !active;
    if (sameId) tag.textContent = "身上已套用（勾選將覆蓋，不疊加）";
    else if (sameGroup) tag.textContent = "同類已套用（勾選將取代）";
  }
  updateBuffTabBadge();
}

function setAllActiveBuffs(checked) {
  for (const box of $("active-buffs").querySelectorAll('input[type="checkbox"]')) {
    box.checked = checked;
  }
  syncActiveBuffControls();
  scheduleStats();
}

function renderScenario() {
  const ammo = $("ammo-choice");
  const selected = ammo.value;
  ammo.replaceChildren(
    new Option("依換裝／目前裝備／補箭", ""),
    ...scenario.ammo.map(arrow => new Option(
      `${arrow.name} · ${element[arrow.element] ?? arrow.element} · ${arrow.quantity ? `背包 ${format(arrow.quantity)}` : "模擬 1,000"}${arrow.configured ? " · 換裝規則" : ""}`,
      arrow.id
    ))
  );
  if (scenario.ammo.some(arrow => String(arrow.id) === selected)) ammo.value = selected;
  ammo.disabled = !scenario.ammo.length;

  $("active-buffs").replaceChildren(...scenario.active.map(({index, name, level, remainingMs}) => {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = false;
    input.value = String(index);
    const rem = Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs < 1e12
      ? ` · 剩 ${seconds(remainingMs)}`
      : "";
    label.append(input, `${level ? `${name} Lv ${level}` : name}${rem}`);
    return label;
  }));

  if (!$("extra-buffs").children.length) {
    $("extra-buffs").replaceChildren(...scenario.buffs.map(d => effectRow(d, true)));
    $("monster-statuses").replaceChildren(...scenario.statuses.map(d => effectRow(d, false)));
  }
  syncActiveBuffControls();
  filterEffects("buff");
  filterEffects("status");
}

function readScenario() {
  return {
    includeActive: [...$("active-buffs").querySelectorAll("input:checked")].map(input => Number(input.value)),
    keepActiveBuffs: $("keep-active-buffs").checked,
    buffs: readEffects("extra-buffs"),
    statuses: readEffects("monster-statuses"),
    autoBuffs: $("auto-buffs").checked,
    ammoItemId: $("ammo-choice").value ? Number($("ammo-choice").value) : undefined,
  };
}

// =========================================================================
// Monsters, Mob Skill Tester, Prereq Hints & Live Read-Only Stats
// =========================================================================

let mobSkillListVersion = 0;
let mobSkillTestVersion = 0;

async function loadMobSkills(monsterId) {
  const tester = $("mob-skill-tester");
  const btnWrap = $("mob-skill-buttons");
  const resultBox = $("mob-skill-result");
  const ver = ++mobSkillListVersion;
  resultBox.hidden = true;
  if (!monsterId) {
    tester.hidden = true;
    return;
  }
  try {
    const list = await engine("mobSkills", {monsterId});
    if (ver !== mobSkillListVersion) return;
    if (!list?.length) {
      tester.hidden = true;
      return;
    }
    tester.hidden = false;
    btnWrap.replaceChildren(...list.map(entry => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mob-skill-btn";
      btn.dataset.key = entry.key;
      const label = entry.skill === "__normal__" ? entry.name : `${entry.name} Lv.${entry.lv}`;
      btn.append(label);
      if (entry.element && entry.element !== "neutral") {
        const elTag = document.createElement("span");
        elTag.className = "mob-skill-el";
        elTag.textContent = element[entry.element] ?? entry.element;
        btn.append(elTag);
      }
      btn.onclick = () => { void runMobSkillTest(monsterId, entry, btn); };
      return btn;
    }));
  } catch {
    if (ver === mobSkillListVersion) tester.hidden = true;
  }
}

async function runMobSkillTest(monsterId, entry, clickedBtn) {
  if (!snapshot) return;
  const ver = ++mobSkillTestVersion;
  for (const b of $("mob-skill-buttons").children) {
    b.classList.toggle("is-active", b === clickedBtn);
  }
  const resultBox = $("mob-skill-result");
  resultBox.hidden = false;
  resultBox.textContent = `正在測試「${entry.name}」的承傷（抽樣 200 次）…`;
  try {
    const res = await engine("testMobSkill", {
      monsterId,
      skill: entry.skill,
      lv: entry.lv,
      mode: $("mode").value,
      scenario: readScenario(),
    });
    if (ver !== mobSkillTestVersion) return;

    const head = document.createElement("div");
    head.className = "mob-skill-result-head";
    const title = document.createElement("strong");
    title.textContent = `${res.monsterName} · ${res.skillName}${res.skill === "__normal__" ? "" : ` Lv.${res.lv}`}`;
    const badge = document.createElement("span");
    const maxPct = res.maxHp > 0 ? (res.max / res.maxHp) * 100 : 0;
    const avgPct = res.maxHp > 0 ? (res.avgHit / res.maxHp) * 100 : 0;
    if (res.lethalCount > 0) {
      badge.className = "mob-skill-badge is-lethal";
      badge.textContent = `⚠ 一擊致死率 ${format(res.lethalRate)}%（最高為最大 HP 的 ${format(maxPct)}%）`;
    } else if (res.hits > 0) {
      badge.className = "mob-skill-badge is-safe";
      badge.textContent = `可承受（最高佔最大 HP ${format(maxPct)}%）`;
    } else {
      badge.className = "mob-skill-badge is-miss";
      badge.textContent = res.blocked > 0 ? "完全格擋／免疫" : "完全迴避／未命中";
    }
    head.append(title, badge);

    const metrics = document.createElement("div");
    metrics.className = "mob-skill-metrics";
    const mkMetric = (label, val) => {
      const box = document.createElement("div");
      box.className = "mob-skill-metric";
      const sp = document.createElement("span");
      sp.textContent = label;
      const st = document.createElement("strong");
      st.textContent = val;
      box.append(sp, st);
      return box;
    };
    const rangeStr = res.hits === 0
      ? "0（未命中）"
      : res.min === res.max ? format(res.min) : `${format(res.min)} ～ ${format(res.max)}`;
    const avgStr = res.hits === 0 ? "0" : `${format(res.avgHit)}（${format(avgPct)}% HP）`;
    const rateLabel = res.blocked > 0 ? "命中／迴避／格擋" : "命中／迴避";
    const rateStr = res.blocked > 0
      ? `${format(res.hitRate)}% ／ ${format(res.missRate)}% ／ ${format(res.blockRate)}%`
      : `${format(res.hitRate)}% ／ ${format(res.missRate)}%`;
    metrics.append(
      mkMetric("命中單次傷害", rangeStr),
      mkMetric("命中平均傷害", avgStr),
      mkMetric(rateLabel, rateStr),
      mkMetric("角色最大 HP", format(res.maxHp))
    );

    const meta = document.createElement("div");
    meta.className = "mob-skill-meta";
    const metaLines = [];
    if (res.ailments?.length) {
      metaLines.push(`可能附加狀態：${res.ailments.map(a => `${a.name} ${format(a.rate)}%`).join("、")}`);
    }
    if (res.sampleRolls?.length) {
      metaLines.push(`前 ${res.sampleRolls.length} 次實測：${res.sampleRolls.map(v => v > 0 ? format(v) : "未命中").join("、")}`);
    }
    meta.textContent = metaLines.join(" ｜ ");
    resultBox.replaceChildren(head, metrics, meta);
  } catch (error) {
    if (ver === mobSkillTestVersion) resultBox.textContent = `測試失敗：${error.message}`;
  }
}

function updateMonsterPreview() {
  const id = Number($("monster").value);
  const mob = targets.find(m => m.id === id);
  const box = $("selected-monster-preview");
  if (!mob) {
    box.hidden = true;
    $("mob-skill-tester").hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = `${mob.name}（Lv ${mob.lv} · #${mob.id}）${mob.boss ? " 👑 BOSS" : ""}`;
  const detail = document.createElement("span");
  detail.className = "muted";
  detail.textContent = `HP ${format(mob.hp)} · ${element[mob.element] ?? mob.element} ${mob.elementLv} · ${race[mob.race] ?? mob.race} · ${size[mob.size] ?? mob.size} · DEF ${mob.def}／MDEF ${mob.mdef}`;
  box.append(title, detail);
  if (mob.defenseSkills?.length) {
    const defRow = document.createElement("div");
    defRow.className = "monster-def-tags";
    const lbl = document.createElement("span");
    lbl.textContent = "防禦／自體技：";
    defRow.append(lbl);
    for (const sk of mob.defenseSkills) {
      const pill = document.createElement("span");
      pill.className = "monster-def-pill";
      pill.textContent = `${sk.name} Lv.${sk.lv}${sk.opening ? "（開場即放）" : ""}`;
      defRow.append(pill);
    }
    box.append(defRow);
  }
  void loadMobSkills(mob.id);
}

function fillMonsters() {
  const term = $("search").value.trim().normalize("NFKC").toLowerCase();
  const current = $("monster").value;
  const found = targets.filter(({id, name}) => String(id).includes(term) || name.toLowerCase().includes(term));
  $("monster").replaceChildren(
    new Option(found.length ? "請選擇怪物" : "沒有符合的怪物", ""),
    ...found.map(({name, lv, id, boss}) => new Option(`${name}${boss ? " [BOSS]" : ""} · Lv ${lv} · #${id}`, id))
  );
  if (found.some(({id}) => String(id) === current)) $("monster").value = current;
  else if (term && found.length === 1) $("monster").value = String(found[0].id);
  else if (!current && found.length) {
    const defaultMob = found.find(m => m.id === 1023) ?? found[0];
    if (defaultMob) $("monster").value = String(defaultMob.id);
  }
  updateMonsterPreview();
  scheduleStats();
}

const MONK_COMBO_CHAIN = ["MO_CHAINCOMBO", "MO_COMBOFINISH", "CH_TIGERFIST", "CH_CHAINCRUSH"];
const SPHERE_ATTACK_SKILLS = new Set([
  "MO_FINGEROFFENSIVE", "MO_INVESTIGATE", "MO_COMBOFINISH",
  "CH_TIGERFIST", "CH_CHAINCRUSH", "MO_EXTREMITYFIST", "CH_PALMSTRIKE",
]);
const EXPLOSION_ATTACK_SKILLS = new Set(["MO_EXTREMITYFIST", "CH_PALMSTRIKE"]);
const HIDING_ATTACK_SKILLS = new Set(["AS_GRIMTOOTH", "RG_RAID"]);
const PREREQ_LABEL = {
  MO_CHAINCOMBO: "連環全身掌",
  MO_COMBOFINISH: "猛龍誇強",
  CH_TIGERFIST: "伏虎拳",
};

function updateSkillPrereqHint() {
  const box = $("skill-prereq-hint");
  const description = $("skill-description");
  const skill = $("mode").value === "skill" ? skills.find(entry => entry.id === $("skill").value) : undefined;
  const level = Number($("skill-level").value) || 1;
  const text = skill?.descs?.[level - 1] ?? skill?.descs?.[0] ?? "";
  description.textContent = text;
  description.hidden = !text;
  if (!box || !snapshot || $("mode").value !== "skill") {
    if (box) box.hidden = true;
    return;
  }
  const sid = $("skill").value;
  if (!sid) {
    box.hidden = true;
    return;
  }
  const learned = snapshot.character.skills ?? {};
  const autoList = [];
  const warnList = [];
  const comboIdx = MONK_COMBO_CHAIN.indexOf(sid);
  const needsCombo = comboIdx >= 0;
  const needsExplosion = EXPLOSION_ATTACK_SKILLS.has(sid);
  const needsSpheres = needsExplosion || SPHERE_ATTACK_SKILLS.has(sid) || comboIdx >= 1;

  if (needsSpheres) {
    if ((learned.CH_SOULCOLLECT ?? 0) > 0) autoList.push(`狂蓄氣 Lv.${learned.CH_SOULCOLLECT}`);
    else if ((learned.MO_CALLSPIRITS ?? 0) > 0) autoList.push(`蓄氣 Lv.${learned.MO_CALLSPIRITS}`);
    else warnList.push("角色未學習「蓄氣」或「狂蓄氣」，將無法補充氣彈");
  }
  if (needsExplosion) {
    if ((learned.MO_EXPLOSIONSPIRITS ?? 0) > 0) autoList.push(`爆氣 Lv.${learned.MO_EXPLOSIONSPIRITS}`);
    else warnList.push("角色未學習「爆氣」，無法發動此技能");
  }
  if (needsCombo) {
    if ((learned.MO_TRIPLEATTACK ?? 0) > 0) autoList.push(`六合拳 Lv.${learned.MO_TRIPLEATTACK}（普攻觸發）`);
    else warnList.push("角色未學習「六合拳」，無法起手接續連技");
    for (let i = 0; i < comboIdx; i++) {
      const pid = MONK_COMBO_CHAIN[i];
      if ((learned[pid] ?? 0) > 0) autoList.push(`${PREREQ_LABEL[pid]} Lv.${learned[pid]}`);
      else warnList.push(`角色未學習前置連技「${PREREQ_LABEL[pid]}」`);
    }
  }
  if (sid === "WS_CARTTERMINATION") {
    if ((learned.WS_CARTBOOST ?? 0) > 0) autoList.push(`手推車加速 Lv.${learned.WS_CARTBOOST}`);
    else warnList.push("角色未學習「手推車加速」，無法施放手推車終結技");
  }
  if (HIDING_ATTACK_SKILLS.has(sid)) {
    if ((learned.TF_HIDING ?? 0) > 0) autoList.push(`隱匿 Lv.${learned.TF_HIDING}`);
    else warnList.push("角色未學習「隱匿」，無法施放此技能");
  }

  if (!autoList.length && !warnList.length) {
    box.hidden = true;
    return;
  }
  const parts = [];
  if (autoList.length) parts.push(`已自動搭配前置／連技：${autoList.join(" → ")}`);
  if (warnList.length) parts.push(`提醒：${warnList.join("；")}`);
  box.textContent = parts.join(" ｜ ");
  box.classList.toggle("is-warn", warnList.length > 0);
  box.hidden = false;
}

function fillLevels() {
  const skill = skills.find(entry => entry.id === $("skill").value);
  $("skill-level").replaceChildren(...Array.from({length: skill?.lv ?? 0}, (_, index) =>
    new Option(`Lv ${index + 1}`, index + 1)));
  if (skill) $("skill-level").value = String(skill.lv);
  updateSkillPrereqHint();
}

function renderAttackSkillSelector() {
  const prevSkill = $("skill").value;
  $("skill").replaceChildren(...skills.map(({id, name}) => new Option(name, id)));
  if (skills.some(s => s.id === prevSkill)) $("skill").value = prevSkill;
  $("mode").querySelector('option[value="skill"]').disabled = !skills.length;
  if (!skills.length && $("mode").value === "skill") $("mode").value = "auto";
  $("skill-fields").hidden = $("mode").value !== "skill";
  fillLevels();
}

let statsVersion = 0;
let statsTimeout;
function scheduleStats() {
  clearTimeout(statsTimeout);
  statsTimeout = setTimeout(() => { void showStats(); }, 130);
}

function clearStatsDisplay() {
  $("stats-caption").textContent = "尚未匯入角色";
  $("stats-kpi").replaceChildren();
  $("character-stats").replaceChildren();
  $("ammo-summary").textContent = "";
  $("equipment-list").replaceChildren();
}

function showEquipment({equipment, ammo, weaponType, attackElement, missingRuleAmmo}) {
  const arrow = ammo
    ? `${ammo.name} ×${format(ammo.quantity)} · 箭 ATK ${format(ammo.atk)} · ${element[ammo.element] ?? ammo.element}屬性${ammo.simulated ? "（模擬）" : ammo.manual ? "（手動）" : ammo.fromRule ? "（自動換裝）" : ammo.fromBag ? "（背包補）" : ""}`
    : weaponType === "bow" ? "目前使用弓，尚未選擇或裝備箭矢。" : "箭矢欄為空。";
  $("ammo-summary").textContent = `${arrow} ｜ 普攻屬性：${element[attackElement] ?? attackElement}` +
    (missingRuleAmmo ? `。換裝規則指定的 ${missingRuleAmmo} 無庫存。` : "");
  $("equipment-list").replaceChildren(...(equipment.length ? equipment.map(({slot, name, refine, broken, cards}) => {
    const row = document.createElement("li");
    row.textContent = `${slot} · ${refine ? `+${refine} ` : ""}${name}${broken ? "（損壞）" : ""}` +
      (cards.length ? ` · ${cards.join("、")}` : "");
    return row;
  }) : [Object.assign(document.createElement("li"), {textContent: "目前尚未穿戴任何裝備"})]));
}

async function showStats() {
  if (!snapshot) return;
  const version = ++statsVersion;
  try {
    const preview = await engine("character", {
      scenario: readScenario(), mode: $("mode").value, monsterId: Number($("monster").value) || 0,
    });
    if (version !== statsVersion) return;
    const {base, current, names, allocated, atkDetail, pet} = preview;
    const parts = [];
    if (pet) {
      parts.push(`寵物：${pet.name}${pet.loyal && pet.loyalText.length ? `（${pet.loyalText.join("、")}）` : pet.loyal ? "（忠誠）" : "（未忠誠）"}`);
    }
    parts.push(names.length ? names.join("、") : "無起始 Buff");
    $("stats-caption").textContent = parts.join(" · ");

    const atkFrontOrig = base["前 ATK"] ?? 0;
    const atkBackOrig = base["後 ATK"] ?? 0;
    const atkFrontAct = current?.["前 ATK"] ?? atkFrontOrig;
    const atkBackAct = current?.["後 ATK"] ?? atkBackOrig;
    const atkTotalDiff = (atkFrontAct + atkBackAct) - (atkFrontOrig + atkBackOrig);
    const atkTooltip = atkDetail
      ? `前 ATK（素質，不受體型修正）：${format(atkDetail.statusAtk)}\n後 ATK（武器 ${format(atkDetail.weaponAtk)} ＋ 裝備/Buff ${format(atkDetail.atkBonus)} ＋ 精煉 ${format(atkDetail.refineAtk)}）` +
        (atkDetail.overrefine > 0 ? `\n過精煉隨機加傷：+1～${format(atkDetail.overrefine)}` : "") +
        (atkDetail.arrowAtk > 0 ? `\n箭矢 ATK：${format(atkDetail.arrowAtk)}` : "") +
        (atkDetail.masteryAtk > 0 ? `\n武器修練固定傷害：+${format(atkDetail.masteryAtk)}` : "")
      : "";

    const kpiTiles = [];
    {
      const tile = document.createElement("div");
      tile.className = "stats-kpi-tile";
      tile.title = atkTooltip;
      const dt = document.createElement("dt");
      dt.textContent = "ATK（前 + 後）";
      const dd = document.createElement("dd");
      dd.textContent = `${format(atkFrontAct)} + ${format(atkBackAct)}`;
      if (atkTotalDiff !== 0) {
        const small = document.createElement("span");
        small.className = "delta-tag";
        small.dataset.direction = atkTotalDiff > 0 ? "up" : "down";
        small.textContent = `${atkTotalDiff > 0 ? "+" : "−"}${format(Math.abs(atkTotalDiff))}`;
        dd.append(small);
      }
      tile.append(dt, dd);
      kpiTiles.push(tile);
    }
    for (const {key, label} of [
      {key: "ASPD", label: "ASPD"},
      {key: "最大 HP", label: "HP"},
      {key: "CRIT", label: "CRIT"},
    ]) {
      const tile = document.createElement("div");
      tile.className = "stats-kpi-tile";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      const orig = base[key];
      const active = current?.[key] ?? orig;
      dd.textContent = format(active);
      if (active !== orig) {
        const diff = active - orig;
        const small = document.createElement("span");
        small.className = "delta-tag";
        small.dataset.direction = diff > 0 ? "up" : "down";
        small.textContent = `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))}`;
        dd.append(small);
      }
      tile.append(dt, dd);
      kpiTiles.push(tile);
    }
    $("stats-kpi").replaceChildren(...kpiTiles);

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
        value.title = `原始：${split(original)} ＝ ${format(original)}${active !== original ? `；變更後合計：${format(active)}` : ""}`;
        if (active !== original) {
          const diff = active - original;
          const badge = document.createElement("span");
          badge.className = "delta-tag";
          badge.textContent = `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))}`;
          badge.dataset.direction = diff > 0 ? "up" : "down";
          value.append(badge);
        }
      } else {
        value.textContent = format(original);
        if (key === "前 ATK" || key === "後 ATK" || key === "精煉 ATK") {
          cell.title = atkTooltip;
        }
        if (key === "精煉 ATK" && atkDetail?.overrefine > 0 && active === original) {
          value.textContent = `${format(original)} (+${format(atkDetail.overrefine)})`;
        }
        if (active !== original) {
          const updated = document.createElement("span");
          updated.className = "delta-tag";
          updated.textContent = `→ ${format(active)}`;
          updated.dataset.direction = active > original ? "up" : "down";
          value.append(updated);
        }
      }
      cell.append(label, value);
      return cell;
    }));

    showEquipment(preview);
  } catch (error) {
    if (version === statsVersion) $("stats-caption").textContent = error.message;
  }
}

async function applyLoadedSnapshot(nextSnapshot, {save = true, sourceLabel = ""} = {}) {
  $("fields").disabled = true;
  if ($("refresh")) $("refresh").disabled = true;
  statsVersion++;
  $("result").hidden = true;
  $("status").textContent = "正在載入角色資料…";
  try {
    await Promise.all([ensureTargets(), ensureJobNames()]);
    snapshot = normalizeSnapshot(nextSnapshot);
    const [nextSkills, nextScenario] = await Promise.all([engine("skills"), engine("scenario")]);
    skills = nextSkills;
    scenario = nextScenario;
    renderScenario();
    renderAttackSkillSelector();
    fillMonsters();
    updateHeaderRole();

    if (save && !isExtension) upsertSavedCharacter(snapshot);
    else if (!isExtension) renderSavedBar();

    if (!isExtension) $("import-drawer").hidden = true;
    $("fields").disabled = false;
    $("status").textContent = sourceLabel ? `已載入「${snapshot.character.name}」（${sourceLabel}）。` : "";
    await showStats();
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    if ($("refresh")) $("refresh").disabled = false;
  }
}

async function loadFromExtension() {
  $("fields").disabled = $("refresh").disabled = true;
  statsVersion++;
  $("result").hidden = true;
  $("status").textContent = "正在讀取遊戲分頁角色資料…";
  try {
    const [loadedSnap] = await Promise.all([readCharacterFromExtension(), ensureTargets(), ensureJobNames()]);
    await applyLoadedSnapshot(loadedSnap, {save: false});
  } catch (error) {
    $("role").textContent = "尚未讀取角色";
    $("status").textContent = error.message;
    $("refresh").disabled = false;
  }
}

function showDefense(defense, trials, invincible = false) {
  $("defense").hidden = !defense;
  if (!defense) return;
  $("taken").textContent = format(defense.averageDamage);
  $("incoming-dps").textContent = format(defense.damagePerSecond);
  $("survival").textContent = invincible
    ? `角色不死模式（HP 最低維持 1）· 期末平均 HP ${format(defense.endingHp)}`
    : `存活 ${trials - defense.deaths}／${trials} 次 · 期末平均 HP ${format(defense.endingHp)}` +
      (defense.averageDeath === null ? "" : ` · 倒下樣本平均撐 ${seconds(defense.averageDeath)}`);
  $("incoming-sources").textContent = defense.received.length
    ? `平均承傷來源：${defense.received.map(({name, average}) => `${name} ${format(average)}`).join(" · ")}`
    : "這些樣本中沒有受到怪物傷害。";
}

function showTimeline(timeline, total) {
  $("timeline-title").textContent = total > timeline.length
    ? `對戰紀錄 · 第 1 次模擬（前 ${timeline.length} 筆）`
    : "對戰紀錄 · 第 1 次模擬";
  $("timeline").replaceChildren(...timeline.map(({at, text, hp, sp, kind}) => {
    const row = document.createElement("li");
    row.dataset.kind = kind;
    const time = document.createElement("time");
    time.textContent = (at / 1000).toFixed(2).padStart(6, "0");
    const content = document.createElement("span");
    content.textContent = text;
    const health = document.createElement("span");
    health.className = "log-hp";
    health.textContent = `HP ${format(hp)} · SP ${format(sp)}`;
    row.append(time, content, health);
    return row;
  }));
}

function renderSongEffects(songs) {
  const block = $("song-effects");
  block.hidden = !songs.length;
  const labels = {flee:"迴避", perfectDodge:"完全迴避", songHaste:"攻速加成", castRate:"詠唱時間",
    delayRate:"施放延遲", maxHpRate:"最大 HP", hit:"命中", crit:"暴擊", maxSpRate:"最大 SP", useSpRate:"SP 消耗"};
  const percent = new Set(["perfectDodge", "songHaste", "castRate", "delayRate", "maxHpRate", "maxSpRate", "useSpRate"]);
  $("song-breakdown").replaceChildren(...songs.map(song => {
    const row = document.createElement("li");
    const effects = Object.entries(song.bonuses).map(([key, value]) =>
      `${labels[key] ?? key} ${value >= 0 ? "+" : ""}${format(value)}${percent.has(key) ? "%" : ""}`);
    if (song.heal > 0) effects.push(`每 ${seconds(song.interval)}回復 ${format(song.heal)} HP`);
    row.textContent = `${song.name} · ${effects.join("、")}`;
    return row;
  }));
}

function show(result) {
  const {monster, panel, lines} = result;
  $("target").textContent = `${monster.name} · Lv ${monster.lv}`;
  $("monster-stats").textContent = `HP ${format(monster.hp)} · ${element[panel.elementTarget] ?? panel.elementTarget} ${panel.elementLvTarget} · ${race[monster.race] ?? monster.race} · ${size[monster.size]} · DEF ${format(panel.def)}／MDEF ${format(panel.mdef)}`;
  $("dps").textContent = format(result.dps);
  $("ttk").textContent = result.averageKill == null ? "未擊殺" : seconds(result.averageKill);
  $("kpi-cardrate").textContent = `×${format(panel.cardRate)}`;
  $("kpi-combat").textContent = `${format(panel.hit)}% ／ ${format(panel.crit)}% ／ ${format(panel.aspd)}`;
  $("summon-dps-grid").hidden = result.summons.count === 0;
  $("summon-dps").textContent = format(result.summons.dps);
  $("combined-dps").textContent = format(result.summons.totalDps);
  $("summon-summary").hidden = result.summons.count === 0;
  $("summon-summary").textContent = `${result.trials} 次合計召喚 ${format(result.summons.count)} 隻、擊倒 ${format(result.summons.kills)} 隻`;
  $("summary").textContent = `${result.trials} 次 × ${result.seconds} 秒 · ${result.killedTrials} 次完成首殺 · 期末平均 SP ${format(result.endingSp)}${result.mobDefense ? " · 含怪物防禦技" : " · 關閉怪物防禦技"}${result.invincible ? " · 角色不死" : ""}`;
  $("combat-stats").textContent = `起始普攻：${element[panel.element] ?? panel.element}屬性 ×${format(panel.modifier / 100)} · 攻擊間隔 ${seconds(panel.interval)}`;
  const normalAttacks = result.normalAttacks;
  if (normalAttacks?.doubleProcs) {
    $("combat-stats").append(document.createElement("br"),
      `二刀連擊：觸發 ${format(normalAttacks.doubleProcs)} 次，命中 ${format(normalAttacks.doubleLanded)} 次（${result.trials} 次試算合計）`);
  }
  if (normalAttacks?.right && normalAttacks.left) {
    const handRange = ({min, max}) => min === max ? format(min) : `${format(min)}～${format(max)}`;
    $("combat-stats").append(document.createElement("br"),
      `雙持單次傷害（防禦技能結算前）：右手 ${handRange(normalAttacks.right)} ／ 左手 ${handRange(normalAttacks.left)}`);
  }

  const share = lines.reduce((sum, entry) => sum + entry.share, 0);
  const displayed = result.dps > 0 && share < 0.999 ? [...lines, {name: "其他傷害", share: 1 - share, casts: 0}] : lines;
  $("damage").replaceChildren(...displayed.map(entry => {
    const row = document.createElement("tr");
    const timing = entry.casts ? [entry.castMs, entry.delayMs, entry.cooldownMs]
      .map(value => seconds(value / entry.casts)).join("／") : "—";
    const range = hit => hit.min === hit.max ? format(hit.min) : `${format(hit.min)}～${format(hit.max)}`;
    const damage = [entry.normal && `一般 ${range(entry.normal)}`, entry.critical && `爆擊 ${range(entry.critical)}`]
      .filter(Boolean).join("\n") || "—";

    const c1 = document.createElement("td");
    c1.textContent = entry.name;

    const c2 = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "share-bar-wrap";
    const pct = Math.max(0, Math.min(100, entry.share * 100));
    const bar = document.createElement("div");
    bar.className = "share-bar";
    const fill = document.createElement("div");
    fill.className = "share-bar-fill";
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.append(fill);
    const pctText = document.createElement("span");
    pctText.textContent = `${format(pct)}%`;
    wrap.append(bar, pctText);
    c2.append(wrap);

    const c3 = document.createElement("td");
    c3.textContent = damage;

    const c4 = document.createElement("td");
    c4.textContent = timing;

    row.append(c1, c2, c3, c4);
    return row;
  }));
  renderSongEffects(result.songs);
  showDefense(result.defense, result.trials, result.invincible);
  showTimeline(result.timeline, result.timelineCount);
  $("result").hidden = false;
  $("result").scrollIntoView({behavior: "smooth", block: "nearest"});
}

// =========================================================================
// Event Wiring
// =========================================================================

$("theme-toggle").onclick = () => {
  const isDark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
};

$("mobile-stats-toggle").onclick = () => {
  const sidebar = $("character-panel");
  const expanded = sidebar.classList.toggle("is-expanded");
  $("mobile-stats-toggle").setAttribute("aria-expanded", String(expanded));
  $("mobile-stats-toggle").textContent = expanded ? "收合完整能力" : "展開完整能力";
};

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.onclick = () => switchTab(btn.dataset.tab);
}

$("scenario").addEventListener("input", event => {
  if (event.target.closest("#active-buffs")) syncActiveBuffControls();
  if (event.target.type !== "search") scheduleStats();
});
$("monster-statuses").addEventListener("input", event => {
  if (event.target.type !== "search") scheduleStats();
  updateMonsterStatusSummary();
});
$("quick-active-buffs").onchange = () => setAllActiveBuffs($("quick-active-buffs").checked);
$("keep-active-buffs").onchange = scheduleStats;
$("active-buffs-all").onclick = () => setAllActiveBuffs(true);
$("active-buffs-none").onclick = () => setAllActiveBuffs(false);
$("buff-filter").oninput = () => filterEffects("buff");
$("status-filter").oninput = () => filterEffects("status");

for (const pill of document.querySelectorAll("[data-buff-cat]")) {
  pill.onclick = () => {
    buffCategoryFilter = pill.dataset.buffCat;
    for (const p of document.querySelectorAll("[data-buff-cat]")) p.classList.toggle("is-active", p === pill);
    filterEffects("buff");
  };
}
$("clear-manual-buffs").onclick = () => {
  for (const row of $("extra-buffs").children) {
    const cb = row.querySelector(".effect-toggle");
    if (cb.checked) {
      cb.checked = false;
      const fs = row.querySelector(".effect-parameters");
      fs.hidden = fs.disabled = true;
    }
  }
  filterEffects("buff");
  updateBuffTabBadge();
  scheduleStats();
};
$("clear-monster-statuses").onclick = () => {
  for (const row of $("monster-statuses").children) {
    const cb = row.querySelector(".effect-toggle");
    if (cb.checked) {
      cb.checked = false;
      const fs = row.querySelector(".effect-parameters");
      fs.hidden = fs.disabled = true;
    }
  }
  filterEffects("status");
  updateBuffTabBadge();
  scheduleStats();
};

$("ammo-choice").onchange = scheduleStats;
$("search").oninput = fillMonsters;
$("monster").onchange = () => { updateMonsterPreview(); scheduleStats(); };
$("skill").onchange = fillLevels;
$("skill-level").addEventListener("change", updateSkillPrereqHint);
$("mode").onchange = () => {
  $("skill-fields").hidden = $("mode").value !== "skill";
  updateSkillPrereqHint();
  scheduleStats();
};
$("invincible").onchange = () => { if ($("invincible").checked) $("counterattack").checked = true; };
function syncSoulChangeFields() {
  const disabled = !$("soul-change").checked;
  $("soul-change-options").hidden = disabled;
  const trigger = $("soul-change-trigger");
  trigger.disabled = disabled;
  const threshold = trigger.value === "threshold";
  for (const [id, show] of [["soul-change-interval", !threshold], ["soul-change-threshold", threshold]]) {
    const input = $(id);
    input.parentElement.hidden = !show;
    input.disabled = disabled || !show;
  }
  for (const id of ["soul-change-dex", "soul-change-hp", "soul-change-sp", "soul-change-min-sp", "soul-change-heal-amount"]) {
    $(id).disabled = disabled;
  }
  $("soul-change-heal-interval").disabled = disabled || Number($("soul-change-heal-amount").value) === 0;
  $("soul-change-min-sp").max = $("soul-change-sp").value;
}
$("soul-change").addEventListener("change", syncSoulChangeFields);
$("soul-change-trigger").addEventListener("change", syncSoulChangeFields);
$("soul-change-sp").addEventListener("input", syncSoulChangeFields);
$("soul-change-heal-amount").addEventListener("input", syncSoulChangeFields);
syncSoulChangeFields();

$("counterattack").onchange = () => { if (!$("counterattack").checked) $("invincible").checked = false; };

$("calculator").addEventListener("invalid", event => {
  const row = event.target.closest(".effect-row");
  if (!row) return;
  const isStatus = row.parentElement.id === "monster-statuses";
  if (isStatus) {
    switchTab("simulate");
    $("monster-status-details").open = true;
  } else {
    switchTab("buffs");
  }
  if (!row.hidden) return;
  const type = isStatus ? "status" : "buff";
  $(`${type}-filter`).value = "";
  if (type === "buff") buffCategoryFilter = "all";
  filterEffects(type);
}, true);

let simulationSeed;
$("calculator").onsubmit = async event => {
  event.preventDefault();
  if (!snapshot) return;
  if (!$("monster").value) {
    $("status").textContent = "請先選擇目標怪物。";
    return;
  }
  const options = {
    monsterId: Number($("monster").value),
    seed: simulationSeed,
    mode: $("mode").value,
    skill: $("skill").value,
    level: Number($("skill-level").value),
    seconds: Number($("seconds").value),
    mobDefense: $("mob-defense").checked,
    counterattack: $("counterattack").checked,
    invincible: $("invincible").checked,
    soulChange: $("soul-change").checked ? {
      ...($("soul-change-trigger").value === "threshold"
        ? {spBelow: Number($("soul-change-threshold").value)}
        : {interval: Number($("soul-change-interval").value)}),
      casterDex: Number($("soul-change-dex").value),
      casterMaxHp: Number($("soul-change-hp").value),
      casterMaxSp: Number($("soul-change-sp").value),
      casterMinSp: Number($("soul-change-min-sp").value),
      healAmount: Number($("soul-change-heal-amount").value),
      healInterval: Number($("soul-change-heal-interval").value),
    } : undefined,
    scenario: readScenario(),
  };
  $("fields").disabled = true;
  if ($("refresh")) $("refresh").disabled = true;
  $("result").hidden = true;
  $("status").textContent = "正在本機模擬 16 場戰鬥…";
  try {
    if (event.submitter?.id === "reroll") {
      const nextSeed = crypto.getRandomValues(new Uint32Array(1))[0];
      options.seed = nextSeed === (simulationSeed ?? 91237) ? (nextSeed + 1) >>> 0 : nextSeed;
    }
    const result = await engine("simulate", options);
    simulationSeed = result.seed;
    show(result);
    $("summary").append(` · 亂數種子 ${result.seed}`);
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("fields").disabled = false;
    if ($("refresh")) $("refresh").disabled = false;
  }
};

// =========================================================================
// Web Mode Setup (Bookmarklet Import Only)
// =========================================================================

function setupWebMode() {
  $("back-route").hidden = false;
  $("toggle-import").hidden = false;

  $("toggle-import").onclick = () => {
    const drawer = $("import-drawer");
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) drawer.scrollIntoView({behavior: "smooth", block: "nearest"});
  };
  $("close-import").onclick = () => { $("import-drawer").hidden = true; };

  const isHttp = location.protocol === "http:" || location.protocol === "https:";
  const pageUrl = `${location.origin}${location.pathname}`;
  const bookmarkletHref = buildBookmarklet(pageUrl);
  $("bookmarklet-link").href = bookmarkletHref;
  $("bookmarklet-link").onclick = event => {
    event.preventDefault();
    $("copy-status").textContent = "請把此按鈕拖曳到書籤列，或點左邊「複製書籤程式碼」。";
  };
  if (!isHttp) {
    $("bookmarklet-origin-hint").textContent = "目前是以本機檔案開啟，書籤跨分頁傳送需要透過 https://（如 GitHub Pages）或 localhost 網址開啟。";
  }

  $("copy-bookmarklet").onclick = async () => {
    try {
      await navigator.clipboard.writeText(bookmarkletHref);
      $("copy-status").textContent = "已複製書籤程式碼！請貼到新書籤的網址欄。";
    } catch {
      prompt("請手動複製下方書籤程式碼：", bookmarkletHref);
    }
  };

  $("saved-character").onchange = async () => {
    const key = $("saved-character").value;
    if (!key) return;
    const found = savedCharacters.find(entry => entry.key === key);
    if (!found) return;
    activeSavedKey = found.key;
    await applyLoadedSnapshot(found.snapshot, {save: false, sourceLabel: "已匯入角色"});
  };

  $("delete-saved").onclick = async () => {
    if (!activeSavedKey) return;
    savedCharacters = savedCharacters.filter(entry => entry.key !== activeSavedKey);
    persistSavedList();
    if (savedCharacters.length) {
      const next = savedCharacters[0];
      activeSavedKey = next.key;
      renderSavedBar();
      await applyLoadedSnapshot(next.snapshot, {save: false, sourceLabel: "已切換角色"});
    } else {
      activeSavedKey = "";
      snapshot = null;
      renderSavedBar();
      updateHeaderRole();
      clearStatsDisplay();
      $("fields").disabled = true;
      $("result").hidden = true;
      $("import-drawer").hidden = false;
      $("status").textContent = "已清除所有角色紀錄，請透過上方書籤小工具從 ro-idle.app 匯入角色。";
    }
  };

  window.addEventListener("message", event => {
    if (event.origin !== host) return;
    if (event.data?.type !== "ro-dps-snapshot" || !event.data.snapshot) return;
    try { event.source?.postMessage({type: "ro-dps-ack"}, event.origin); } catch {}
    if (location.hash === "#waiting") history.replaceState(null, "", location.pathname + location.search);
    void applyLoadedSnapshot(event.data.snapshot, {save: true, sourceLabel: "從遊戲分頁傳送"});
  });

  window.addEventListener("hashchange", async () => {
    try {
      const fromHash = await decodeHashSnapshot();
      if (fromHash) await applyLoadedSnapshot(fromHash, {save: true, sourceLabel: "從遊戲分頁傳送"});
    } catch (error) {
      $("status").textContent = error.message;
    }
  });

  if (window.opener) {
    try { window.opener.postMessage({type: "ro-dps-ready"}, host); } catch {}
  }
}

async function init() {
  try {
    if (isExtension) {
      $("refresh").hidden = false;
      $("refresh").onclick = loadFromExtension;
      await loadFromExtension();
      return;
    }

    setupWebMode();
    savedCharacters = loadSavedList();
    renderSavedBar();
    $("role").textContent = "正在載入戰鬥引擎…";

    await Promise.all([ensureTargets(), ensureJobNames()]);

    try {
      const fromHash = await decodeHashSnapshot();
      if (fromHash) {
        await applyLoadedSnapshot(fromHash, {save: true, sourceLabel: "從遊戲分頁傳送"});
        return;
      }
    } catch (error) {
      $("status").textContent = error.message;
    }

    if (location.hash === "#waiting") {
      $("role").textContent = "正在等待遊戲分頁傳送角色…";
      $("status").textContent = "正在接收來自 ro-idle.app 的角色快照…";
      return;
    }

    if (savedCharacters.length) {
      const first = savedCharacters[0];
      activeSavedKey = first.key;
      renderSavedBar();
      await applyLoadedSnapshot(first.snapshot, {save: false, sourceLabel: "已匯入角色"});
    } else {
      $("role").textContent = "尚未匯入角色";
      $("import-drawer").hidden = false;
      $("status").textContent = "請先建立上方「書籤小工具」，並於 ro-idle.app 遊戲分頁點選傳送角色。";
    }
  } catch (error) {
    $("role").textContent = "初始化失敗";
    $("status").textContent = error?.message ?? String(error);
  }
}

void init();
