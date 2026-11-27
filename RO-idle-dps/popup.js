const $ = id => document.getElementById(id);
const ASSET_VER = "20261127-3";
const host = "https://ro-idle.app";
const gameTab = new URL(location.href).searchParams.get("gameTab");
const isExtension = Boolean(globalThis.chrome?.scripting && gameTab);
const SAVED_STORAGE_KEY = "ro-idle-dps-saved-characters-v1";
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
const TWO_HANDED_TYPES = new Set(["2hSword", "2hSpear", "2hAxe", "2hMace", "2hStaff", "bow", "katar"]);
const LEFT_HAND_TYPES = new Set(["dagger", "1hSword", "1hAxe"]);
const HEAD_SLOTS = ["headTop", "headMid", "headLow"];
const EDITABLE_SLOTS = [
  "headTop", "headMid", "headLow", "weapon", "shield",
  "armor", "garment", "shoes", "accessory1", "accessory2",
];

let worker, snapshot, scenario, equipCatalog, targets = [], skills = [], sequence = 0;
let equipOverrides = {};
let selectedSlot = null;
let itemMap = new Map();
let cardMap = new Map();
let savedCharacters = [];
let activeSavedKey = "";
let useDirectEngine = false;
let directEnginePromise = null;
let targetsPromise = null;
const requests = new Map();

