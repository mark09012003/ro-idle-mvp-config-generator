const $ = id => document.getElementById(id);
const ASSET_VER = "20261127-14";
const MAX_REBIRTHS = 11;
const EXTRA_STAT_PER_REBIRTH = 20;
const host = "https://ro-idle.app";
const gameTab = new URL(location.href).searchParams.get("gameTab");
const isExtension = Boolean(globalThis.chrome?.scripting && gameTab);
const SAVED_STORAGE_KEY = "ro-idle-dps-saved-characters-v1";
const THEME_STORAGE_KEY = "ro-idle-dps-theme";
const SKILL_VIEW_STORAGE_KEY = "ro-idle-dps-skill-view";
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
const weaponTypeLabel = {
  "1hSword":"單手劍", "2hSword":"雙手劍", dagger:"短劍", katar:"拳刃",
  "1hAxe":"單手斧", "2hAxe":"雙手斧", "1hSpear":"單手矛", "2hSpear":"雙手矛",
  "2hStaff":"雙手杖", mace:"鈍器", book:"書本", staff:"單手杖",
  bow:"弓", knuckle:"拳套", instrument:"樂器", whip:"鞭子",
};
const STAT_KEYS = ["str", "agi", "vit", "int", "dex", "luk"];
const TWO_HANDED_TYPES = new Set(["2hSword", "2hSpear", "2hAxe", "2hMace", "2hStaff", "bow", "katar"]);
const LEFT_HAND_TYPES = new Set(["dagger", "1hSword", "1hAxe"]);
const HEAD_SLOTS = ["headTop", "headMid", "headLow"];
const RIDING_JOBS = new Set(["knight", "lord_knight", "crusader", "paladin"]);
const FALCON_JOBS = new Set(["hunter", "sniper"]);
const NORMAL_TO_UPPER = {
  novice:"novice_high", swordman:"swordman_high", mage:"mage_high", archer:"archer_high",
  acolyte:"acolyte_high", thief:"thief_high", merchant:"merchant_high",
  knight:"lord_knight", wizard:"high_wizard", hunter:"sniper", assassin:"assassin_cross",
  priest:"high_priest", blacksmith:"whitesmith", crusader:"paladin", monk:"champion",
  rogue:"stalker", sage:"professor", bard:"clown", dancer:"gypsy", alchemist:"creator",
};
const UPPER_TO_NORMAL = Object.fromEntries(Object.entries(NORMAL_TO_UPPER).map(([a, b]) => [b, a]));
const ELEMENT_BUFF_IDS = new Set([
  "PR_ASPERSIO", "AS_ENCHANTPOISON", "SA_FLAMELAUNCHER", "SA_FROSTWEAPON",
  "SA_LIGHTNINGLOADER", "SA_SEISMICWEAPON", "itemEndowWater",
]);
const ITEM_BUFF_PREFIXES = ["aspdPotion", "resist", "strFood", "agiFood", "vitFood", "intFood", "dexFood", "lukFood"];

let worker, snapshot, originalImportedSnapshot = null;
let scenario, equipCatalog, builderInfo, targets = [], skills = [], sequence = 0;
let equipOverrides = {};
let selectedSlot = null;
let itemMap = new Map();
let cardMap = new Map();
let jobMap = new Map();
let petMap = new Map();
let savedCharacters = [];
let activeSavedKey = "";
let activeTab = "build";
let currentIsCustom = true;
let currentRebirths = 1;
let currentFirstJobLv = 50;
let skillFilterMode = "all";
let skillViewMode = (() => {
  try {
    const saved = localStorage.getItem(SKILL_VIEW_STORAGE_KEY);
    return saved === "list" || saved === "tree" ? saved : "tree";
  } catch {
    return "tree";
  }
})();
let selectedSkillId = null;
let buffCategoryFilter = "all";
let lastPreview = null;
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
    directEnginePromise = import(`../RO-idle-dps/engine.js?v=${ASSET_VER}`);
  }
  const eng = await directEnginePromise;
  return {
    targets: () => eng.targets,
    builder: () => eng.builderCatalog(),
    skills: () => eng.attackSkills(snapshot),
    scenario: () => eng.scenarioCatalog(snapshot),
    equipment: () => eng.equipmentCatalog(snapshot),
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

function ensureBuilder() {
  if (builderInfo) return Promise.resolve(builderInfo);
  if (!builderPromise) {
    builderPromise = engine("builder")
      .then(info => {
        builderInfo = info;
        jobMap = new Map(info.jobs.map(j => [j.id, j]));
        petMap = new Map((info.pets ?? []).map(p => [p.mob, p]));
        return info;
      })
      .catch(error => { builderPromise = null; throw error; });
  }
  return builderPromise;
}

// =========================================================================
// RO-idle Authentic Formulas for Stat & Skill Points
// =========================================================================

function statStepCost(currentVal) {
  return Math.floor((currentVal - 1) / 10) + 2;
}

function totalStatPointsFor(baseLv, rebirths) {
  const rb = Math.max(0, Math.min(MAX_REBIRTHS, Math.trunc(rebirths || 0)));
  let pts = rb === 0 ? 48 : 100 + (rb - 1) * EXTRA_STAT_PER_REBIRTH;
  const lv = Math.max(1, Math.min(99, Math.trunc(baseLv)));
  for (let i = 1; i < lv; i++) pts += Math.floor(i / 5) + 3;
  return pts;
}

function spentStatPoints(stats) {
  let spent = 0;
  for (const key of STAT_KEYS) {
    const val = Math.max(1, Math.min(99, Math.trunc(stats[key] ?? 1)));
    for (let v = 1; v < val; v++) spent += statStepCost(v);
  }
  return spent;
}

function totalSkillPointsFor(jobDef, jobLv, firstJobLv) {
  if (!jobDef) return 0;
  const jlv = Math.max(1, Math.min(jobDef.maxJobLv, Math.trunc(jobLv)));
  if (jobDef.tier === 0) return jlv - 1;
  if (jobDef.tier === 1) return 9 + (jlv - 1);
  const fLv = Math.max(40, Math.min(50, Math.trunc(firstJobLv || 50)));
  return 9 + (fLv - 1) + (jlv - 1);
}

function spentSkillPoints(jobDef, skillMap) {
  if (!jobDef) return 0;
  let total = 0;
  for (const entry of jobDef.skillTree) {
    if (entry.questJobLv != null) continue;
    total += Math.max(0, Math.min(entry.maxLv, Math.trunc(skillMap[entry.id] ?? 0)));
  }
  return total;
}

function createCustomSnapshot({
  name = "自訂角色",
  job = "lord_knight",
  rebirths = 1,
  baseLv = 99,
  jobLv = 70,
  firstJobLv = 50,
} = {}) {
  const jobDef = jobMap.get(job) ?? builderInfo?.jobs.find(j => j.id === "lord_knight") ?? builderInfo?.jobs[0];
  const jId = jobDef?.id ?? "lord_knight";
  const maxJL = jobDef?.maxJobLv ?? 70;
  const clampedJL = Math.min(maxJL, Math.max(1, jobLv));
  const defaultSkills = {};
  if (jobDef) {
    if (jobDef.skillTree.some(s => s.id === "NV_BASIC")) defaultSkills.NV_BASIC = 9;
    for (const s of jobDef.skillTree) {
      if (s.questJobLv != null && clampedJL >= s.questJobLv) defaultSkills[s.id] = s.maxLv;
    }
  }
  const config = builderInfo?.defaultConfig
    ? structuredClone(builderInfo.defaultConfig)
    : {lockMap: "prt_fild08", skills: [], equipRules: []};
  config.skills = [];
  config.equipRules = [];
  return {
    character: {
      name,
      job: jId,
      baseLv: Math.max(1, Math.min(99, baseLv)),
      baseExp: 0,
      jobLv: clampedJL,
      jobExp: 0,
      statPoints: totalStatPointsFor(baseLv, rebirths),
      skillPoints: totalSkillPointsFor(jobDef, clampedJL, firstJobLv),
      stats: {str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1},
      hp: 999999,
      sp: 999999,
      zeny: 0,
      skills: defaultSkills,
      ...(RIDING_JOBS.has(jId) ? {riding: false} : {}),
      ...(FALCON_JOBS.has(jId) ? {falcon: false} : {}),
    },
    inventory: [],
    equipment: {},
    buffs: [],
    ailments: [],
    cart: null,
    config,
    mapId: "prt_fild08",
    heldItems: [],
    pet: null,
  };
}

// =========================================================================
// Snapshot Storage & Cross-Tab Import
// =========================================================================

function normalizeSnapshot(raw) {
  const s = raw?.snapshot?.character ? raw.snapshot : raw;
  if (!s || typeof s !== "object" || !s.character?.name || !s.config || !Array.isArray(s.inventory) || !s.equipment) {
    throw new Error("角色快照格式不完整，請確認複製的是 /api/characters/ID?deferCatchup=1 的完整 JSON，或是本工具匯出的配點檔。");
  }
  const {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet} = s;
  return {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet};
}

function charStorageKey(snap, isCustom) {
  return `${isCustom ? "custom" : "import"}::${snap.character.name}::${snap.character.job ?? ""}`;
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
  } catch {
    // Ignore storage quota errors cleanly.
  }
}

function upsertSavedCharacter(snap, {isCustom = false, rebirths, firstJobLv, overrides, preserveKey} = {}) {
  const key = preserveKey || charStorageKey(snap, isCustom);
  const jobDef = jobMap.get(snap.character.job);
  const inferredRebirths = rebirths ?? (jobDef?.upper ? 1 : 0);
  const entry = {
    key,
    name: snap.character.name,
    baseLv: snap.character.baseLv,
    jobLv: snap.character.jobLv,
    job: snap.character.job ?? "",
    jobName: jobDef?.name ?? snap.character.job ?? "",
    rebirths: inferredRebirths,
    firstJobLv: firstJobLv ?? 50,
    isCustom: Boolean(isCustom),
    savedAt: Date.now(),
    snapshot: structuredClone(snap),
    equipOverrides: overrides ? structuredClone(overrides) : {},
  };
  savedCharacters = [entry, ...savedCharacters.filter(item => item.key !== key)].slice(0, 30);
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
    sel.replaceChildren(new Option("（目前為暫存自訂角色，點右側「儲存配點」保留）", ""));
    $("delete-saved").disabled = true;
    return;
  }
  sel.replaceChildren(...savedCharacters.map(entry => {
    const tag = entry.isCustom ? "[自訂]" : "[匯入]";
    const jName = entry.jobName || jobMap.get(entry.job)?.name || entry.job;
    return new Option(
      `${tag} ${entry.name} · ${jName} · Lv ${entry.baseLv}/${entry.jobLv} · ${formatTimeShort(entry.savedAt)}`,
      entry.key
    );
  }));
  if (savedCharacters.some(entry => entry.key === activeSavedKey)) {
    sel.value = activeSavedKey;
    $("delete-saved").disabled = false;
  } else {
    sel.prepend(new Option(`（未儲存）${snapshot?.character?.name ?? "自訂角色"}`, ""));
    sel.value = "";
    $("delete-saved").disabled = true;
  }
}

