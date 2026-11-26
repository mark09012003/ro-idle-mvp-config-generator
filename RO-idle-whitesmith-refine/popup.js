import {associateWithdrawnWeapons, batchPlan, guardedCommand, nextRefineCommand, refineOutcome, skillLevel, weaponPlan} from "./refine.mjs";

const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const character = $("character");
const gear = $("gear");
const selection = $("weapons");
const start = $("start");
const stop = $("stop");
const refresh = $("refresh");
const all = $("select-all");
const target = $("target");
const useStorage = $("storage");
const results = $("results");
const status = message => { $("status").textContent = message; };
let catalog, tabId, view, storage;
let loadVersion = 0;
let plans = [];
let busy = false;
let cancelled = false;
let needsRefresh = false;

async function gameRequest(path, payload) {
  const [reply] = await chrome.scripting.executeScript({
    target: {tabId},
    args: [host, path, payload ?? null],
    func: async (origin, requestPath, body) => {
      if (location.origin !== origin || location.pathname.startsWith("/info")) {
        throw new Error("請回到原本的遊戲分頁。");
      }
      const response = await fetch(requestPath, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(15000),
        ...(body ? {
          headers: {"content-type": "application/json", "x-ro-client": "1"},
          body: JSON.stringify(body),
        } : {}),
      });
      const data = await response.json();
      if (!response.ok) return {error: data.error?.message ?? data.message ?? (typeof data.error === "string" ? data.error : `HTTP ${response.status}`)};
      return {data};
    },
  });
  if (!reply?.result?.data) throw new Error(reply?.result?.error ?? "遊戲未傳回完整結果。");
  return reply.result.data;
}

function selectedPlans() {
  return plans.filter((_, index) => selection.children[index]?.firstElementChild.checked);
}

function planSummary(chosen, batch) {
  const materials = batch.materials.map(({name, qty, missing}) =>
    `${name} ×${qty}${missing ? `（倉庫補 ${missing}）` : ""}`);
  const stored = chosen.filter(plan => plan.source === "storage").length;
  return [
    `${chosen.length} 件武器，最多 ${batch.steps} 次精練，${batch.steps * 5} SP`,
    materials.join("、"),
    ...(batch.withdraw.length ? [`從倉庫取出 ${stored} 件武器及上列缺少材料，倉庫費 ${batch.fee} Zeny。`] : []),
    ...(chosen.some(plan => plan.rates.some(rate => rate < 100))
      ? ["有精練步驟低於 100% 成功率。失敗時武器和已插入的卡片會消失。"] : []),
  ].join("\n");
}

function updatePlan() {
  const chosen = selectedPlans();
  all.checked = plans.length > 0 && chosen.length === plans.length;
  all.indeterminate = chosen.length > 0 && !all.checked;
  start.disabled = true;
  const summary = $("plan");
  summary.textContent = "";
  if (busy || needsRefresh || !chosen.length) return;
  try {
    summary.textContent = planSummary(chosen, batchPlan(view, storage, chosen));
    start.disabled = false;
  } catch (error) {
    summary.textContent = error.message;
  }
}

function planKey(plan) {
  return plan.source === "bag" ? `bag:${plan.weapon.uid}` : `storage:${plan.weapon.sid}`;
}

function renderWeapons(preserve = false) {
  const checked = new Set(preserve ? selectedPlans().map(planKey) : []);
  const level = Number(target.value);
  plans = [
    ...(view?.snapshot?.inventory ?? []).map(item => weaponPlan(view, catalog, item, level)),
    ...(storage?.items ?? []).map(item => weaponPlan(view, catalog, item, level, "storage")),
  ].filter(Boolean);
  selection.replaceChildren(...plans.map(plan => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked.has(planKey(plan));
    const source = plan.source === "storage" ? "倉庫" : "背包";
    const lowest = Math.min(...plan.rates);
    label.append(input, `[${source}] ${plan.name} +${plan.from} → +${plan.target}（#${plan.weapon.uid ?? plan.weapon.sid}${lowest < 100 ? `，最低單步 ${lowest}%` : ""}）`);
    return label;
  }));
  gear.disabled = busy || needsRefresh || !plans.length;
  updatePlan();
}

async function getStorage() {
  const {storage: current} = await gameRequest("/api/storage");
  if (!Array.isArray(current?.items)) throw new Error("無法讀取倉庫。");
  return current;
}

async function loadGear(preserve = false) {
  const id = Number(character.value);
  const version = ++loadVersion;
  const showStorage = useStorage.checked;
  needsRefresh = true;
  target.disabled = true;
  gear.disabled = start.disabled = true;
  status("讀取物品中…");
  if (!id) {
    view = storage = null;
    renderWeapons();
    status("請選擇神工匠角色。");
    return;
  }
  try {
    const [current, box] = await Promise.all([
      gameRequest(`/api/characters/${id}?deferCatchup=1`),
      showStorage ? getStorage() : null,
    ]);
    if (version !== loadVersion) return;
    if (current.characterId !== id || current.snapshot?.character?.job !== "whitesmith" ||
        !Array.isArray(current.snapshot.inventory) || !current.snapshot.equipment) {
      throw new Error("無法讀取這位神工匠的背包。");
    }
    view = current;
    storage = box;
    const previousLevel = preserve ? Number(target.value) : 0;
    const cap = skillLevel(view);
    target.replaceChildren(new Option("安全值（100% 成功）", "0"));
    for (let level = 1; level <= cap; level++) target.add(new Option(`+${level}`, level));
    target.value = String(previousLevel <= cap ? previousLevel : 0);
    target.disabled = cap < 1 || view.running;
    needsRefresh = false;
    renderWeapons(preserve);
    status(view.running ? "請先停止角色掛機。" : plans.length
      ? "請勾選要精練的武器。" : "沒有符合目前目標的武器，請確認技能、精練等級及上鎖狀態。");
  } catch (error) {
    if (version !== loadVersion) return;
    view = storage = null;
    renderWeapons();
    status(error.message);
  }
}