async function runDirectEngine(action, options) {
  if (!directEnginePromise) {
    directEnginePromise = import(`./engine.js?v=${ASSET_VER}`);
  }
  const eng = await directEnginePromise;
  return {
    targets: () => eng.targets,
    skills: () => eng.attackSkills(snapshot),
    scenario: () => eng.scenarioCatalog(snapshot),
    equipment: () => eng.equipmentCatalog(snapshot),
    character: () => eng.previewCharacter(snapshot, options.scenario, options.mode, options.monsterId),
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
    thread.postMessage({id, action, snapshot: action === "targets" ? undefined : snapshot, options});
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

function normalizeSnapshot(raw) {
  const s = raw?.snapshot?.character ? raw.snapshot : raw;
  if (!s || typeof s !== "object" || !s.character?.name || !s.config || !Array.isArray(s.inventory) || !s.equipment) {
    throw new Error("角色快照格式不完整，請確認複製的是 /api/characters/ID?deferCatchup=1 的完整 JSON。");
  }
  const {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet} = s;
  return {character, inventory, equipment, buffs, ailments, cart, config, mapId, heldItems, pet};
}

function charStorageKey(snap) {
  return `${snap.character.name}::${snap.character.job ?? ""}`;
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

function upsertSavedCharacter(snap) {
  const key = charStorageKey(snap);
  const entry = {
    key,
    name: snap.character.name,
    baseLv: snap.character.baseLv,
    jobLv: snap.character.jobLv,
    job: snap.character.job ?? "",
    savedAt: Date.now(),
    snapshot: snap,
  };
  savedCharacters = [entry, ...savedCharacters.filter(item => item.key !== key)].slice(0, 20);
  activeSavedKey = key;
  persistSavedList();
  renderSavedBar();
}

function formatTimeShort(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSavedBar() {
  if (isExtension) return;
  const bar = $("saved-bar");
  bar.hidden = savedCharacters.length === 0;
  if (!savedCharacters.length) return;
  const sel = $("saved-character");
  sel.replaceChildren(...savedCharacters.map(entry =>
    new Option(`${entry.name} · Base ${entry.baseLv}／Job ${entry.jobLv} · ${formatTimeShort(entry.savedAt)}`, entry.key)));
  if (savedCharacters.some(entry => entry.key === activeSavedKey)) sel.value = activeSavedKey;
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

function fillMonsters() {
  const term = $("search").value.trim().normalize("NFKC").toLowerCase();
  const current = $("monster").value;
  const found = targets.filter(({id, name}) => String(id).includes(term) || name.toLowerCase().includes(term));
  $("monster").replaceChildren(new Option(found.length ? "請選擇怪物" : "沒有符合的怪物", ""),
    ...found.map(({name, lv, id}) => new Option(`${name} · Lv ${lv} · #${id}`, id)));
  if (found.some(({id}) => String(id) === current)) $("monster").value = current;
  else if (term && found.length === 1) $("monster").value = String(found[0].id);
  scheduleStats();
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
  ammo.replaceChildren(new Option("依掛機換裝、目前裝備與補箭", ""), ...scenario.ammo.map(arrow =>
    new Option(`${arrow.name} · ${element[arrow.element] ?? arrow.element} · ${arrow.quantity ? `背包 ${format(arrow.quantity)} 支` : "模擬 1,000 支"}${arrow.configured ? " · 換裝規則" : ""}`, arrow.id)));
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
  if (!scenario.active.length) $("active-buffs").textContent = "角色目前沒有 Buff。";
  if (!$("extra-buffs").children.length) {
    $("extra-buffs").replaceChildren(...scenario.buffs.map(effectRow));
    $("monster-statuses").replaceChildren(...scenario.statuses.map(effectRow));
  }
  syncActiveBuffControls();
  filterEffects("buff");
  filterEffects("status");
}

function syncActiveBuffControls() {
  const boxes = [...$("active-buffs").querySelectorAll('input[type="checkbox"]')];
  const total = boxes.length;
  const checkedBoxes = boxes.filter(box => box.checked);
  const checked = checkedBoxes.length;
  if ($("active-buff-actions")) $("active-buff-actions").hidden = total === 0;
  if ($("quick-active-buffs-wrap")) $("quick-active-buffs-wrap").hidden = total === 0;
  if ($("keep-active-buffs-wrap")) $("keep-active-buffs-wrap").hidden = total === 0;
  if ($("active-buffs-all")) $("active-buffs-all").disabled = total === 0 || checked === total;
  if ($("active-buffs-none")) $("active-buffs-none").disabled = checked === 0;
  const quick = $("quick-active-buffs");
  if (quick) {
    quick.checked = total > 0 && checked === total;
    quick.indeterminate = checked > 0 && checked < total;
  }
  if ($("quick-active-buffs-label")) {
    $("quick-active-buffs-label").textContent = checked > 0 && checked < total
      ? `套用角色目前身上的 Buff（已選 ${checked}／${total} 項）`
      : `套用角色目前身上的 Buff（共 ${total} 項）`;
  }
  if ($("snapshot-buff-summary")) {
    $("snapshot-buff-summary").textContent = total
      ? `匯入遊戲身上的 Buff（已選 ${checked}／${total} 項）`
      : "匯入遊戲身上的 Buff（角色目前沒有 Buff）";
  }
  // Mark manual buff rows that are already active from snapshot (or share a mutually exclusive group)
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
}

function setAllActiveBuffs(checked) {
  for (const box of $("active-buffs").querySelectorAll('input[type="checkbox"]')) {
    box.checked = checked;
  }
  syncActiveBuffControls();
  scheduleStats();
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
  if (definition.group) row.dataset.group = definition.group;
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
    const {level, seconds: duration, ...performer} = Object.fromEntries([...row.querySelectorAll("[data-parameter]")]
      .map(input => [input.dataset.parameter, Number(input.value)]));
    return {id:row.dataset.effect, level, seconds: duration, performer};
  });
}

function cleanEquipOverrides() {
  const keys = Object.keys(equipOverrides);
  if (!keys.length) return undefined;
  return structuredClone(equipOverrides);
}

function readScenario() {
  return {
    includeActive: [...$("active-buffs").querySelectorAll("input:checked")].map(input => Number(input.value)),
    keepActiveBuffs: $("keep-active-buffs") ? $("keep-active-buffs").checked : true,
    buffs: readEffects("extra-buffs"),
    statuses: readEffects("monster-statuses"),
    autoBuffs: $("auto-buffs").checked,
    ammoItemId: $("ammo-choice").value ? Number($("ammo-choice").value) : undefined,
    equipOverrides: cleanEquipOverrides(),
  };
}

// =========================================================================
// Custom Equipment / Refine / Card Editor
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
      if (s !== head && HEAD_SLOTS.includes(s)) {
        blocked.set(s, `由 ${def.name} 佔用`);
      }
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
  if (isSameAsOriginal(slot, patch)) {
    delete equipOverrides[slot];
  } else {
    equipOverrides[slot] = patch;
  }
  // Keep conflicting slots consistent in the editor state.
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
      if (selectedSlot) renderSlotEditor(selectedSlot, {preserveSearch: false});
      else $("slot-editor").hidden = true;
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
  $("slot-editor-title").textContent = `編輯：${slotInfo?.name ?? slot}`;
  $("slot-reset").disabled = !isModified;
  $("slot-unequip").disabled = !entry;

  if (!preserveSearch) {
    $("slot-item-search").value = "";
    $("slot-card-search").value = "";
  }

  // Owned equipment quick-picker
  const ownedMatches = equipCatalog.owned.filter(stack => {
    const def = itemMap.get(stack.itemId);
    return def && itemMatchesSlot(def, slot, true);
  });
  const ownedRow = $("slot-owned-row");
  ownedRow.hidden = ownedMatches.length === 0;
  if (ownedMatches.length) {
    const sel = $("slot-owned-select");
    sel.replaceChildren(
      new Option("— 從背包挑選裝備套用 —", ""),
      ...ownedMatches.map(stack => {
        const def = itemMap.get(stack.itemId);
        const ref = stack.refine ? `+${stack.refine} ` : "";
        const cNames = stack.cards.map(cid => cardMap.get(cid)?.name ?? `#${cid}`).join("、");
        const label = `${ref}${def.name}${def.cardSlots ? ` [${def.cardSlots}]` : ""}${cNames ? ` · ${cNames}` : ""}${stack.broken ? "（損壞）" : ""}`;
        return new Option(label, String(stack.uid));
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
  // Refine
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

  // Cards
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
    select.dataset.cardIndex = String(idx);

    const options = [new Option("（空插槽）", "")];
    const hasSelectedInMatch = !selectedCardId || matchingCards.some(c => c.id === selectedCardId);
    if (!hasSelectedInMatch) {
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

function initEquipmentEditor(catalog) {
  equipCatalog = catalog;
  equipOverrides = {};
  selectedSlot = null;
  itemMap = new Map(catalog.items.map(item => [item.id, item]));
  cardMap = new Map(catalog.cards.map(card => [card.id, card]));
  $("gear-section").hidden = false;
  $("slot-editor").hidden = true;
  renderGearGrid();
}

// =========================================================================
// Character Stats & Simulation Output
// =========================================================================

let statsVersion = 0;
let statsTimeout;
function scheduleStats() {
  clearTimeout(statsTimeout);
  statsTimeout = setTimeout(() => { void showStats(); }, 160);
}

function showEquipment({equipment, ammo, weaponType, attackElement, missingRuleAmmo}) {
  const arrow = ammo
    ? `${ammo.name} ×${format(ammo.quantity)} · 箭矢 ATK ${format(ammo.atk)} · ${element[ammo.element] ?? ammo.element}屬性${ammo.simulated ? "（模擬庫存）" : ammo.manual ? "（手動指定）" : ammo.fromRule ? "（自動換裝）" : ammo.fromBag ? "（從背包補上）" : ""}`
    : weaponType === "bow" ? "目前使用弓，箭矢欄和背包都沒有可用的散裝箭矢。" : "箭矢欄為空。";
  $("ammo-summary").textContent = `${arrow}　｜　起始普攻：${element[attackElement] ?? attackElement}屬性` +
    (missingRuleAmmo ? `。換裝規則指定的 ${missingRuleAmmo} 目前沒有背包庫存。` : "");
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
    const preview = await engine("character", {
      scenario: readScenario(), mode: $("mode").value, monsterId: Number($("monster").value),
    });
    const {base, current, names, allocated, hasEquipOverrides} = preview;
    if (version !== statsVersion) return;
    $("character-panel").hidden = false;
    const parts = [];
    if (hasEquipOverrides) parts.push("自訂裝備");
    parts.push(names.length ? names.join("、") : "無起始 Buff");
    $("stats-caption").textContent = `基本素質＋額外加成 · ${parts.join(" · ")}`;
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
        value.title = `原始：${split(original)} ＝ ${format(original)}${active !== original ? `。變更後合計：${format(active)}` : ""}`;
        if (active !== original) {
          const diff = active - original;
          const badge = document.createElement("small");
          badge.textContent = `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))}`;
          badge.dataset.direction = diff > 0 ? "up" : "down";
          value.append(badge);
        }
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

async function applyLoadedSnapshot(nextSnapshot, {save = true, sourceLabel = ""} = {}) {
  $("fields").disabled = $("refresh").disabled = true;
  $("character-panel").hidden = true;
  $("gear-section").hidden = true;
  statsVersion++;
  $("result").hidden = true;
  $("status").textContent = "正在初始化角色與裝備資料…";
  try {
    snapshot = normalizeSnapshot(nextSnapshot);
    await ensureTargets();
    const [nextSkills, nextScenario, nextCatalog] = await Promise.all([
      engine("skills"),
      engine("scenario"),
      engine("equipment"),
    ]);
    skills = nextSkills;
    scenario = nextScenario;
    renderScenario();
    initEquipmentEditor(nextCatalog);
    $("role").textContent = `${snapshot.character.name} · Base ${snapshot.character.baseLv}／Job ${snapshot.character.jobLv}`;
    $("skill").replaceChildren(...skills.map(({id, name}) => new Option(name, id)));
    $("mode").querySelector('option[value="skill"]').disabled = !skills.length;
    if (!skills.length && $("mode").value === "skill") $("mode").value = "auto";
    $("skill-fields").hidden = $("mode").value !== "skill";
    fillLevels();
    fillMonsters();
    if (save && !isExtension) upsertSavedCharacter(snapshot);
    if (!isExtension) $("import-panel").open = false;
    $("fields").disabled = false;
    $("status").textContent = sourceLabel ? `已載入角色「${snapshot.character.name}」（${sourceLabel}）。` : "";
    await showStats();
  } catch (error) {
    snapshot = null;
    $("role").textContent = "尚未讀取角色";
    $("status").textContent = error.message;
  } finally {
    $("refresh").disabled = false;
  }
}

async function loadFromExtension() {
  $("fields").disabled = $("refresh").disabled = true;
  $("character-panel").hidden = true;
  $("gear-section").hidden = true;
  statsVersion++;
  $("result").hidden = true;
  $("status").textContent = "正在讀取角色資料…";
  try {
    const [loadedSnap, loadedTargets] = await Promise.all([readCharacterFromExtension(), engine("targets")]);
    targets = loadedTargets;
    await applyLoadedSnapshot(loadedSnap, {save: false});
  } catch (error) {
    snapshot = null;
    $("role").textContent = "尚未讀取角色";
    $("status").textContent = error.message;
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
  $("summon-summary").hidden = result.summons.count === 0;
  $("summon-summary").textContent = `召喚物 DPS ${format(result.summons.dps)} · 含召喚物 DPS ${format(result.summons.totalDps)} · ${result.trials} 次合計召喚 ${format(result.summons.count)} 隻、擊倒 ${format(result.summons.kills)} 隻`;
  $("summary").textContent = `${result.trials} 次 × ${result.seconds} 秒 · ${result.killedTrials} 次完成首殺 · ${result.unlimitedSp ? "無限 SP" : `期末平均 SP ${format(result.endingSp)}`}${result.invincible ? " · 角色免傷" : ""}`;
  $("combat-stats").textContent = `起始普攻：${element[panel.element] ?? panel.element}屬性 ×${format(panel.modifier / 100)} · ASPD ${format(panel.aspd)}／間隔 ${seconds(panel.interval)} · 命中 ${format(panel.hit)}% · 爆擊 ${format(panel.crit)}% · 對目標物理卡片與裝備倍率 ×${format(panel.cardRate)}`;
  const share = lines.reduce((sum, entry) => sum + entry.share, 0);
  const displayed = result.dps > 0 && share < 0.999 ? [...lines, {name:"其他傷害", share:1 - share, casts:0}] : lines;
  $("damage").replaceChildren(...displayed.map(entry => {
    const row = document.createElement("tr");
    const timing = entry.casts ? [entry.castMs, entry.delayMs, entry.cooldownMs]
      .map(value => seconds(value / entry.casts)).join("／") : "—";
    const range = hit => hit.min === hit.max ? format(hit.min) : `${format(hit.min)}～${format(hit.max)}`;
    const damage = [entry.normal && `一般 ${range(entry.normal)}`, entry.critical && `爆擊 ${range(entry.critical)}`]
      .filter(Boolean).join("\n") || "—";
    for (const value of [entry.name, `${format(entry.share * 100)}%`, damage, timing]) {
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

// =========================================================================
// Event Wiring
// =========================================================================

$("scenario").addEventListener("input", event => {
  if (event.target.closest("#active-buffs")) syncActiveBuffControls();
  if (event.target.type !== "search") scheduleStats();
});
if ($("quick-active-buffs")) $("quick-active-buffs").onchange = () => setAllActiveBuffs($("quick-active-buffs").checked);
if ($("keep-active-buffs")) $("keep-active-buffs").onchange = scheduleStats;
if ($("active-buffs-all")) $("active-buffs-all").onclick = () => setAllActiveBuffs(true);
if ($("active-buffs-none")) $("active-buffs-none").onclick = () => setAllActiveBuffs(false);
$("ammo-choice").onchange = scheduleStats;
$("buff-filter").oninput = () => filterEffects("buff");
$("status-filter").oninput = () => filterEffects("status");
$("search").oninput = fillMonsters;
$("skill").onchange = fillLevels;
$("mode").onchange = () => {
  $("skill-fields").hidden = $("mode").value !== "skill";
  scheduleStats();
};
$("monster").onchange = scheduleStats;

$("invincible").onchange = () => {
  if ($("invincible").checked) $("counterattack").checked = true;
};
$("counterattack").onchange = () => {
  if (!$("counterattack").checked) $("invincible").checked = false;
};

// Gear editor events
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
  setSlotOverride(selectedSlot, {
    itemId: stack.itemId,
    refine: stack.refine ?? 0,
    cards: [...(stack.cards ?? [])],
  });
};

$("slot-item-search").oninput = () => {
  if (!selectedSlot) return;
  renderSlotItemOptions(selectedSlot, effectiveSlotEntry(selectedSlot));
};

$("slot-equippable-only").onchange = () => {
  if (!selectedSlot) return;
  renderSlotItemOptions(selectedSlot, effectiveSlotEntry(selectedSlot));
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
  const clamped = Math.max(0, Math.min(10, nextRefine));
  setSlotOverride(selectedSlot, {
    itemId: entry.itemId,
    refine: clamped,
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
  const cards = firstCard ? Array(def.cardSlots).fill(firstCard) : [];
  setSlotOverride(selectedSlot, {
    itemId: entry.itemId,
    refine: entry.refine,
    cards,
  });
};

// Form submit
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
    monsterId: Number($("monster").value), mode: $("mode").value,
    skill: $("skill").value, level: Number($("skill-level").value), seconds: Number($("seconds").value),
    counterattack: $("counterattack").checked,
    invincible: $("invincible").checked,
    unlimitedSp: $("unlimited-sp").checked,
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

// Web mode initialization & events
function setupWebMode() {
  $("web-loader").hidden = false;
  if ($("back-route")) $("back-route").hidden = false;
  $("refresh").textContent = "匯入／切換角色";
  $("refresh").onclick = () => {
    const panel = $("import-panel");
    panel.open = !panel.open;
    if (panel.open) $("web-loader").scrollIntoView({behavior: "smooth", block: "nearest"});
  };

  const isHttp = location.protocol === "http:" || location.protocol === "https:";
  const pageUrl = `${location.origin}${location.pathname}`;
  const bookmarkletHref = buildBookmarklet(pageUrl);
  $("bookmarklet-link").href = bookmarkletHref;
  $("bookmarklet-link").onclick = event => {
    event.preventDefault();
    $("copy-status").textContent = "請把此按鈕拖曳到書籤列，或點左邊「複製書籤程式碼」。";
  };
  if (!isHttp) {
    $("bookmarklet-origin-hint").textContent = "目前是以本機檔案開啟，書籤跨分頁傳送需要透過 https://（如 GitHub Pages）或 localhost 網址開啟。本機檔案請先使用下方「方式二：貼上 JSON」。";
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
      $("status").textContent = "請先貼上角色快照 JSON。";
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      await applyLoadedSnapshot(parsed, {save: true, sourceLabel: "手動匯入"});
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
      const text = await file.text();
      await applyLoadedSnapshot(JSON.parse(text), {save: true, sourceLabel: file.name});
    } catch (error) {
      $("status").textContent = error instanceof SyntaxError
        ? "檔案不是有效的 JSON 格式。"
        : error.message;
    }
  };

  $("saved-character").onchange = async () => {
    const found = savedCharacters.find(entry => entry.key === $("saved-character").value);
    if (!found) return;
    activeSavedKey = found.key;
    await applyLoadedSnapshot(found.snapshot, {save: false, sourceLabel: "本機已存角色"});
  };

  $("export-json").onclick = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ro-idle-${snapshot.character.name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  $("delete-saved").onclick = () => {
    if (!activeSavedKey) return;
    savedCharacters = savedCharacters.filter(entry => entry.key !== activeSavedKey);
    persistSavedList();
    if (savedCharacters.length) {
      activeSavedKey = savedCharacters[0].key;
      renderSavedBar();
      void applyLoadedSnapshot(savedCharacters[0].snapshot, {save: false, sourceLabel: "本機已存角色"});
    } else {
      activeSavedKey = "";
      snapshot = null;
      renderSavedBar();
      $("character-panel").hidden = true;
      $("gear-section").hidden = true;
      $("result").hidden = true;
      $("fields").disabled = true;
      $("role").textContent = "尚未載入角色";
      $("import-panel").open = true;
      $("status").textContent = "已刪除該角色紀錄。";
    }
  };

  // Listen for cross-tab snapshot delivery from the bookmarklet on ro-idle.app
  window.addEventListener("message", event => {
    if (event.origin !== host) return;
    if (event.data?.type !== "ro-dps-snapshot" || !event.data.snapshot) return;
    try {
      event.source?.postMessage({type: "ro-dps-ack"}, event.origin);
    } catch {
      // Ignore cross-origin ack errors.
    }
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
    try { window.opener.postMessage({type: "ro-dps-ready"}, host); }
    catch { /* ignore */ }
  }
}

async function init() {
  try {
    if (isExtension) {
      $("refresh").onclick = loadFromExtension;
      await loadFromExtension();
      return;
    }
    setupWebMode();
    savedCharacters = loadSavedList();
    renderSavedBar();

    // Preload engine targets in background so the UI is immediately interactive.
    void ensureTargets().catch(error => {
      if (!snapshot) $("status").textContent = error.message;
    });

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
      activeSavedKey = savedCharacters[0].key;
      renderSavedBar();
      await applyLoadedSnapshot(savedCharacters[0].snapshot, {save: false, sourceLabel: "本機已存角色"});
    } else {
      $("role").textContent = "尚未載入角色 · 請選擇下方載入方式";
      $("import-panel").open = true;
    }
  } catch (error) {
    $("role").textContent = "初始化失敗";
    $("status").textContent = error?.message ?? String(error);
  }
}

void init();