function asciiEscape(str) {
  return str.replace(/[^\x20-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function buildBookmarklet(targetUrl) {
  const code = `(async()=>{const U=${JSON.stringify(targetUrl)};if(location.origin!=="https://ro-idle.app"){alert("請先切換到 https://ro-idle.app 遊戲分頁再執行此書籤。");return;}const w=window.open(U+"#waiting","ro_idle_dps");try{const g=async p=>{const r=await fetch(p,{credentials:"same-origin"});if(!r.ok)throw new Error("HTTP "+r.status);return r.json();};const {characters}=await g("/api/characters");if(!characters?.length)throw new Error("找不到角色，請確認已登入遊戲。");const c=[...document.querySelectorAll(".xp-title .caption")].map(n=>n.textContent.trim().match(/^RO放置仙境 - \\[(.+)\\] .+ Lv\\.\\d+ \\/ Job \\d+$/)?.[1]).find(Boolean);const m=document.querySelector('.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child');const mt=m&&[...m.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join("").trim();const cur=c||mt;const hit=cur?characters.filter(x=>x.name===cur):[];let t=hit.length===1?hit[0]:characters.length===1?characters[0]:null;if(!t){const pick=prompt("請輸入要載入的角色編號：\\n"+characters.map((x,i)=>(i+1)+". "+x.name+" (Lv."+(x.baseLv??"?")+")").join("\\n"),"1");if(pick===null){w?.close();return;}t=characters[Number(pick)-1];if(!t)throw new Error("角色編號無效。");}const v=await g("/api/characters/"+t.id+"?deferCatchup=1");const s=v.snapshot;if(!s?.character)throw new Error("角色快照不完整。");const snap={character:s.character,inventory:s.inventory,equipment:s.equipment,buffs:s.buffs,ailments:s.ailments,cart:s.cart,config:s.config,mapId:s.mapId,heldItems:s.heldItems,pet:s.pet};const o=new URL(U).origin;let ok=false;const onM=e=>{if(e.origin!==o)return;if(e.data?.type==="ro-dps-ready")w?.postMessage({type:"ro-dps-snapshot",snapshot:snap},o);if(e.data?.type==="ro-dps-ack"){ok=true;removeEventListener("message",onM);}};addEventListener("message",onM);if(w&&!w.closed){w.postMessage({type:"ro-dps-snapshot",snapshot:snap},o);for(let i=0;i<16&&!ok;i++){await new Promise(r=>setTimeout(r,250));if(!ok&&!w.closed)w.postMessage({type:"ro-dps-snapshot",snapshot:snap},o);}}removeEventListener("message",onM);if(ok)return;let h="";if(typeof CompressionStream==="function"){const cs=new CompressionStream("gzip");const wr=cs.writable.getWriter();wr.write(new TextEncoder().encode(JSON.stringify(snap)));wr.close();const b=new Uint8Array(await new Response(cs.readable).arrayBuffer());let bin="";for(let i=0;i<b.length;i+=32768)bin+=String.fromCharCode(...b.subarray(i,i+32768));h="#gz="+btoa(bin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}if(w&&!w.closed&&h&&h.length<60000){w.location.href=U+h;return;}if(h&&h.length<60000){location.href=U+h;return;}await navigator.clipboard.writeText(JSON.stringify(snap));alert("已複製角色 JSON，請切回 DPS 試算網頁貼上載入。");}catch(e){alert("讀取角色失敗："+(e?.message||e));}})();`;
  return `javascript:${asciiEscape(code)}`;
}

async function decodeHashSnapshot() {
  const hash = location.hash;
  if (!hash || hash === "#waiting") return null;
  if (hash.startsWith("#gz=")) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("此瀏覽器不支援解壓縮書籤資料，請改用「方式二：貼上 JSON」。");
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
  if (hash.startsWith("#snap=")) {
    const b64 = hash.slice(6).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder().decode(bytes);
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
// Tabs & Theme Navigation
// =========================================================================

function switchTab(tabId) {
  activeTab = tabId;
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
  if (!snapshot) return;
  const c = snapshot.character;
  const jobDef = jobMap.get(c.job);
  const jobName = jobDef?.name ?? c.job;
  const rebirthStr = currentRebirths > 0 ? `${currentRebirths}轉` : "0轉";
  const srcStr = currentIsCustom ? "自訂" : "匯入";
  $("role").textContent = `${c.name} · ${jobName}（${rebirthStr}）· Base ${c.baseLv}／Job ${c.jobLv} · ${srcStr}`;
}

// =========================================================================
// TAB 1: Character Builder & Stat Allocator
// =========================================================================

function populateJobSelect(rebirths, currentJobId) {
  if (!builderInfo) return;
  const wantUpper = rebirths >= 1;
  const sel = $("build-job");
  const groups = wantUpper
    ? [
      {label: "進階二轉（上限 Job 70）", items: builderInfo.jobs.filter(j => j.upper && j.tier === 2)},
      {label: "進階一轉（上限 Job 50）", items: builderInfo.jobs.filter(j => j.upper && j.tier === 1)},
      {label: "進階初學者", items: builderInfo.jobs.filter(j => j.upper && j.tier === 0)},
    ]
    : [
      {label: "二轉（上限 Job 50）", items: builderInfo.jobs.filter(j => !j.upper && j.tier === 2)},
      {label: "一轉／擴充（上限 Job 50／99）", items: builderInfo.jobs.filter(j => !j.upper && j.tier === 1)},
      {label: "初學者", items: builderInfo.jobs.filter(j => !j.upper && j.tier === 0)},
    ];
  sel.replaceChildren(...groups.filter(g => g.items.length).map(group => {
    const og = document.createElement("optgroup");
    og.label = group.label;
    for (const j of group.items.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"))) {
      og.append(new Option(j.name, j.id));
    }
    return og;
  }));
  if ([...sel.options].some(o => o.value === currentJobId)) {
    sel.value = currentJobId;
  }
}

function renderBuildTab() {
  if (!snapshot || !builderInfo) return;
  const c = snapshot.character;
  const jobDef = jobMap.get(c.job);
  $("build-name").value = c.name;
  $("build-rebirths").value = String(currentRebirths);
  $("rebirth-0").classList.toggle("is-active", currentRebirths === 0);
  $("rebirth-1").classList.toggle("is-active", currentRebirths === 1);
  $("rebirth-11").classList.toggle("is-active", currentRebirths === 11);
  const startPts = currentRebirths === 0 ? 48 : 100 + (currentRebirths - 1) * EXTRA_STAT_PER_REBIRTH;
  const totalLvPts = totalStatPointsFor(c.baseLv, currentRebirths);
  $("rebirth-hint").textContent = currentRebirths === 0
    ? `0 轉一般職業：Lv.1 起始 48 點（目前 Lv.${c.baseLv} 共 ${format(totalLvPts)} 點）、基礎 HP／SP 1.0×`
    : currentRebirths === 1
      ? `1 轉進階職業：Lv.1 起始 100 點（目前 Lv.${c.baseLv} 共 ${format(totalLvPts)} 點）、基礎 HP／SP ×1.25、Job 上限 70`
      : `${currentRebirths} 轉進階職業：Lv.1 起始 ${format(startPts)} 點（100 + ${currentRebirths - 1}×${EXTRA_STAT_PER_REBIRTH}，目前 Lv.${c.baseLv} 共 ${format(totalLvPts)} 點）、基礎 HP／SP ×1.25`;

  populateJobSelect(currentRebirths, c.job);
  const maxJL = jobDef?.maxJobLv ?? 70;
  $("build-base-lv").value = String(c.baseLv);
  $("build-job-lv").max = String(maxJL);
  $("build-job-lv").value = String(Math.min(maxJL, c.jobLv));
  $("build-job-lv-max-label").textContent = String(maxJL);
  $("first-job-lv-wrap").hidden = !jobDef || jobDef.tier < 2;
  $("build-first-job-lv").value = String(currentFirstJobLv);

  const showRiding = RIDING_JOBS.has(c.job);
  const showFalcon = FALCON_JOBS.has(c.job);
  $("build-riding-wrap").hidden = !showRiding;
  if (showRiding) $("build-riding").checked = Boolean(c.riding);
  $("build-falcon-wrap").hidden = !showFalcon;
  if (showFalcon) $("build-falcon").checked = Boolean(c.falcon);

  $("revert-imported-char").hidden = !originalImportedSnapshot;
  $("char-source-hint").textContent = originalImportedSnapshot
    ? "目前以匯入角色為基底，所有配點、技能與裝備修改僅在本機模擬，不會改動遊戲帳號。"
    : "自訂角色模式：可自由設定轉生次數、職業、等級、素質、技能與裝備，完全不需匯入遊戲。";

  renderPetSelector();
  renderStatAllocator();
  updateHeaderRole();
}

function renderPetSelector() {
  if (!snapshot || !builderInfo) return;
  const sel = $("build-pet");
  const loyalCb = $("build-pet-loyal");
  const desc = $("build-pet-desc");
  if (!sel) return;
  const allPets = builderInfo.pets ?? [];
  const curMob = snapshot.pet?.mob ?? 0;
  const term = ($("build-pet-search")?.value ?? "").trim().normalize("NFKC").toLowerCase();
  const sorted = [...allPets].sort((a, b) => Number(b.hasBonus) - Number(a.hasBonus) || a.gen - b.gen || a.mob - b.mob);
  const filtered = sorted.filter(p => {
    if (p.mob === curMob) return true;
    if (!term) return true;
    return `${p.name} ${p.mob} ${p.loyalText.join(" ")} ${p.loyalUnsupported.join(" ")}`
      .normalize("NFKC").toLowerCase().includes(term);
  });
  sel.replaceChildren(
    new Option("（無寵物）", ""),
    ...filtered.map(p => new Option(
      `${p.name} · ${p.loyalText.length ? p.loyalText.join("、") : "無忠誠加成"}`,
      String(p.mob)
    ))
  );
  sel.value = curMob && petMap.has(curMob) ? String(curMob) : "";
  const chosen = curMob ? petMap.get(curMob) : null;
  loyalCb.disabled = !chosen;
  loyalCb.checked = chosen ? (snapshot.pet?.intimacy ?? 1000) >= 910 : true;
  if (!chosen) {
    desc.textContent = "目前未攜帶寵物；選擇寵物後預設親密度為忠誠（1000），即時套用忠誠加成。";
  } else {
    const loyalOn = loyalCb.checked;
    const bonusStr = chosen.loyalText.length ? chosen.loyalText.join("、") : "此寵物無戰鬥忠誠加成";
    const statusStr = chosen.loyalText.length
      ? (loyalOn ? `已生效（親密度 ${snapshot.pet?.intimacy ?? 1000}）` : `未達忠誠（親密度 ${snapshot.pet?.intimacy ?? 250}，加成未生效）`)
      : "";
    const extraNote = chosen.loyalUnsupported.length
      ? `；原版另有 ${chosen.loyalUnsupported.join("、")}（本引擎暫不支援）`
      : "";
    desc.textContent = `${chosen.name}：${bonusStr}${statusStr ? ` · ${statusStr}` : ""}${extraNote}`;
  }
}

function renderStatRadar() {
  const svg = $("stat-radar");
  if (!svg || !snapshot) return;
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const c = snapshot.character;
  const panelTotals = lastPreview?.current ?? lastPreview?.base ?? null;
  const bases = STAT_KEYS.map(k => Math.max(1, Math.min(99, Math.trunc(c.stats[k] ?? 1))));
  const totals = STAT_KEYS.map((k, i) => Math.max(1, panelTotals?.[k.toUpperCase()] ?? bases[i]));
  const maxVal = Math.max(100, Math.ceil(Math.max(...totals, ...bases, 100) / 20) * 20);

  const cx = 180, cy = 150, R = 88;
  const point = (idx, ratio) => {
    const angle = (-90 + idx * 60) * Math.PI / 180;
    return [cx + Math.cos(angle) * R * ratio, cy + Math.sin(angle) * R * ratio];
  };
  const polyPoints = vals => vals.map((v, i) => point(i, Math.min(1, Math.max(0, v / maxVal))).map(n => n.toFixed(1)).join(",")).join(" ");

  const nodes = [];
  // Concentric hexagon grid rings
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const pts = STAT_KEYS.map((_, i) => point(i, frac).map(n => n.toFixed(1)).join(",")).join(" ");
    nodes.push(el("polygon", {points: pts, class: "radar-grid-ring"}));
    const [tx, ty] = point(0, frac);
    nodes.push(el("text", {x: tx + 12, y: ty + 3, class: "radar-tick"}, String(Math.round(maxVal * frac))));
  }
  // Axes
  for (let i = 0; i < 6; i++) {
    const [ax, ay] = point(i, 1);
    nodes.push(el("line", {x1: cx, y1: cy, x2: ax.toFixed(1), y2: ay.toFixed(1), class: "radar-axis"}));
  }
  // Outer polygon (total with bonuses)
  nodes.push(el("polygon", {points: polyPoints(totals), class: "radar-poly-total"}));
  // Inner polygon (base allocated stats)
  nodes.push(el("polygon", {points: polyPoints(bases), class: "radar-poly-base"}));

  // Vertex dots & axis labels
  for (let i = 0; i < 6; i++) {
    const [tx, ty] = point(i, Math.min(1, totals[i] / maxVal));
    const [bx, by] = point(i, Math.min(1, bases[i] / maxVal));
    nodes.push(el("circle", {cx: tx.toFixed(1), cy: ty.toFixed(1), r: 3.6, class: "radar-dot-total"}));
    nodes.push(el("circle", {cx: bx.toFixed(1), cy: by.toFixed(1), r: 3.2, class: "radar-dot-base"}));

    const [lx, ly] = point(i, 1.24);
    const anchor = i === 0 || i === 3 ? "middle" : i < 3 ? "start" : "end";
    const xAdj = i === 0 || i === 3 ? lx : i < 3 ? lx - 2 : lx + 2;
    const yAdj = i === 0 ? ly - 6 : i === 3 ? ly + 8 : ly;
    const bonus = totals[i] - bases[i];
    const bonusStr = bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : `−${Math.abs(bonus)}`;
    nodes.push(el("text", {x: xAdj.toFixed(1), y: (yAdj - 3).toFixed(1), "text-anchor": anchor, class: "radar-label-stat"}, STAT_KEYS[i].toUpperCase()));
    nodes.push(el("text", {x: xAdj.toFixed(1), y: (yAdj + 11).toFixed(1), "text-anchor": anchor, class: "radar-label-val"}, `${bases[i]}${bonusStr}`));
  }
  svg.replaceChildren(...nodes);
}

function renderStatAllocator() {
  if (!snapshot) return;
  const c = snapshot.character;
  const freeMode = $("build-free-stats").checked;
  const totalPts = totalStatPointsFor(c.baseLv, currentRebirths);
  const usedPts = spentStatPoints(c.stats);
  const remain = totalPts - usedPts;
  const pill = $("stat-points-summary");
  pill.textContent = remain >= 0
    ? `剩餘素質點數：${format(remain)} ／ ${format(totalPts)}（已用 ${format(usedPts)}）`
    : `超出素質點數：${format(Math.abs(remain))} 點（已用 ${format(usedPts)} ／ ${format(totalPts)}）`;
  pill.classList.toggle("is-over", remain < 0);

  renderStatRadar();

  const panelTotals = lastPreview?.current ?? lastPreview?.base ?? null;
  $("stat-allocator").replaceChildren(...STAT_KEYS.map(key => {
    const val = Math.max(1, Math.min(99, Math.trunc(c.stats[key] ?? 1)));
    const upperKey = key.toUpperCase();
    const totalShown = panelTotals?.[upperKey] ?? val;
    const bonus = totalShown - val;
    const cost1 = val >= 99 ? 0 : statStepCost(val);

    const row = document.createElement("div");
    row.className = "stat-row";
    row.dataset.stat = key;

    const top = document.createElement("div");
    top.className = "stat-top";

    const meta = document.createElement("div");
    meta.className = "stat-meta";
    const code = document.createElement("span");
    code.className = "stat-code";
    code.textContent = upperKey;
    const tot = document.createElement("span");
    tot.className = "stat-total";
    const strongTot = document.createElement("strong");
    strongTot.textContent = String(totalShown);
    tot.append(`${val}${bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : `−${Math.abs(bonus)}`} ＝ `, strongTot);
    meta.append(code, tot);

    const cost = document.createElement("span");
    cost.className = "stat-cost";
    cost.textContent = val >= 99 ? "MAX" : `+1 耗 ${cost1}`;
    top.append(meta, cost);

    const controls = document.createElement("div");
    controls.className = "stat-controls";

    const mkBtn = (label, delta) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stat-step-btn";
      b.textContent = label;
      if (delta < 0 && val <= 1) b.disabled = true;
      if (delta > 0 && (val >= 99 || (!freeMode && remain < cost1))) b.disabled = true;
      b.onclick = () => adjustStat(key, delta);
      return b;
    };

    const input = document.createElement("input");
    input.type = "number";
    input.className = "stat-input";
    input.min = "1";
    input.max = "99";
    input.value = String(val);
    input.setAttribute("aria-label", `${upperKey} 基礎值`);
    input.onchange = () => {
      const target = Math.max(1, Math.min(99, Math.trunc(Number(input.value) || 1)));
      setStatExact(key, target);
    };

    controls.append(mkBtn("−10", -10), mkBtn("−1", -1), input, mkBtn("+1", 1), mkBtn("+10", 10));

    const bar = document.createElement("div");
    bar.className = "stat-bar";
    const fill = document.createElement("div");
    fill.className = "stat-bar-fill";
    fill.style.width = `${Math.round(val / 99 * 100)}%`;
    bar.append(fill);

    row.append(top, controls, bar);
    return row;
  }));
}

function setStatExact(key, desired) {
  if (!snapshot) return;
  const freeMode = $("build-free-stats").checked;
  const c = snapshot.character;
  let val = Math.max(1, Math.min(99, Math.trunc(desired)));
  if (!freeMode && val > c.stats[key]) {
    const totalPts = totalStatPointsFor(c.baseLv, currentRebirths);
    const otherSpent = spentStatPoints({...c.stats, [key]: 1});
    let best = 1;
    let acc = otherSpent;
    while (best < val && best < 99) {
      const cost = statStepCost(best);
      if (acc + cost > totalPts) break;
      acc += cost;
      best++;
    }
    val = best;
  }
  c.stats[key] = val;
  renderStatAllocator();
  scheduleStats();
}

function adjustStat(key, delta) {
  if (!snapshot) return;
  const current = snapshot.character.stats[key] ?? 1;
  setStatExact(key, current + delta);
}

async function handleJobOrLevelChange({jobChanged = false} = {}) {
  if (!snapshot || !builderInfo) return;
  const c = snapshot.character;
  const jobDef = jobMap.get(c.job);
  if (jobDef) {
    c.jobLv = Math.max(1, Math.min(jobDef.maxJobLv, Math.trunc(c.jobLv)));
    if (jobChanged) {
      // Keep only skills belonging to the new job's skill tree
      const allowed = new Map(jobDef.skillTree.map(s => [s.id, s]));
      const nextSkills = {};
      for (const [sid, lv] of Object.entries(c.skills ?? {})) {
        const entry = allowed.get(sid);
        if (entry && lv > 0) nextSkills[sid] = Math.min(entry.maxLv, lv);
      }
      if (allowed.has("NV_BASIC") && !nextSkills.NV_BASIC) nextSkills.NV_BASIC = 9;
      c.skills = nextSkills;
      if (!RIDING_JOBS.has(c.job)) delete c.riding;
      if (!FALCON_JOBS.has(c.job)) delete c.falcon;
      // Clean auto-cast skills that no longer exist
      if (snapshot.config?.skills) {
        snapshot.config.skills = snapshot.config.skills.filter(s => (c.skills[s.skill] ?? 0) > 0);
      }
    }
  }
  c.hp = 999999;
  c.sp = 999999;
  renderBuildTab();
  renderSkillTree();
  await refreshDerivedCatalogs();
}

// =========================================================================
// TAB 2: Skill Tree Allocator
// =========================================================================

function getSkillTreeEntry(skillId) {
  return jobMap.get(snapshot?.character?.job)?.skillTree.find(s => s.id === skillId);
}

function collectMissingPrereqs(jobDef, skillMap, skillId, visited = new Set()) {
  if (visited.has(skillId)) return [];
  visited.add(skillId);
  const entry = jobDef.skillTree.find(s => s.id === skillId);
  if (!entry?.requires) return [];
  const steps = [];
  for (const [reqId, reqLv] of Object.entries(entry.requires)) {
    const cur = skillMap[reqId] ?? 0;
    if (cur < reqLv) {
      steps.push(...collectMissingPrereqs(jobDef, skillMap, reqId, visited));
      steps.push({id: reqId, targetLv: reqLv});
    }
  }
  return steps;
}

function setSkillLevel(skillId, targetLv) {
  if (!snapshot || !builderInfo) return;
  const c = snapshot.character;
  const jobDef = jobMap.get(c.job);
  if (!jobDef) return;
  const entry = jobDef.skillTree.find(s => s.id === skillId);
  if (!entry) return;

  const freeSkills = $("build-free-skills").checked;
  const maxPts = totalSkillPointsFor(jobDef, c.jobLv, currentFirstJobLv);
  const nextMap = {...(c.skills ?? {})};
  const clamped = Math.max(0, Math.min(entry.maxLv, Math.trunc(targetLv)));

  if (clamped > (nextMap[skillId] ?? 0)) {
    // Auto-satisfy prerequisites
    const prereqs = collectMissingPrereqs(jobDef, nextMap, skillId);
    for (const p of prereqs) {
      nextMap[p.id] = Math.max(nextMap[p.id] ?? 0, p.targetLv);
    }
    nextMap[skillId] = clamped;
    if (!freeSkills && entry.questJobLv == null) {
      const needed = spentSkillPoints(jobDef, nextMap);
      if (needed > maxPts) {
        $("status").textContent = `技能點數不足（需要 ${needed} 點，目前可用 ${maxPts} 點）。可提高 Job Lv 或勾選「不限技能點」。`;
        return;
      }
    }
  } else {
    nextMap[skillId] = clamped;
    if (clamped === 0) delete nextMap[skillId];
    // Cascade-lower skills that require this skill above its new level
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of jobDef.skillTree) {
        if (!(nextMap[s.id] > 0) || !s.requires) continue;
        for (const [reqId, reqLv] of Object.entries(s.requires)) {
          if ((nextMap[reqId] ?? 0) < reqLv) {
            delete nextMap[s.id];
            changed = true;
            break;
          }
        }
      }
    }
  }

  c.skills = nextMap;
  // Sync auto-cast skills levels if configured
  if (snapshot.config?.skills) {
    snapshot.config.skills = snapshot.config.skills
      .filter(s => (c.skills[s.skill] ?? 0) > 0)
      .map(s => ({...s, lv: Math.min(s.lv, c.skills[s.skill])}));
  }
  $("status").textContent = "";
  renderSkillTree();
  void refreshAttackSkillsAndStats();
}

function toggleAutoCastSkill(skillId, enabled) {
  if (!snapshot) return;
  const lv = snapshot.character.skills?.[skillId] ?? 0;
  snapshot.config.skills = (snapshot.config.skills ?? []).filter(s => !(s.skill === skillId && s.use === "attack"));
  if (enabled && lv > 0) {
    snapshot.config.skills.push({skill: skillId, lv, use: "attack", percent: 0, enabled: true});
  }
  scheduleStats();
}

function skillIconTheme(entry) {
  const id = entry.id;
  if (/FIRE|MAGNUM|METEOR|PILLAR|DEMONSTRATION/.test(id)) return {bg: "linear-gradient(135deg,#ea580c,#dc2626)", glyph: "flame"};
  if (/COLD|FROST|STORM|ICE|WATER|SG_|FREEZE/.test(id)) return {bg: "linear-gradient(135deg,#0284c7,#2563eb)", glyph: "snow"};
  if (/LIGHTNING|JUPITEL|THUNDER|VERMILION/.test(id)) return {bg: "linear-gradient(135deg,#eab308,#ca8a04)", glyph: "bolt"};
  if (/HEAL|SANCTUARY|RESURRECT|RECOVERY|POTION|PITCHER|FIRSTAID/.test(id)) return {bg: "linear-gradient(135deg,#16a34a,#059669)", glyph: "cross"};
  if (/BLESS|ANGEL|HOLY|MAGNUS|TURNUNDEAD|ASPERSIO|GLORIA|ASSUMPTIO|KYRIE|SUFFRAGIUM|IMPOSITIO|CR_|PA_|PR_|HP_|AL_/.test(id)) {
    return {bg: "linear-gradient(135deg,#d97706,#b45309)", glyph: entry.attack ? "spark" : "halo"};
  }
  if (/POISON|VENOM|ENVENOM|CLOAK|HIDE|STEAL|SONIC|GRIMTOOTH|METEORASSAULT|AS_|ASC_|TF_|RG_|ST_/.test(id)) {
    return {bg: "linear-gradient(135deg,#7c3aed,#5b21b6)", glyph: "dagger"};
  }
  if (/BOW|ARROW|DOUBLE|SHOWER|STRAFE|FALCON|BLITZ|TRAP|SNARE|LANDMINE|BLAST|CLAYMORE|AC_|HT_|SN_/.test(id)) {
    return {bg: "linear-gradient(135deg,#0d9488,#0f766e)", glyph: /TRAP|SNARE|MINE|CLAYMORE/.test(id) ? "trap" : "bow"};
  }
  if (/BA_|DC_|BD_|CG_|SONG|WHISTLE|BRAGI|HUMMING|KISS|APPLE|ENCORE/.test(id)) {
    return {bg: "linear-gradient(135deg,#db2777,#9333ea)", glyph: "music"};
  }
  if (/SPEAR|PIERCE|BRANDISH|SPIRAL/.test(id)) return {bg: "linear-gradient(135deg,#b91c1c,#7f1d1d)", glyph: "spear"};
  if (/SHIELD|GUARD|DEFENDER|REFLECT|AUTOGUARD|ENDURE|SACRIFICE/.test(id)) return {bg: "linear-gradient(135deg,#475569,#1e293b)", glyph: "shield"};
  if (/MONK|MO_|CH_|FIST|COMBO|SPIRIT|FINGER|OCCULT|INVESTIGATE|ASURA/.test(id)) return {bg: "linear-gradient(135deg,#c2410c,#9a3412)", glyph: "fist"};
  if (/BS_|WS_|MC_|AM_|CART|MAMMONITE|OVERTHRUST|ADRENALINE|FORGE|PHARMACY|ACID|BOMB/.test(id)) {
    return {bg: "linear-gradient(135deg,#ca8a04,#854d0e)", glyph: "hammer"};
  }
  if (/WZ_|HW_|MG_|SA_|PF_|BOLT|SOUL|MAGIC|CAST|SPELL|EARTH|HEAVEN/.test(id)) {
    return {bg: "linear-gradient(135deg,#4f46e5,#3730a3)", glyph: "wand"};
  }
  if (entry.attack) return {bg: "linear-gradient(135deg,#dc2626,#991b1b)", glyph: "sword"};
  if (entry.questJobLv != null) return {bg: "linear-gradient(135deg,#d97706,#92400e)", glyph: "star"};
  return {bg: "linear-gradient(135deg,#475569,#334155)", glyph: "book"};
}

const SKILL_GLYPHS = {
  sword: '<path d="M14.5 3.5L20.5 3.5L20.5 9.5L10.5 19.5L4.5 13.5L14.5 3.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 21L7.5 16.5M6 12L12 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  spear: '<path d="M4 20L19 5M14 4L20 4L20 10" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
  bow: '<path d="M5 19C5 11 11 5 19 5M5 19L19 5M14 5H19V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  dagger: '<path d="M18 4L20 6L11 15L9 13L18 4ZM4 20L9.5 14.5M8 11L13 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  flame: '<path d="M12 3C12 3 17 7.5 17 12.5A5 5 0 0 1 7 12.5C7 9.5 9 7.5 9 7.5C9 9.5 10.5 10 10.5 10C10.5 7 12 3 12 3Z" fill="currentColor"/>',
  snow: '<path d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  bolt: '<path d="M13 2L4 14H11L10 22L20 10H13L13 2Z" fill="currentColor"/>',
  cross: '<path d="M9 4H15V9H20V15H15V20H9V15H4V9H9V4Z" fill="currentColor"/>',
  halo: '<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2V5M12 19V22M2 12H5M19 12H22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  spark: '<path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor"/>',
  shield: '<path d="M12 3L19 6V12C19 16.5 15.8 19.8 12 21C8.2 19.8 5 16.5 5 12V6L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  music: '<path d="M9 18V6L19 4V16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="16" r="2.5" fill="currentColor"/>',
  trap: '<path d="M4 17H20M6 17L9 8L12 13L15 8L18 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  fist: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 11V8M12 11V7M15 11V8M8 14H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  hammer: '<path d="M4 20L13 11M10 6L15 3L20 8L17 13L10 6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  wand: '<path d="M4 20L15 9M15 4V7M20 9H17M18.5 5.5L16.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  star: '<path d="M12 3L14.8 8.7L21 9.6L16.5 14L17.6 20.2L12 17.2L6.4 20.2L7.5 14L3 9.6L9.2 8.7L12 3Z" fill="currentColor"/>',
  book: '<path d="M5 4H14C16 4 19 5 19 7V19C19 17.5 16 17 14 17H5V4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 8H15M9 12H14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

function createSkillIconEl(entry) {
  const {bg, glyph} = skillIconTheme(entry);
  const box = document.createElement("div");
  box.className = "skill-icon";
  box.style.background = bg;
  box.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SKILL_GLYPHS[glyph] ?? SKILL_GLYPHS.book}</svg>`;
  return box;
}

function renderSkillInspector(jobDef, autoCastSet, skillNameById) {
  const box = $("skill-inspector");
  if (!box) return;
  const entry = selectedSkillId ? jobDef.skillTree.find(s => s.id === selectedSkillId) : null;
  if (!entry) {
    box.hidden = true;
    return;
  }
  const c = snapshot.character;
  const lv = c.skills?.[entry.id] ?? 0;
  box.hidden = false;

  const main = document.createElement("div");
  main.className = "skill-inspector-main";
  const head = document.createElement("div");
  head.className = "skill-inspector-head";
  const title = document.createElement("strong");
  title.textContent = `${entry.name}（Lv ${lv} / ${entry.maxLv}）`;
  head.append(title);
  if (entry.attack) {
    const b = document.createElement("span");
    b.className = "mini-tag tag-attack";
    b.textContent = "主動攻擊";
    head.append(b);
  }
  if (entry.questJobLv != null) {
    const b = document.createElement("span");
    b.className = "mini-tag tag-quest";
    b.textContent = "任務技能（免技能點）";
    head.append(b);
  }
  if (entry.requires) {
    for (const [reqId, reqLv] of Object.entries(entry.requires)) {
      const met = (c.skills?.[reqId] ?? 0) >= reqLv;
      const b = document.createElement("span");
      b.className = `mini-tag ${met ? "tag-ok" : "tag-req"}`;
      b.textContent = `前置：${skillNameById.get(reqId) ?? reqId} Lv.${reqLv}`;
      head.append(b);
    }
  }
  const desc = document.createElement("p");
  desc.className = "skill-inspector-desc";
  desc.textContent = entry.desc || entry.id;
  main.append(head, desc);

  const actions = document.createElement("div");
  actions.className = "skill-inspector-actions";
  const stepper = document.createElement("div");
  stepper.className = "skill-stepper";
  for (const [label, target, disabled] of [
    ["0", 0, lv <= 0],
    ["−", lv - 1, lv <= 0],
    ["+", lv + 1, lv >= entry.maxLv],
    ["滿", entry.maxLv, lv >= entry.maxLv],
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.disabled = disabled;
    btn.onclick = () => setSkillLevel(entry.id, target);
    stepper.append(btn);
  }
  actions.append(stepper);

  if (entry.attack && lv > 0) {
    const autoLabel = document.createElement("label");
    autoLabel.className = "check inline-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = autoCastSet.has(entry.id);
    cb.onchange = () => toggleAutoCastSkill(entry.id, cb.checked);
    autoLabel.append(cb, "加入掛機施放");
    actions.append(autoLabel);
  }

  box.replaceChildren(main, actions);
}

function createSkillNodeElement(entry, {c, matchesFilter, isStatic = false, onHover}) {
  const lv = c.skills?.[entry.id] ?? 0;
  const reqsMet = !entry.requires || Object.entries(entry.requires).every(([rid, rlv]) => (c.skills?.[rid] ?? 0) >= rlv);
  const node = document.createElement("div");
  node.className = `skill-node${isStatic ? " skill-node-static" : ""}`;
  node.dataset.skillId = entry.id;
  if (lv > 0) node.classList.add("is-learned");
  if (lv >= entry.maxLv) node.classList.add("is-maxed");
  if (!reqsMet && lv === 0) node.classList.add("is-locked");
  if (selectedSkillId === entry.id) node.classList.add("is-selected");
  if (!matchesFilter) node.classList.add("is-dimmed");
  node.title = `${entry.name} (Lv ${lv}/${entry.maxLv})\n${entry.desc || ""}\n左鍵升級、右鍵降級`;

  const top = document.createElement("div");
  top.className = "skill-node-top";
  const title = document.createElement("div");
  title.className = "skill-node-title";
  title.textContent = entry.name;
  top.append(createSkillIconEl(entry), title);

  const bottom = document.createElement("div");
  bottom.className = "skill-node-bottom";
  const lvEl = document.createElement("span");
  lvEl.className = "skill-node-lv";
  lvEl.textContent = `Lv ${lv}/${entry.maxLv}`;

  const btns = document.createElement("div");
  btns.className = "skill-node-btns";
  const bMinus = document.createElement("button");
  bMinus.type = "button"; bMinus.textContent = "−"; bMinus.disabled = lv <= 0;
  bMinus.onclick = e => { e.stopPropagation(); selectedSkillId = entry.id; setSkillLevel(entry.id, lv - 1); };
  const bPlus = document.createElement("button");
  bPlus.type = "button"; bPlus.textContent = "+"; bPlus.disabled = lv >= entry.maxLv;
  bPlus.onclick = e => { e.stopPropagation(); selectedSkillId = entry.id; setSkillLevel(entry.id, lv + 1); };
  const bMax = document.createElement("button");
  bMax.type = "button"; bMax.textContent = "滿"; bMax.disabled = lv >= entry.maxLv;
  bMax.onclick = e => { e.stopPropagation(); selectedSkillId = entry.id; setSkillLevel(entry.id, entry.maxLv); };
  btns.append(bMinus, bPlus, bMax);
  bottom.append(lvEl, btns);

  const bar = document.createElement("div");
  bar.className = "skill-node-bar";
  const fill = document.createElement("div");
  fill.className = "skill-node-bar-fill";
  fill.style.width = `${Math.round(lv / Math.max(1, entry.maxLv) * 100)}%`;
  bar.append(fill);

  node.append(top, bottom, bar);
  node.onclick = () => {
    selectedSkillId = entry.id;
    if (lv < entry.maxLv) setSkillLevel(entry.id, lv + 1);
    else renderSkillTree();
  };
  node.oncontextmenu = e => {
    e.preventDefault();
    selectedSkillId = entry.id;
    if (lv > 0) setSkillLevel(entry.id, lv - 1);
    else renderSkillTree();
  };
  if (onHover) {
    node.onmouseenter = () => onHover(entry.id);
    node.onmouseleave = () => onHover(null);
  }
  return node;
}

function renderSkillTreeGraph(jobDef, matchSet, autoCastSet, skillNameById) {
  const c = snapshot.character;
  const questSkills = jobDef.skillTree.filter(s => s.questJobLv != null);
  const regularSkills = jobDef.skillTree.filter(s => s.questJobLv == null);
  const regMap = new Map(regularSkills.map(s => [s.id, s]));

  // Build adjacency for regular skills
  const parentsOf = new Map();
  const childrenOf = new Map();
  for (const s of regularSkills) {
    parentsOf.set(s.id, []);
    childrenOf.set(s.id, []);
  }
  for (const s of regularSkills) {
    if (!s.requires) continue;
    for (const [reqId, reqLv] of Object.entries(s.requires)) {
      if (!regMap.has(reqId)) continue;
      parentsOf.get(s.id).push({id: reqId, lv: reqLv});
      childrenOf.get(reqId).push({id: s.id, lv: reqLv});
    }
  }

  const connected = regularSkills.filter(s => parentsOf.get(s.id).length > 0 || childrenOf.get(s.id).length > 0);
  const standalone = regularSkills.filter(s => parentsOf.get(s.id).length === 0 && childrenOf.get(s.id).length === 0);

  if (selectedSkillId && !jobDef.skillTree.some(s => s.id === selectedSkillId)) {
    selectedSkillId = null;
  }
  renderSkillInspector(jobDef, autoCastSet, skillNameById);

  // Connected DAG Layout (longest-path depth + barycenter column order)
  const connSec = $("skill-graph-connected-sec");
  const canvas = $("skill-graph-canvas");
  connSec.hidden = connected.length === 0;
  if (connected.length) {
    const depth = new Map();
    const calcDepth = (id, stack = new Set()) => {
      if (depth.has(id)) return depth.get(id);
      if (stack.has(id)) return 0;
      stack.add(id);
      const ps = parentsOf.get(id) ?? [];
      const d = ps.length ? 1 + Math.max(...ps.map(p => calcDepth(p.id, stack))) : 0;
      depth.set(id, d);
      return d;
    };
    for (const s of connected) calcDepth(s.id);

    const maxDepth = Math.max(0, ...depth.values());
    const rows = Array.from({length: maxDepth + 1}, () => []);
    for (const s of connected) rows[depth.get(s.id)].push(s);

    // Order row 0 by subtree weight & original tree order so related roots stay together
    const subtreeSize = (id, seen = new Set()) => {
      if (seen.has(id)) return 0;
      seen.add(id);
      return 1 + (childrenOf.get(id) ?? []).reduce((sum, ch) => sum + subtreeSize(ch.id, seen), 0);
    };
    const origIdx = new Map(regularSkills.map((s, i) => [s.id, i]));
    rows[0].sort((a, b) => subtreeSize(b.id) - subtreeSize(a.id) || origIdx.get(a.id) - origIdx.get(b.id));

    const colOf = new Map();
    rows[0].forEach((s, idx) => colOf.set(s.id, idx));
    for (let r = 1; r < rows.length; r++) {
      rows[r].sort((a, b) => {
        const avg = s => {
          const ps = parentsOf.get(s.id);
          return ps.reduce((sum, p) => sum + (colOf.get(p.id) ?? 0), 0) / Math.max(1, ps.length);
        };
        return avg(a) - avg(b) || origIdx.get(a.id) - origIdx.get(b.id);
      });
      rows[r].forEach((s, idx) => colOf.set(s.id, idx));
    }

    const NODE_W = 142, NODE_H = 86, GAP_X = 28, GAP_Y = 48, PAD = 10;
    const maxCols = Math.max(...rows.map(r => r.length));
    const totalW = PAD * 2 + maxCols * NODE_W + Math.max(0, maxCols - 1) * GAP_X;
    const totalH = PAD * 2 + rows.length * NODE_H + Math.max(0, rows.length - 1) * GAP_Y;
    canvas.style.width = `${totalW}px`;
    canvas.style.height = `${totalH}px`;

    const pos = new Map();
    for (let r = 0; r < rows.length; r++) {
      const rowW = rows[r].length * NODE_W + Math.max(0, rows[r].length - 1) * GAP_X;
      const startX = (totalW - rowW) / 2;
      const y = PAD + r * (NODE_H + GAP_Y);
      rows[r].forEach((s, idx) => {
        pos.set(s.id, {x: startX + idx * (NODE_W + GAP_X), y, r});
      });
    }

    // Build SVG edges
    const NS = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs = {}, text) => {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const svg = svgEl("svg", {class: "skill-graph-svg", width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}`});
    const defs = svgEl("defs");
    const addMarker = (id, color) => {
      const m = svgEl("marker", {id, viewBox: "0 0 10 10", refX: "8.5", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse"});
      m.append(svgEl("path", {d: "M 0 1 L 10 5 L 0 9 z", fill: color}));
      defs.append(m);
    };
    addMarker("arrow-unmet", "var(--border-strong)");
    addMarker("arrow-met", "var(--green)");
    addMarker("arrow-hi", "var(--accent)");
    svg.append(defs);

    const edgeEls = [];
    for (const s of connected) {
      const childPos = pos.get(s.id);
      const ps = parentsOf.get(s.id);
      ps.forEach((p, pIdx) => {
        const parentPos = pos.get(p.id);
        if (!parentPos || !childPos) return;
        const met = (c.skills?.[p.id] ?? 0) >= p.lv;
        const x1 = parentPos.x + NODE_W / 2;
        const y1 = parentPos.y + NODE_H;
        const offsetX = ps.length > 1 ? (pIdx - (ps.length - 1) / 2) * 24 : 0;
        const x2 = childPos.x + NODE_W / 2 + offsetX;
        const y2 = childPos.y - 2;
        const rowSpan = childPos.r - parentPos.r;
        let d, lx, ly;
        if (rowSpan <= 1) {
          const midY = (y1 + y2) / 2;
          d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
          lx = (x1 + x2) / 2;
          ly = midY;
        } else {
          // Route smoothly around intermediate rows
          const bendX = x1 <= x2 ? Math.max(x1, x2) + 34 : Math.min(x1, x2) - 34;
          const midY1 = y1 + 22;
          const midY2 = y2 - 22;
          d = `M ${x1} ${y1} C ${x1} ${midY1}, ${bendX} ${midY1}, ${bendX} ${(y1 + y2) / 2} S ${x2} ${midY2}, ${x2} ${y2}`;
          lx = x2;
          ly = y2 - 14;
        }
        const path = svgEl("path", {
          d,
          class: `skill-edge${met ? " is-met" : ""}`,
          "marker-end": met ? "url(#arrow-met)" : "url(#arrow-unmet)",
        });
        path.dataset.from = p.id;
        path.dataset.to = s.id;
        path.dataset.met = met ? "1" : "0";
        svg.append(path);
        edgeEls.push(path);

        // Required level pill on the arrow
        const pillW = 28, pillH = 14;
        svg.append(
          svgEl("rect", {
            x: (lx - pillW / 2).toFixed(1),
            y: (ly - pillH / 2).toFixed(1),
            width: pillW,
            height: pillH,
            rx: 7,
            class: `skill-edge-pill-bg${met ? " is-met" : ""}`,
          }),
          svgEl("text", {
            x: lx.toFixed(1),
            y: ly.toFixed(1),
            class: `skill-edge-pill-text${met ? " is-met" : ""}`,
          }, `Lv.${p.lv}`)
        );
      });
    }

    const highlightEdges = hoveredId => {
      const focusId = hoveredId || selectedSkillId;
      for (const path of edgeEls) {
        const hi = Boolean(focusId && (path.dataset.from === focusId || path.dataset.to === focusId));
        path.classList.toggle("is-highlight", hi);
        path.setAttribute("marker-end", hi ? "url(#arrow-hi)" : path.dataset.met === "1" ? "url(#arrow-met)" : "url(#arrow-unmet)");
      }
    };

    const nodeEls = connected.map(entry => {
      const node = createSkillNodeElement(entry, {
        c,
        matchesFilter: matchSet.has(entry.id),
        isStatic: false,
        onHover: highlightEdges,
      });
      const p = pos.get(entry.id);
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      return node;
    });
    highlightEdges(null);
    canvas.replaceChildren(svg, ...nodeEls);
  }

  // Standalone skills section
  $("skill-graph-standalone-sec").hidden = standalone.length === 0;
  $("skill-graph-standalone").replaceChildren(...standalone.map(entry =>
    createSkillNodeElement(entry, {c, matchesFilter: matchSet.has(entry.id), isStatic: true})
  ));

  // Quest skills section
  $("skill-graph-quests-sec").hidden = questSkills.length === 0;
  $("skill-graph-quests").replaceChildren(...questSkills.map(entry =>
    createSkillNodeElement(entry, {c, matchesFilter: matchSet.has(entry.id), isStatic: true})
  ));
}