function checkView(next, id) {
  if (next?.characterId !== id || !Array.isArray(next.snapshot?.inventory)) {
    throw new Error("伺服器未回傳完整的角色背包。");
  }
  return next;
}

async function runBatch() {
  if (busy || needsRefresh) return;
  let chosen = selectedPlans();
  if (!chosen.length) return;
  const id = Number(character.value);
  const roleName = character.selectedOptions[0].text;
  busy = true;
  cancelled = false;
  character.disabled = refresh.disabled = gear.disabled = start.disabled = target.disabled = useStorage.disabled = true;
  let success = 0;
  let failure = 0;
  let uncertain = 0;
  let awaitingRefine = false;
  let started = false;
  try {
    if (storage) {
      storage = await getStorage();
      for (const plan of chosen.filter(plan => plan.source === "storage")) {
        const item = storage.items.find(({sid}) => sid === plan.weapon.sid);
        if (JSON.stringify(item) !== JSON.stringify(plan.weapon)) throw new Error("選取的倉庫武器已變更。");
      }
    }
    const batch = batchPlan(view, storage, chosen);
    const weapons = chosen.map(plan =>
      `${plan.source === "storage" ? "倉庫" : "背包"} · ${plan.name} +${plan.from} → +${plan.target}`);
    if (!window.confirm(`確定由 ${roleName} 執行神工匠武器精練？\n${planSummary(chosen, batch)}\n\n${weapons.join("\n")}`)) return;
    started = true;
    results.hidden = true;
    stop.disabled = false;
    if (batch.withdraw.length) {
      status("正在從倉庫取出武器及材料…");
      const payload = guardedCommand(view, {type: "storageWithdraw", items: batch.withdraw});
      const reply = await gameRequest(`/api/characters/${id}/commands`, payload);
      const next = checkView(reply.view, id);
      chosen = associateWithdrawnWeapons(view, next, chosen);
      view = next;
    } else {
      chosen = chosen.map(plan => ({...plan, uid: plan.weapon.uid}));
    }

    for (const plan of chosen) {
      if (cancelled) break;
      for (let level = plan.from; level < plan.target; level++) {
        if (cancelled) break;
        status(`精練 ${plan.name} +${level} → +${level + 1}…`);
        const payload = nextRefineCommand(view, catalog, plan, plan.uid, level);
        awaitingRefine = true;
        const reply = await gameRequest(`/api/characters/${id}/commands`, payload);
        const next = checkView(reply.view, id);
        const outcome = refineOutcome(next, plan, level);
        view = next;
        awaitingRefine = false;
        if (outcome === "failure") {
          failure++;
          break;
        }
        if (level + 1 === plan.target) success++;
        await new Promise(resolve => setTimeout(resolve, 450));
      }
    }
    status(cancelled ? "批次已停止。" : "批次已結束。");
  } catch (error) {
    if (awaitingRefine) uncertain++;
    needsRefresh = true;
    status(`批次停止。${error.message} 請更新物品確認結果。`);
  } finally {
    busy = false;
    character.disabled = refresh.disabled = useStorage.disabled = false;
    stop.disabled = true;
    target.disabled = needsRefresh || skillLevel(view) < 1;
    if (started) {
      results.hidden = false;
      results.textContent = `成功 ${success} 件 · 失敗 ${failure} 件 · 未完成 ${chosen.length - success - failure - uncertain} 件${uncertain ? ` · 結果待確認 ${uncertain} 件` : ""}`;
      if (storage) {
        needsRefresh = true;
        target.disabled = true;
      }
    }
    renderWeapons(!started);
  }
}

all.onchange = () => {
  for (const label of selection.children) label.firstElementChild.checked = all.checked;
  updatePlan();
};
selection.onchange = updatePlan;
character.onchange = () => {
  results.hidden = true;
  loadGear();
};
refresh.onclick = useStorage.onchange = () => loadGear(true);
target.onchange = () => renderWeapons(true);
start.onclick = runBatch;
stop.onclick = () => { cancelled = true; stop.disabled = true; };

try {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.url || new URL(tab.url).origin !== host || new URL(tab.url).pathname.startsWith("/info")) {
    throw new Error("請先開啟並登入 ro-idle.app 遊戲，再點這個擴充功能。");
  }
  tabId = tab.id;
  const [items, roster] = await Promise.all([
    fetch("catalog.json").then(response => response.json()),
    gameRequest("/api/characters"),
  ]);
  catalog = items;
  const smiths = (roster.characters ?? []).filter(entry => entry.job === "whitesmith");
  for (const entry of smiths) character.append(new Option(entry.name, String(entry.id)));
  character.disabled = refresh.disabled = useStorage.disabled = !smiths.length;
  status(smiths.length ? "請選擇神工匠角色。" : "目前帳號找不到神工匠角色。");
} catch (error) {
  status(error.message);
}