function renderSkillTree() {
  if (!snapshot || !builderInfo) return;
  const c = snapshot.character;
  const jobDef = jobMap.get(c.job);
  if (!jobDef) return;
  const used = spentSkillPoints(jobDef, c.skills ?? {});
  const maxPts = totalSkillPointsFor(jobDef, c.jobLv, currentFirstJobLv);
  const remain = maxPts - used;

  const pill = $("skill-points-summary");
  pill.textContent = remain >= 0
    ? `已配技能點：${used} ／ ${maxPts}（剩餘 ${remain} 點）`
    : `超出技能點：${Math.abs(remain)} 點（已配 ${used} ／ ${maxPts}）`;
  pill.classList.toggle("is-over", remain < 0);
  $("tab-badge-skills").textContent = `${used}/${maxPts}`;

  const term = $("skill-tree-search").value.trim().normalize("NFKC").toLowerCase();
  const autoCastSet = new Set(
    (snapshot.config?.skills ?? [])
      .filter(s => s.use === "attack" && s.enabled !== false)
      .map(s => s.skill)
  );
  const skillNameById = new Map(jobDef.skillTree.map(s => [s.id, s.name]));

  const filtered = jobDef.skillTree.filter(entry => {
    const lv = c.skills?.[entry.id] ?? 0;
    if (skillFilterMode === "attack" && !entry.attack) return false;
    if (skillFilterMode === "learned" && lv <= 0) return false;
    if (!term) return true;
    return `${entry.name} ${entry.id} ${entry.desc}`.normalize("NFKC").toLowerCase().includes(term);
  });
  const matchSet = new Set(filtered.map(s => s.id));

  const isTree = skillViewMode === "tree";
  for (const b of document.querySelectorAll("[data-skill-view]")) {
    b.classList.toggle("is-active", b.dataset.skillView === skillViewMode);
  }
  if ($("skill-view-hint")) {
    $("skill-view-hint").textContent = isTree
      ? "點擊技能或「＋」會自動補足前置等級（綠色實線箭頭＝已達成，虛線箭頭＝未達成）；右鍵或「−」降級。"
      : "清單模式：點擊「＋／滿」同樣會自動補足前置技能等級；已學的主動攻擊技能可勾選「掛機施放」。";
  }
  $("skill-tree-graph-wrap").hidden = !isTree;
  $("skill-tree-list").hidden = isTree;
  if (isTree) {
    renderSkillTreeGraph(jobDef, matchSet, autoCastSet, skillNameById);
    return;
  }

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "沒有符合篩選條件的技能。";
    $("skill-tree-list").replaceChildren(empty);
    return;
  }

  $("skill-tree-list").replaceChildren(...filtered.map(entry => {
    const lv = c.skills?.[entry.id] ?? 0;
    const card = document.createElement("div");
    card.className = "skill-card";
    if (lv > 0) card.classList.add("is-learned");

    const head = document.createElement("div");
    head.className = "skill-card-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "skill-title-wrap";
    const nameEl = document.createElement("div");
    nameEl.className = "skill-name";
    nameEl.textContent = entry.name;

    const badges = document.createElement("div");
    badges.className = "skill-badges";
    if (entry.attack) {
      const b = document.createElement("span");
      b.className = "mini-tag tag-attack";
      b.textContent = "主動攻擊";
      badges.append(b);
    }
    if (entry.questJobLv != null) {
      const b = document.createElement("span");
      b.className = "mini-tag tag-quest";
      b.textContent = `任務技能（免點數）`;
      badges.append(b);
    }
    if (entry.requires) {
      for (const [reqId, reqLv] of Object.entries(entry.requires)) {
        const met = (c.skills?.[reqId] ?? 0) >= reqLv;
        const b = document.createElement("span");
        b.className = `mini-tag ${met ? "tag-ok" : "tag-req"}`;
        b.textContent = `前置 ${skillNameById.get(reqId) ?? reqId} Lv${reqLv}`;
        badges.append(b);
      }
    }
    titleWrap.append(nameEl, badges);

    const left = document.createElement("div");
    left.className = "skill-card-left";
    left.append(createSkillIconEl(entry), titleWrap);

    const lvBadge = document.createElement("span");
    lvBadge.className = "skill-lv-badge";
    lvBadge.textContent = `Lv ${lv}/${entry.maxLv}`;
    head.append(left, lvBadge);

    const desc = document.createElement("p");
    desc.className = "skill-desc";
    desc.textContent = entry.desc || entry.id;
    desc.title = entry.desc || entry.id;

    const foot = document.createElement("div");
    foot.className = "skill-card-foot";

    const stepper = document.createElement("div");
    stepper.className = "skill-stepper";
    const b0 = document.createElement("button");
    b0.type = "button"; b0.textContent = "0"; b0.disabled = lv <= 0;
    b0.onclick = () => setSkillLevel(entry.id, 0);
    const bm = document.createElement("button");
    bm.type = "button"; bm.textContent = "−"; bm.disabled = lv <= 0;
    bm.onclick = () => setSkillLevel(entry.id, lv - 1);
    const bp = document.createElement("button");
    bp.type = "button"; bp.textContent = "+"; bp.disabled = lv >= entry.maxLv;
    bp.onclick = () => setSkillLevel(entry.id, lv + 1);
    const bmax = document.createElement("button");
    bmax.type = "button"; bmax.textContent = "滿"; bmax.disabled = lv >= entry.maxLv;
    bmax.onclick = () => setSkillLevel(entry.id, entry.maxLv);
    stepper.append(b0, bm, bp, bmax);

    foot.append(stepper);

    if (entry.attack && lv > 0) {
      const autoLabel = document.createElement("label");
      autoLabel.className = "check inline-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = autoCastSet.has(entry.id);
      cb.onchange = () => toggleAutoCastSkill(entry.id, cb.checked);
      autoLabel.append(cb, "掛機施放");
      foot.append(autoLabel);
    }

    card.append(head, desc, foot);
    return card;
  }));
}

// =========================================================================
// TAB 3: Equipment / Refine / Card Editor
// =========================================================================

function effectiveSlotEntry(slot) {
  if (Object.hasOwn(equipOverrides, slot)) {
    const ov = equipOverrides[slot];
    if (!ov || ov.itemId === null) return null;
    return {itemId: ov.itemId, refine: ov.refine ?? 0, cards: [...(ov.cards ?? [])], broken: false};
  }
  const orig = equipCatalog?.equipped?.[slot];
  return orig ? {itemId: orig.itemId, refine: orig.refine ?? 0, cards: [...(orig.cards ?? [])], broken: !!orig.broken} : null;
}

function computeBlockedSlots() {
  const blocked = new Map();
  if (!equipCatalog) return blocked;
  const weapon = effectiveSlotEntry("weapon");
  const weaponDef = weapon ? itemMap.get(weapon.itemId) : null;
  if (weaponDef?.weaponType && TWO_HANDED_TYPES.has(weaponDef.weaponType)) {
    blocked.set("shield", `雙手武器（${weaponDef.name}）佔用`);
  }
  for (const head of HEAD_SLOTS) {
    const entry = effectiveSlotEntry(head);
    const def = entry ? itemMap.get(entry.itemId) : null;
    if (!def) continue;
    for (const s of def.slots) {
      if (s !== head && HEAD_SLOTS.includes(s)) blocked.set(s, `由 ${def.name} 佔用`);
    }
  }
  return blocked;
}

function cardSlotTypeFor(slot, itemDef) {
  if (HEAD_SLOTS.includes(slot)) return "headgear";
  if (slot === "accessory1" || slot === "accessory2") return "accessory";
  if (slot === "shield" && itemDef?.weaponType) return "weapon";
  return slot;
}

function canEquipLeftHandNow() {
  if (!equipCatalog?.canDualWield) return false;
  const weapon = effectiveSlotEntry("weapon");
  const weaponDef = weapon ? itemMap.get(weapon.itemId) : null;
  return Boolean(weaponDef?.weaponType && !TWO_HANDED_TYPES.has(weaponDef.weaponType));
}

function itemMatchesSlot(item, slot, allowAnyDualWield = false) {
  if (slot === "accessory1" || slot === "accessory2") {
    return item.slots.includes("accessory1") || item.slots.includes("accessory2");
  }
  if (slot === "shield") {
    if (item.slots.includes("shield")) return true;
    const allowLeft = allowAnyDualWield ? Boolean(equipCatalog?.canDualWield) : canEquipLeftHandNow();
    return allowLeft && Boolean(item.weaponType && LEFT_HAND_TYPES.has(item.weaponType));
  }
  return item.slots[0] === slot;
}

function isSameAsOriginal(slot, patch) {
  const orig = equipCatalog?.equipped?.[slot] ?? null;
  if (!orig && (!patch || patch.itemId === null)) return true;
  if (!orig || !patch || patch.itemId === null) return false;
  if (orig.itemId !== patch.itemId) return false;
  if ((orig.refine ?? 0) !== (patch.refine ?? 0)) return false;
  const a = (orig.cards ?? []).filter(Boolean);
  const b = (patch.cards ?? []).filter(Boolean);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function setSlotOverride(slot, patch) {
  if (isSameAsOriginal(slot, patch)) delete equipOverrides[slot];
  else equipOverrides[slot] = patch;

  if (patch && patch.itemId !== null) {
    const def = itemMap.get(patch.itemId);
    if (slot === "weapon" && def?.weaponType && TWO_HANDED_TYPES.has(def.weaponType)) {
      if (effectiveSlotEntry("shield")) {
        if (equipCatalog.equipped.shield) equipOverrides.shield = {itemId: null};
        else delete equipOverrides.shield;
      }
    }
    if (slot === "shield") {
      const w = effectiveSlotEntry("weapon");
      const wDef = w ? itemMap.get(w.itemId) : null;
      if (wDef?.weaponType && TWO_HANDED_TYPES.has(wDef.weaponType)) {
        if (equipCatalog.equipped.weapon) equipOverrides.weapon = {itemId: null};
        else delete equipOverrides.weapon;
      }
    }
    if (HEAD_SLOTS.includes(slot) && def) {
      for (const other of HEAD_SLOTS) {
        if (other === slot) continue;
        const otherEntry = effectiveSlotEntry(other);
        const otherDef = otherEntry ? itemMap.get(otherEntry.itemId) : null;
        if (otherDef && otherDef.slots.some(s => def.slots.includes(s))) {
          if (equipCatalog.equipped[other]) equipOverrides[other] = {itemId: null};
          else delete equipOverrides[other];
        }
      }
    }
  }
  renderGearGrid();
  if (selectedSlot) renderSlotEditor(selectedSlot, {preserveSearch: true});
  scheduleStats();
}

function formatItemStatsBrief(item) {
  const parts = [];
  if (item.weaponType) parts.push(weaponTypeLabel[item.weaponType] ?? item.weaponType);
  if (item.atk) parts.push(`ATK ${item.atk}`);
  if (item.def) parts.push(`DEF ${item.def}`);
  if (item.cardSlots) parts.push(`${item.cardSlots}洞`);
  if (item.equipLevel > 1) parts.push(`Lv.${item.equipLevel}`);
  if (!item.equippable) parts.push(item.jobMatch ? "等級不足" : "跨職業");
  return parts.join(" · ");
}

function renderGearGrid() {
  if (!equipCatalog) return;
  const blocked = computeBlockedSlots();
  const modifiedCount = Object.keys(equipOverrides).length;
  const badge = $("gear-override-badge");
  badge.hidden = modifiedCount === 0;
  badge.textContent = `已自訂 ${modifiedCount} 個部位`;
  $("gear-reset-all").disabled = modifiedCount === 0;
  const tabBadge = $("tab-badge-gear");
  tabBadge.hidden = modifiedCount === 0;
  tabBadge.textContent = String(modifiedCount);

  $("gear-grid").replaceChildren(...equipCatalog.slots.map(({id, name}) => {
    const entry = effectiveSlotEntry(id);
    const def = entry ? itemMap.get(entry.itemId) : null;
    const isModified = Object.hasOwn(equipOverrides, id);
    const blockedBy = blocked.get(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gear-slot-card";
    btn.setAttribute("role", "listitem");
    if (selectedSlot === id) btn.classList.add("is-selected");
    if (isModified) btn.classList.add("is-modified");
    if (blockedBy && !def) btn.classList.add("is-blocked");

    const top = document.createElement("div");
    top.className = "gear-slot-top";
    const slotLabel = document.createElement("span");
    slotLabel.textContent = name;
    top.append(slotLabel);
    if (isModified) {
      const tag = document.createElement("span");
      tag.className = "gear-slot-tag";
      tag.textContent = "已改";
      top.append(tag);
    }

    const title = document.createElement("div");
    title.className = "gear-slot-name";
    if (def) {
      const refStr = entry.refine > 0 ? `+${entry.refine} ` : "";
      const slotStr = def.cardSlots > 0 ? ` [${def.cardSlots}]` : "";
      title.textContent = `${refStr}${def.name}${slotStr}${entry.broken ? "（損壞）" : ""}`;
    } else if (blockedBy) {
      title.textContent = `（${blockedBy}）`;
    } else {
      title.textContent = "（無裝備）";
    }

    const sub = document.createElement("div");
    sub.className = "gear-slot-cards";
    if (def) {
      const cardNames = (entry.cards ?? []).filter(Boolean).map(cid => cardMap.get(cid)?.name ?? `#${cid}`);
      if (cardNames.length) sub.textContent = cardNames.join("、");
      else if (def.cardSlots > 0) sub.textContent = `${def.cardSlots} 空插槽`;
      else sub.textContent = formatItemStatsBrief(def);
    } else {
      sub.textContent = "點擊選擇裝備";
    }

    btn.append(top, title, sub);
    btn.onclick = () => {
      selectedSlot = selectedSlot === id ? null : id;
      renderGearGrid();
      if (selectedSlot) {
        renderSlotEditor(selectedSlot, {preserveSearch: false});
        $("slot-editor").scrollIntoView({behavior: "smooth", block: "nearest"});
      } else {
        $("slot-editor").hidden = true;
      }
    };
    return btn;
  }));
}

function renderSlotEditor(slot, {preserveSearch = false} = {}) {
  if (!equipCatalog || !slot) {
    $("slot-editor").hidden = true;
    return;
  }
  const slotInfo = equipCatalog.slots.find(s => s.id === slot);
  const entry = effectiveSlotEntry(slot);
  const currentDef = entry ? itemMap.get(entry.itemId) : null;
  const isModified = Object.hasOwn(equipOverrides, slot);

  $("slot-editor").hidden = false;
  $("slot-editor-title").textContent = `編輯部位：${slotInfo?.name ?? slot}`;
  $("slot-reset").disabled = !isModified;
  $("slot-unequip").disabled = !entry;

  if (!preserveSearch) {
    $("slot-item-search").value = "";
    $("slot-card-search").value = "";
  }

  const ownedMatches = equipCatalog.owned.filter(stack => {
    const def = itemMap.get(stack.itemId);
    return def && itemMatchesSlot(def, slot, true);
  });
  $("slot-owned-row").hidden = ownedMatches.length === 0;
  if (ownedMatches.length) {
    $("slot-owned-select").replaceChildren(
      new Option("— 從背包挑選裝備套用 —", ""),
      ...ownedMatches.map(stack => {
        const def = itemMap.get(stack.itemId);
        const ref = stack.refine ? `+${stack.refine} ` : "";
        const cNames = stack.cards.map(cid => cardMap.get(cid)?.name ?? `#${cid}`).join("、");
        return new Option(
          `${ref}${def.name}${def.cardSlots ? ` [${def.cardSlots}]` : ""}${cNames ? ` · ${cNames}` : ""}${stack.broken ? "（損壞）" : ""}`,
          String(stack.uid)
        );
      })
    );
  }

  renderSlotItemOptions(slot, entry);
  renderSlotRefineAndCards(slot, entry, currentDef);
}

function renderSlotItemOptions(slot, entry) {
  const term = $("slot-item-search").value.trim().normalize("NFKC").toLowerCase();
  const equippableOnly = $("slot-equippable-only").checked;
  const candidates = equipCatalog.items.filter(item => {
    if (!itemMatchesSlot(item, slot, !equippableOnly)) return false;
    if (equippableOnly && !item.equippable && item.id !== entry?.itemId) return false;
    if (!term) return true;
    return `${item.name} ${item.id} ${item.desc}`.normalize("NFKC").toLowerCase().includes(term);
  });
  $("slot-item-count").textContent = `（符合 ${candidates.length} 件）`;
  const select = $("slot-item-select");
  select.replaceChildren(
    new Option("（無裝備／卸下）", ""),
    ...candidates.map(item => {
      const brief = formatItemStatsBrief(item);
      return new Option(`${item.name}${brief ? ` · ${brief}` : ""} · #${item.id}`, String(item.id));
    })
  );
  select.value = entry ? String(entry.itemId) : "";
  const def = entry ? itemMap.get(entry.itemId) : null;
  $("slot-item-desc").textContent = def
    ? [formatItemStatsBrief(def), def.desc].filter(Boolean).join("\n")
    : "目前未裝備任何物品。";
}

function renderSlotRefineAndCards(slot, entry, def) {
  const refineBlock = $("slot-refine-block");
  if (def && def.refineable) {
    refineBlock.hidden = false;
    const refSel = $("slot-refine-select");
    if (!refSel.options.length) {
      refSel.replaceChildren(...Array.from({length: 11}, (_, i) => new Option(`+${i}`, String(i))));
    }
    const refine = Math.max(0, Math.min(10, entry?.refine ?? 0));
    refSel.value = String(refine);
    $("slot-refine-minus").disabled = refine <= 0;
    $("slot-refine-plus").disabled = refine >= 10;
  } else {
    refineBlock.hidden = true;
  }

  const cardsBlock = $("slot-cards-block");
  const maxSlots = def?.cardSlots ?? 0;
  if (!def || maxSlots <= 0) {
    cardsBlock.hidden = true;
    return;
  }
  cardsBlock.hidden = false;
  $("slot-cards-fill-all").hidden = maxSlots < 2;
  renderSlotCardPickers(slot, entry, def);
}

function renderSlotCardPickers(slot, entry, def) {
  const maxSlots = def.cardSlots;
  const slotType = cardSlotTypeFor(slot, def);
  const term = $("slot-card-search").value.trim().normalize("NFKC").toLowerCase();
  const currentCards = Array.from({length: maxSlots}, (_, idx) => entry?.cards?.[idx] ?? 0);
  const matchingCards = equipCatalog.cards.filter(card => {
    if (card.slotType !== slotType) return false;
    if (!term) return true;
    return `${card.name} ${card.id} ${card.desc}`.normalize("NFKC").toLowerCase().includes(term);
  });

  $("slot-cards-list").replaceChildren(...currentCards.map((selectedCardId, idx) => {
    const row = document.createElement("div");
    row.className = "card-slot-row";
    const label = document.createElement("label");
    label.textContent = `插槽 ${idx + 1}`;
    const select = document.createElement("select");
    const options = [new Option("（空插槽）", "")];
    if (selectedCardId && !matchingCards.some(c => c.id === selectedCardId)) {
      const currentCard = cardMap.get(selectedCardId);
      if (currentCard) options.push(new Option(`${currentCard.name} · #${currentCard.id}`, String(currentCard.id)));
    }
    for (const card of matchingCards) {
      const brief = card.desc ? ` — ${card.desc.replace(/\s+/g, " ").slice(0, 42)}` : "";
      options.push(new Option(`${card.name}${brief}`, String(card.id)));
    }
    select.replaceChildren(...options);
    select.value = selectedCardId ? String(selectedCardId) : "";

    const desc = document.createElement("p");
    desc.className = "card-slot-desc";
    const chosenCard = selectedCardId ? cardMap.get(selectedCardId) : null;
    desc.textContent = chosenCard?.desc ?? "";

    select.onchange = () => {
      const nextCards = [...currentCards];
      nextCards[idx] = select.value ? Number(select.value) : 0;
      const latest = effectiveSlotEntry(slot);
      if (!latest) return;
      setSlotOverride(slot, {
        itemId: latest.itemId,
        refine: latest.refine,
        cards: nextCards.filter(Boolean),
      });
    };
    row.append(label, select, desc);
    return row;
  }));
}

function initEquipmentEditor(catalog, keepOverrides = false) {
  equipCatalog = catalog;
  if (!keepOverrides) {
    equipOverrides = {};
    selectedSlot = null;
  }
  itemMap = new Map(catalog.items.map(item => [item.id, item]));
  cardMap = new Map(catalog.cards.map(card => [card.id, card]));
  renderGearGrid();
  if (selectedSlot) renderSlotEditor(selectedSlot, {preserveSearch: true});
  else $("slot-editor").hidden = true;
}

// =========================================================================
// TAB 4: Buffs & Monster Statuses
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
  if (definition.stats) {
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
      const {level, seconds: duration, ...performer} = Object.fromEntries(
        [...row.querySelectorAll("[data-parameter]")].map(input => [input.dataset.parameter, Number(input.value)])
      );
      return {id: row.dataset.effect, level, seconds: duration, performer};
    });
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

function cleanEquipOverrides() {
  const keys = Object.keys(equipOverrides);
  return keys.length ? structuredClone(equipOverrides) : undefined;
}

function readScenario() {
  return {
    includeActive: [...$("active-buffs").querySelectorAll("input:checked")].map(input => Number(input.value)),
    keepActiveBuffs: $("keep-active-buffs").checked,
    buffs: readEffects("extra-buffs"),
    statuses: readEffects("monster-statuses"),
    autoBuffs: $("auto-buffs").checked,
    ammoItemId: $("ammo-choice").value ? Number($("ammo-choice").value) : undefined,
    equipOverrides: cleanEquipOverrides(),
  };
}

// =========================================================================
// TAB 5: Monsters, Live Stats Sidebar & DPS Results
// =========================================================================

let mobSkillListVersion = 0;
let mobSkillTestVersion = 0;
let activeMobSkillKey = null;

async function loadMobSkills(monsterId) {
  const tester = $("mob-skill-tester");
  const btnWrap = $("mob-skill-buttons");
  const resultBox = $("mob-skill-result");
  const ver = ++mobSkillListVersion;
  activeMobSkillKey = null;
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
  activeMobSkillKey = entry.key;
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
  CH_SOULCOLLECT: "狂蓄氣",
  MO_CALLSPIRITS: "蓄氣",
  MO_EXPLOSIONSPIRITS: "爆氣",
  MO_TRIPLEATTACK: "六合拳",
  MO_CHAINCOMBO: "連環全身掌",
  MO_COMBOFINISH: "猛龍誇強",
  CH_TIGERFIST: "伏虎拳",
  WS_CARTBOOST: "手推車加速",
  TF_HIDING: "隱匿",
};

function updateSkillPrereqHint() {
  const box = $("skill-prereq-hint");
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
    else warnList.push("尚未學習「蓄氣」或「狂蓄氣」，將無法補充氣彈");
  }
  if (needsExplosion) {
    if ((learned.MO_EXPLOSIONSPIRITS ?? 0) > 0) autoList.push(`爆氣 Lv.${learned.MO_EXPLOSIONSPIRITS}`);
    else warnList.push("尚未學習「爆氣」，無法發動此技能");
  }
  if (needsCombo) {
    if ((learned.MO_TRIPLEATTACK ?? 0) > 0) autoList.push(`六合拳 Lv.${learned.MO_TRIPLEATTACK}（普攻觸發）`);
    else warnList.push("尚未學習「六合拳」，無法起手接續連技");
    for (let i = 0; i < comboIdx; i++) {
      const pid = MONK_COMBO_CHAIN[i];
      if ((learned[pid] ?? 0) > 0) autoList.push(`${PREREQ_LABEL[pid]} Lv.${learned[pid]}`);
      else warnList.push(`尚未學習前置連技「${PREREQ_LABEL[pid]}」`);
    }
  }
  if (sid === "WS_CARTTERMINATION") {
    if ((learned.WS_CARTBOOST ?? 0) > 0) autoList.push(`手推車加速 Lv.${learned.WS_CARTBOOST}`);
    else warnList.push("尚未學習「手推車加速」，無法施放手推車終結技");
  }
  if (HIDING_ATTACK_SKILLS.has(sid)) {
    if ((learned.TF_HIDING ?? 0) > 0) autoList.push(`隱匿 Lv.${learned.TF_HIDING}`);
    else warnList.push("尚未學習「隱匿」，無法施放此技能");
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
    lastPreview = preview;
    const {base, current, names, allocated, hasEquipOverrides, atkDetail, pet} = preview;
    const parts = [];
    if (hasEquipOverrides) parts.push("自訂裝備");
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
    renderStatRadar();
    if (activeTab === "build") renderStatAllocator();
  } catch (error) {
    if (version === statsVersion) $("stats-caption").textContent = error.message;
  }
}

async function refreshAttackSkillsAndStats() {
  if (!snapshot) return;
  skills = await engine("skills");
  renderAttackSkillSelector();
  await showStats();
}

async function refreshDerivedCatalogs() {
  if (!snapshot) return;
  const [nextSkills, nextCatalog] = await Promise.all([engine("skills"), engine("equipment")]);
  skills = nextSkills;
  renderAttackSkillSelector();
  initEquipmentEditor(nextCatalog, true);
  await showStats();
}

async function applyLoadedSnapshot(nextSnapshot, {
  save = true,
  isCustom = false,
  rebirths,
  firstJobLv = 50,
  overrides = {},
  sourceLabel = "",
} = {}) {
  $("fields").disabled = true;
  if ($("refresh")) $("refresh").disabled = true;
  statsVersion++;
  $("result").hidden = true;
  $("status").textContent = "正在載入角色與配點資料…";
  try {
    await Promise.all([ensureTargets(), ensureBuilder()]);
    snapshot = normalizeSnapshot(nextSnapshot);
    currentIsCustom = Boolean(isCustom);
    originalImportedSnapshot = isCustom ? null : structuredClone(snapshot);
    const jobDef = jobMap.get(snapshot.character.job);
    currentRebirths = Math.max(0, Math.min(MAX_REBIRTHS, Math.trunc(rebirths ?? (jobDef?.upper ? 1 : 0))));
    currentFirstJobLv = firstJobLv ?? 50;
    selectedSkillId = null;

    const [nextSkills, nextScenario, nextCatalog] = await Promise.all([
      engine("skills"),
      engine("scenario"),
      engine("equipment"),
    ]);
    skills = nextSkills;
    scenario = nextScenario;
    renderScenario();
    equipOverrides = overrides ? structuredClone(overrides) : {};
    selectedSlot = null;
    initEquipmentEditor(nextCatalog, true);
    renderAttackSkillSelector();
    fillMonsters();
    renderBuildTab();
    renderSkillTree();

    if (save && !isExtension) {
      upsertSavedCharacter(snapshot, {
        isCustom: currentIsCustom,
        rebirths: currentRebirths,
        firstJobLv: currentFirstJobLv,
        overrides: equipOverrides,
      });
    } else if (!isExtension) {
      renderSavedBar();
    }
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
    const [loadedSnap] = await Promise.all([readCharacterFromExtension(), ensureTargets(), ensureBuilder()]);
    await applyLoadedSnapshot(loadedSnap, {save: false, isCustom: false});
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
  $("timeline").replaceChildren(...timeline.map(({at, text, hp, kind}) => {
    const row = document.createElement("li");
    row.dataset.kind = kind;
    const time = document.createElement("time");
    time.textContent = (at / 1000).toFixed(2).padStart(6, "0");
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
  $("summon-summary").hidden = result.summons.count === 0;
  $("summon-summary").textContent = `召喚物 DPS ${format(result.summons.dps)} · 含召喚物 DPS ${format(result.summons.totalDps)} · ${result.trials} 次合計召喚 ${format(result.summons.count)} 隻、擊倒 ${format(result.summons.kills)} 隻`;
  $("summary").textContent = `${result.trials} 次 × ${result.seconds} 秒 · ${result.killedTrials} 次完成首殺 · ${result.unlimitedSp ? "無限 SP" : `期末平均 SP ${format(result.endingSp)}`}${result.mobDefense ? " · 含怪物防禦技" : " · 關閉怪物防禦技"}${result.invincible ? " · 角色不死" : ""}`;
  $("combat-stats").textContent = `起始普攻：${element[panel.element] ?? panel.element}屬性 ×${format(panel.modifier / 100)} · 攻擊間隔 ${seconds(panel.interval)}`;

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

// Theme toggle
$("theme-toggle").onclick = () => {
  const isDark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
};

// Mobile stats expand/collapse
$("mobile-stats-toggle").onclick = () => {
  const sidebar = $("character-panel");
  const expanded = sidebar.classList.toggle("is-expanded");
  $("mobile-stats-toggle").setAttribute("aria-expanded", String(expanded));
  $("mobile-stats-toggle").textContent = expanded ? "收合完整能力" : "展開完整能力";
};

// Tabs
for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.onclick = () => switchTab(btn.dataset.tab);
}
$("quick-go-sim").onclick = () => switchTab("simulate");

// Build tab events
$("build-name").oninput = () => {
  if (!snapshot) return;
  snapshot.character.name = $("build-name").value.trim() || "自訂角色";
  updateHeaderRole();
};

function setRebirthCount(nextCount) {
  if (!snapshot || !builderInfo) return;
  const clamped = Math.max(0, Math.min(MAX_REBIRTHS, Math.trunc(nextCount) || 0));
  const wasUpper = currentRebirths >= 1;
  const nowUpper = clamped >= 1;
  currentRebirths = clamped;
  let jobChanged = false;
  if (wasUpper !== nowUpper) {
    const curJob = snapshot.character.job;
    const mapped = nowUpper ? (NORMAL_TO_UPPER[curJob] ?? "lord_knight") : (UPPER_TO_NORMAL[curJob] ?? "knight");
    if (jobMap.has(mapped)) {
      snapshot.character.job = mapped;
      jobChanged = true;
    }
  }
  void handleJobOrLevelChange({jobChanged});
}

$("rebirth-0").onclick = () => setRebirthCount(0);
$("rebirth-1").onclick = () => setRebirthCount(1);
$("rebirth-11").onclick = () => setRebirthCount(11);
$("build-rebirths").onchange = () => setRebirthCount(Number($("build-rebirths").value));

$("build-job").onchange = () => {
  if (!snapshot) return;
  snapshot.character.job = $("build-job").value;
  const jobDef = jobMap.get(snapshot.character.job);
  if (jobDef) snapshot.character.jobLv = jobDef.maxJobLv;
  void handleJobOrLevelChange({jobChanged: true});
};

$("build-base-lv").onchange = () => {
  if (!snapshot) return;
  snapshot.character.baseLv = Math.max(1, Math.min(99, Math.trunc(Number($("build-base-lv").value) || 1)));
  void handleJobOrLevelChange();
};
$("build-base-max").onclick = () => {
  if (!snapshot) return;
  snapshot.character.baseLv = 99;
  void handleJobOrLevelChange();
};

$("build-job-lv").onchange = () => {
  if (!snapshot) return;
  const maxJL = jobMap.get(snapshot.character.job)?.maxJobLv ?? 70;
  snapshot.character.jobLv = Math.max(1, Math.min(maxJL, Math.trunc(Number($("build-job-lv").value) || 1)));
  void handleJobOrLevelChange();
};
$("build-job-max").onclick = () => {
  if (!snapshot) return;
  const maxJL = jobMap.get(snapshot.character.job)?.maxJobLv ?? 70;
  snapshot.character.jobLv = maxJL;
  void handleJobOrLevelChange();
};

$("build-first-job-lv").onchange = () => {
  currentFirstJobLv = Math.max(40, Math.min(50, Math.trunc(Number($("build-first-job-lv").value) || 50)));
  $("build-first-job-lv").value = String(currentFirstJobLv);
  renderSkillTree();
};

$("build-riding").onchange = () => {
  if (!snapshot) return;
  snapshot.character.riding = $("build-riding").checked;
  scheduleStats();
};
$("build-falcon").onchange = () => {
  if (!snapshot) return;
  snapshot.character.falcon = $("build-falcon").checked;
  scheduleStats();
};
$("build-pet-search").oninput = renderPetSelector;
$("build-pet").onchange = () => {
  if (!snapshot) return;
  const val = $("build-pet").value;
  if (!val) {
    snapshot.pet = null;
  } else {
    const mob = Number(val);
    const def = petMap.get(mob);
    const keepLoyal = snapshot.pet ? $("build-pet-loyal").checked : true;
    snapshot.pet = {
      mob,
      egg: def?.egg ?? 0,
      intimacy: keepLoyal ? 1000 : 250,
      hunger: 100,
    };
  }
  renderPetSelector();
  scheduleStats();
};
$("build-pet-loyal").onchange = () => {
  if (!snapshot?.pet) return;
  snapshot.pet.intimacy = $("build-pet-loyal").checked ? 1000 : 250;
  renderPetSelector();
  scheduleStats();
};

$("build-free-stats").onchange = renderStatAllocator;
$("build-stats-reset").onclick = () => {
  if (!snapshot) return;
  for (const k of STAT_KEYS) snapshot.character.stats[k] = 1;
  renderStatAllocator();
  scheduleStats();
};

$("revert-imported-char").onclick = () => {
  if (!originalImportedSnapshot) return;
  void applyLoadedSnapshot(structuredClone(originalImportedSnapshot), {
    save: false, isCustom: false, sourceLabel: "已還原原遊戲快照",
  });
};

// Skill tab events
for (const viewBtn of document.querySelectorAll("[data-skill-view]")) {
  viewBtn.onclick = () => {
    skillViewMode = viewBtn.dataset.skillView;
    try { localStorage.setItem(SKILL_VIEW_STORAGE_KEY, skillViewMode); } catch {}
    renderSkillTree();
  };
}
$("build-free-skills").onchange = renderSkillTree;
$("skill-tree-search").oninput = renderSkillTree;
for (const pill of document.querySelectorAll("[data-skill-filter]")) {
  pill.onclick = () => {
    skillFilterMode = pill.dataset.skillFilter;
    for (const p of document.querySelectorAll("[data-skill-filter]")) p.classList.toggle("is-active", p === pill);
    renderSkillTree();
  };
}
$("skills-learn-quests").onclick = () => {
  if (!snapshot || !builderInfo) return;
  const jobDef = jobMap.get(snapshot.character.job);
  if (!jobDef) return;
  for (const entry of jobDef.skillTree) {
    if (entry.questJobLv != null) snapshot.character.skills[entry.id] = entry.maxLv;
  }
  renderSkillTree();
  void refreshAttackSkillsAndStats();
};
$("skills-reset").onclick = () => {
  if (!snapshot || !builderInfo) return;
  const jobDef = jobMap.get(snapshot.character.job);
  snapshot.character.skills = jobDef?.skillTree.some(s => s.id === "NV_BASIC") ? {NV_BASIC: 9} : {};
  if (snapshot.config?.skills) snapshot.config.skills = [];
  renderSkillTree();
  void refreshAttackSkillsAndStats();
};

// Gear tab events
$("gear-reset-all").onclick = () => {
  equipOverrides = {};
  renderGearGrid();
  if (selectedSlot) renderSlotEditor(selectedSlot, {preserveSearch: true});
  scheduleStats();
};
$("slot-reset").onclick = () => {
  if (!selectedSlot) return;
  delete equipOverrides[selectedSlot];
  renderGearGrid();
  renderSlotEditor(selectedSlot, {preserveSearch: true});
  scheduleStats();
};
$("slot-unequip").onclick = () => {
  if (!selectedSlot) return;
  setSlotOverride(selectedSlot, {itemId: null});
};
$("slot-owned-select").onchange = () => {
  if (!selectedSlot || !$("slot-owned-select").value) return;
  const uid = Number($("slot-owned-select").value);
  const stack = equipCatalog?.owned.find(item => item.uid === uid);
  $("slot-owned-select").value = "";
  if (!stack) return;
  setSlotOverride(selectedSlot, {itemId: stack.itemId, refine: stack.refine ?? 0, cards: [...(stack.cards ?? [])]});
};
$("slot-item-search").oninput = () => {
  if (selectedSlot) renderSlotItemOptions(selectedSlot, effectiveSlotEntry(selectedSlot));
};
$("slot-equippable-only").onchange = () => {
  if (selectedSlot) renderSlotItemOptions(selectedSlot, effectiveSlotEntry(selectedSlot));
};
$("slot-item-select").onchange = () => {
  if (!selectedSlot) return;
  const val = $("slot-item-select").value;
  if (!val) {
    setSlotOverride(selectedSlot, {itemId: null});
    return;
  }
  const itemId = Number(val);
  const def = itemMap.get(itemId);
  const prev = effectiveSlotEntry(selectedSlot);
  const prevDef = prev ? itemMap.get(prev.itemId) : null;
  const sameCardType = prevDef && cardSlotTypeFor(selectedSlot, prevDef) === cardSlotTypeFor(selectedSlot, def);
  const refine = def?.refineable ? Math.min(10, prev?.refine ?? 0) : 0;
  const cards = sameCardType ? (prev?.cards ?? []).slice(0, def?.cardSlots ?? 0) : [];
  setSlotOverride(selectedSlot, {itemId, refine, cards});
};

function updateRefine(nextRefine) {
  if (!selectedSlot) return;
  const entry = effectiveSlotEntry(selectedSlot);
  if (!entry) return;
  setSlotOverride(selectedSlot, {
    itemId: entry.itemId,
    refine: Math.max(0, Math.min(10, nextRefine)),
    cards: [...(entry.cards ?? [])],
  });
}
$("slot-refine-select").onchange = () => updateRefine(Number($("slot-refine-select").value));
$("slot-refine-minus").onclick = () => updateRefine(Number($("slot-refine-select").value) - 1);
$("slot-refine-plus").onclick = () => updateRefine(Number($("slot-refine-select").value) + 1);
$("slot-card-search").oninput = () => {
  if (!selectedSlot) return;
  const entry = effectiveSlotEntry(selectedSlot);
  const def = entry ? itemMap.get(entry.itemId) : null;
  if (def && def.cardSlots > 0) renderSlotCardPickers(selectedSlot, entry, def);
};
$("slot-cards-fill-all").onclick = () => {
  if (!selectedSlot) return;
  const entry = effectiveSlotEntry(selectedSlot);
  const def = entry ? itemMap.get(entry.itemId) : null;
  if (!entry || !def || def.cardSlots < 2) return;
  const firstCard = entry.cards?.[0] ?? 0;
  setSlotOverride(selectedSlot, {itemId: entry.itemId, refine: entry.refine, cards: firstCard ? Array(def.cardSlots).fill(firstCard) : []});
};

// Buff tab events
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

// Simulate tab events
$("ammo-choice").onchange = scheduleStats;
$("search").oninput = fillMonsters;
$("monster").onchange = () => { updateMonsterPreview(); scheduleStats(); };
$("skill").onchange = fillLevels;
$("mode").onchange = () => {
  $("skill-fields").hidden = $("mode").value !== "skill";
  updateSkillPrereqHint();
  scheduleStats();
};
$("invincible").onchange = () => { if ($("invincible").checked) $("counterattack").checked = true; };
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

$("calculator").onsubmit = async event => {
  event.preventDefault();
  if (!snapshot) return;
  if (!$("monster").value) {
    $("status").textContent = "請先選擇目標怪物。";
    return;
  }
  const options = {
    monsterId: Number($("monster").value),
    mode: $("mode").value,
    skill: $("skill").value,
    level: Number($("skill-level").value),
    seconds: Number($("seconds").value),
    mobDefense: $("mob-defense").checked,
    counterattack: $("counterattack").checked,
    invincible: $("invincible").checked,
    unlimitedSp: $("unlimited-sp").checked,
    scenario: readScenario(),
  };
  $("fields").disabled = true;
  if ($("refresh")) $("refresh").disabled = true;
  $("result").hidden = true;
  $("status").textContent = "正在本機模擬 16 場戰鬥…";
  try {
    show(await engine("simulate", options));
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("fields").disabled = false;
    if ($("refresh")) $("refresh").disabled = false;
  }
};

// =========================================================================
// Web Mode Setup & Character Management
// =========================================================================

function setupWebMode() {
  $("back-route").hidden = false;
  $("toggle-import").hidden = false;
  $("char-bar").hidden = false;

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

  $("open-char-api").onclick = () => {
    const id = $("char-id-input").value.trim();
    if (!/^\d+$/.test(id)) {
      $("status").textContent = "請先輸入正確的角色 ID（數字）。";
      return;
    }
    window.open(`${host}/api/characters/${id}?deferCatchup=1`, "_blank", "noopener");
  };

  $("import-json").onclick = async () => {
    const raw = $("json-input").value.trim();
    if (!raw) {
      $("status").textContent = "請先貼上角色快照或配點 JSON。";
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const isBuildExport = Boolean(parsed?.roDpsBuild && parsed?.snapshot);
      await applyLoadedSnapshot(isBuildExport ? parsed.snapshot : parsed, {
        save: true,
        isCustom: isBuildExport ? Boolean(parsed.isCustom) : false,
        rebirths: isBuildExport ? parsed.rebirths : undefined,
        firstJobLv: isBuildExport ? parsed.firstJobLv : 50,
        overrides: isBuildExport ? parsed.equipOverrides : {},
        sourceLabel: "手動匯入",
      });
      $("json-input").value = "";
    } catch (error) {
      $("status").textContent = error instanceof SyntaxError
        ? "JSON 格式不正確，請確認已完整全選複製。"
        : error.message;
    }
  };

  $("import-file").onchange = async () => {
    const file = $("import-file").files?.[0];
    $("import-file").value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const isBuildExport = Boolean(parsed?.roDpsBuild && parsed?.snapshot);
      await applyLoadedSnapshot(isBuildExport ? parsed.snapshot : parsed, {
        save: true,
        isCustom: isBuildExport ? Boolean(parsed.isCustom) : false,
        rebirths: isBuildExport ? parsed.rebirths : undefined,
        firstJobLv: isBuildExport ? parsed.firstJobLv : 50,
        overrides: isBuildExport ? parsed.equipOverrides : {},
        sourceLabel: file.name,
      });
    } catch (error) {
      $("status").textContent = error instanceof SyntaxError
        ? "檔案不是有效的 JSON 格式。"
        : error.message;
    }
  };

  $("new-custom-char").onclick = async () => {
    await ensureBuilder();
    const count = savedCharacters.filter(c => c.isCustom).length + 1;
    const fresh = createCustomSnapshot({name: `自訂角色 ${count}`, job: "lord_knight", rebirths: 1, baseLv: 99, jobLv: 70});
    activeSavedKey = "";
    await applyLoadedSnapshot(fresh, {
      save: false, isCustom: true, rebirths: 1, firstJobLv: 50, overrides: {},
      sourceLabel: "已建立新自訂角色",
    });
    switchTab("build");
  };

  $("save-current-char").onclick = () => {
    if (!snapshot) return;
    const entry = upsertSavedCharacter(snapshot, {
      isCustom: currentIsCustom,
      rebirths: currentRebirths,
      firstJobLv: currentFirstJobLv,
      overrides: equipOverrides,
    });
    $("status").textContent = `已儲存「${entry.name}」配點與裝備到瀏覽器。`;
  };

  $("saved-character").onchange = async () => {
    const key = $("saved-character").value;
    if (!key) return;
    const found = savedCharacters.find(entry => entry.key === key);
    if (!found) return;
    activeSavedKey = found.key;
    await applyLoadedSnapshot(found.snapshot, {
      save: false,
      isCustom: Boolean(found.isCustom),
      rebirths: found.rebirths,
      firstJobLv: found.firstJobLv ?? 50,
      overrides: found.equipOverrides ?? {},
      sourceLabel: found.isCustom ? "已存自訂配點" : "已存匯入角色",
    });
  };

  $("export-json").onclick = () => {
    if (!snapshot) return;
    const payload = {
      roDpsBuild: 1,
      isCustom: currentIsCustom,
      rebirths: currentRebirths,
      firstJobLv: currentFirstJobLv,
      equipOverrides: cleanEquipOverrides() ?? {},
      snapshot,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ro-idle-build-${snapshot.character.name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  $("delete-saved").onclick = async () => {
    if (!activeSavedKey) return;
    savedCharacters = savedCharacters.filter(entry => entry.key !== activeSavedKey);
    persistSavedList();
    if (savedCharacters.length) {
      const next = savedCharacters[0];
      activeSavedKey = next.key;
      renderSavedBar();
      await applyLoadedSnapshot(next.snapshot, {
        save: false,
        isCustom: Boolean(next.isCustom),
        rebirths: next.rebirths,
        firstJobLv: next.firstJobLv ?? 50,
        overrides: next.equipOverrides ?? {},
        sourceLabel: "已切換角色",
      });
    } else {
      activeSavedKey = "";
      renderSavedBar();
      const fresh = createCustomSnapshot({name: "自訂角色", job: "lord_knight", rebirths: 1, baseLv: 99, jobLv: 70});
      await applyLoadedSnapshot(fresh, {
        save: false, isCustom: true, rebirths: 1, firstJobLv: 50, overrides: {},
        sourceLabel: "已刪除紀錄並建立預設自訂角色",
      });
    }
  };

  window.addEventListener("message", event => {
    if (event.origin !== host) return;
    if (event.data?.type !== "ro-dps-snapshot" || !event.data.snapshot) return;
    try { event.source?.postMessage({type: "ro-dps-ack"}, event.origin); } catch {}
    if (location.hash === "#waiting") history.replaceState(null, "", location.pathname + location.search);
    void applyLoadedSnapshot(event.data.snapshot, {save: true, isCustom: false, sourceLabel: "從遊戲分頁傳送"});
  });

  window.addEventListener("hashchange", async () => {
    try {
      const fromHash = await decodeHashSnapshot();
      if (fromHash) await applyLoadedSnapshot(fromHash, {save: true, isCustom: false, sourceLabel: "從遊戲分頁傳送"});
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
      switchTab("simulate");
      await loadFromExtension();
      return;
    }

    setupWebMode();
    savedCharacters = loadSavedList();
    renderSavedBar();
    $("role").textContent = "正在載入職業與戰鬥引擎…";

    await Promise.all([ensureTargets(), ensureBuilder()]);

    try {
      const fromHash = await decodeHashSnapshot();
      if (fromHash) {
        await applyLoadedSnapshot(fromHash, {save: true, isCustom: false, sourceLabel: "從遊戲分頁傳送"});
        switchTab("simulate");
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
      await applyLoadedSnapshot(first.snapshot, {
        save: false,
        isCustom: Boolean(first.isCustom),
        rebirths: first.rebirths,
        firstJobLv: first.firstJobLv ?? 50,
        overrides: first.equipOverrides ?? {},
        sourceLabel: first.isCustom ? "已存自訂配點" : "已存匯入角色",
      });
    } else {
      // Immediately ready to use with a standalone custom character!
      const fresh = createCustomSnapshot({name: "自訂騎士領主", job: "lord_knight", rebirths: 1, baseLv: 99, jobLv: 70});
      await applyLoadedSnapshot(fresh, {
        save: false,
        isCustom: true,
        rebirths: 1,
        firstJobLv: 50,
        overrides: {},
        sourceLabel: "可直接開始自訂配點，或點右上「匯入遊戲角色」",
      });
    }
  } catch (error) {
    $("role").textContent = "初始化失敗";
    $("status").textContent = error?.message ?? String(error);
  }
}

void init();
