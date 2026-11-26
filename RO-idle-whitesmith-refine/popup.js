import {associateWithdrawnEquipment, batchPlan, guardedCommand, nextRefineCommand, refineOutcome, skillLevel, equipmentPlan} from "./refine.mjs";

const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const character = $("character");
const gear = $("gear");
const selection = $("equipment");
const mode = $("mode");
const start = $("start");
const stop = $("stop");
const refresh = $("refresh");
const all = $("select-all");
const target = $("target");
const storageMaterials = $("storage-materials");
const storageWeapons = $("storage-weapons");
const results = $("results");
const status = message => { $("status").textContent = message; };
let catalog, tabId, view, storage, activeRole;
let loadVersion = 0;
let plans = [];
let busy = false;
let cancelled = false;
let needsRefresh = false;

async function gameRequest(path, payload) {
  const [reply] = await chrome.scripting.executeScript({
    target: {tabId},
    args: [host, path, payload ?? null, activeRole?.name ?? null],
    func: async (origin, requestPath, body, expectedName) => {
      if (location.origin !== origin || location.pathname.startsWith("/info")) {
        throw new Error("請回到原本的遊戲分頁。");
      }
      const classicName = [...document.querySelectorAll(".xp-title .caption")]
        .map(caption => caption.textContent.trim().match(/^RO放置仙境 - \[(.+)\] .+ Lv\.\d+ \/ Job \d+$/)?.[1])
        .find(Boolean);
      const nameNode = document.querySelector(
        '.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child',
      );
      const modernName = nameNode && [...nameNode.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join("").trim();
      const name = classicName || modernName;
      if (body && (!expectedName || name !== expectedName)) return {error: "遊戲分頁已切換角色。"};
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
      return {data, name};
    },
  });
  if (!reply?.result?.data) throw new Error(reply?.result?.error ?? "遊戲未傳回完整結果。");
  if (path === "/api/characters") return {...reply.result.data, activeName: reply.result.name};
  return reply.result.data;
}

function selectedPlans() {
  return plans.filter((_, index) => selection.children[index]?.firstElementChild.checked);
}

function planSummary(chosen, batch) {
  const materials = batch.materials.map(({name, qty, missing}) =>
    `${name} ×${qty}${missing ? `（倉庫補 ${missing}）` : ""}`);
  const stored = chosen.filter(plan => plan.source === "storage").length;
  const withdrawals = [];
  if (stored) withdrawals.push(`${stored} 件裝備`);
  if (batch.materials.some(material => material.missing)) withdrawals.push("上列缺少的材料");
  return [
    `${chosen.length} 件裝備，最多 ${batch.steps} 次精練，${mode.value === "armor" ? `精練費 ${batch.zeny} Zeny` : `${batch.steps * 5} SP`}`,
    materials.join("、"),
    ...(withdrawals.length ? [`從倉庫取出 ${withdrawals.join("及")}，倉庫費 ${batch.fee} Zeny。`] : []),
    ...(chosen.some(plan => plan.rates.some(rate => rate < 100))
      ? ["有精練步驟低於 100% 成功率。失敗時裝備和已插入的卡片會消失。"] : []),
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
    summary.textContent = planSummary(chosen, batchPlan(view, storage, chosen, storageMaterials.checked));
    start.disabled = false;
  } catch (error) {
    summary.textContent = error.message;
  }
}

function planKey(plan) {
  return plan.source === "bag" ? `bag:${plan.item.uid}` : `storage:${plan.item.sid}`;
}

function renderEquipment(preserve = false) {
  const checked = new Set(preserve ? selectedPlans().map(planKey) : []);
  const level = Number(target.value);
  plans = [
    ...(view?.snapshot?.inventory ?? []).map(item => equipmentPlan(view, catalog, item, level, "bag", mode.value)),
    ...(storageWeapons.checked ? storage?.items ?? [] : []).map(item => equipmentPlan(view, catalog, item, level, "storage", mode.value)),
  ].filter(Boolean);
  selection.replaceChildren(...plans.map(plan => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked.has(planKey(plan));
    const source = plan.source === "storage" ? "倉庫" : plan.method === "npc" ? "已穿戴" : "背包";
    const lowest = Math.min(...plan.rates);
    label.append(input, `[${source}] ${plan.name} +${plan.from} → +${plan.target}（#${plan.item.uid ?? plan.item.sid}${lowest < 100 ? `，最低單步 ${lowest}%` : ""}）`);
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
  const version = ++loadVersion;
  const showStorage = storageMaterials.checked || storageWeapons.checked;
  needsRefresh = true;
  mode.disabled = target.disabled = gear.disabled = start.disabled = true;
  status("讀取物品中…");
  try {
    const {characters, activeName} = await gameRequest("/api/characters");
    if (version !== loadVersion) return;
    const matches = (characters ?? []).filter(entry => activeName && entry.name === activeName);
    if (matches.length !== 1) throw new Error("請先在遊戲分頁進入角色，再更新物品。");
    const role = matches[0];
    const [current, box] = await Promise.all([
      gameRequest(`/api/characters/${role.id}?deferCatchup=1`),
      showStorage ? getStorage() : null,
    ]);
    if (version !== loadVersion) return;
    checkView(current, role.id);
    const sameRole = activeRole?.id === role.id;
    preserve &&= sameRole;
    if (!sameRole) results.hidden = true;
    view = current;
    storage = box;
    activeRole = role;
    character.textContent = `目前角色：${role.name}`;
    const canUseSkill = skillLevel(view) > 0;
    mode.options[0].disabled = !canUseSkill;
    if (!preserve) mode.value = canUseSkill ? "weapon" : "armor";
    if (mode.value === "weapon" && !canUseSkill) mode.value = "armor";
    mode.disabled = false;
    needsRefresh = false;
    updateMode(preserve);
  } catch (error) {
    if (version !== loadVersion) return;
    view = storage = activeRole = null;
    character.textContent = "尚未辨識目前角色";
    renderEquipment();
    status(error.message);
  }
}

function updateMode(preserve) {
  const armor = mode.value === "armor";
  const previousLevel = preserve ? Number(target.value) : 0;
  const cap = armor ? 10 : skillLevel(view);
  const hasNpc = armor && catalog.refineTowns.includes(view.snapshot.mapId);
  $("mode-help").textContent = armor
    ? "防具須在有精練師的城鎮精練。未穿戴的防具只能直接精練到安全值。"
    : "使用神工匠的武器精練技能，每級消耗 1 份材料和 5 SP。";
  target.replaceChildren(new Option("安全值（100% 成功）", "0"));
  for (let level = 1; level <= cap; level++) target.add(new Option(`+${level}`, level));
  target.value = String(previousLevel <= cap ? previousLevel : 0);
  target.disabled = needsRefresh || view.running || (armor && !hasNpc);
  renderEquipment(preserve);
  status(view.running ? "請先停止角色掛機。" : armor && !hasNpc
    ? "請先到有精練師的城鎮。" : plans.length
      ? "請勾選要精練的裝備。" : "沒有符合目前目標的裝備。");
}

function checkView(next, id) {
  if (next?.characterId !== id || !Array.isArray(next.snapshot?.inventory) || !next.snapshot.equipment || !next.snapshot.character) {
    throw new Error("伺服器未回傳完整的角色背包。");
  }
  return next;
}

async function runBatch() {
  if (busy || needsRefresh) return;
  let chosen = selectedPlans();
  if (!chosen.length) return;
  const {id, name: roleName} = activeRole;
  busy = true;
  cancelled = false;
  mode.disabled = refresh.disabled = gear.disabled = start.disabled = target.disabled = storageMaterials.disabled = storageWeapons.disabled = true;
  let success = 0;
  let failure = 0;
  let uncertain = 0;
  let awaitingRefine = false;
  let started = false;
  try {
    if (storage) {
      storage = await getStorage();
      for (const plan of chosen.filter(plan => plan.source === "storage")) {
        const item = storage.items.find(({sid}) => sid === plan.item.sid);
        if (JSON.stringify(item) !== JSON.stringify(plan.item)) throw new Error("選取的倉庫裝備已變更。");
      }
    }
    const batch = batchPlan(view, storage, chosen, storageMaterials.checked);
    const items = chosen.map(plan =>
      `${plan.source === "storage" ? "倉庫" : "背包"} · ${plan.name} +${plan.from} → +${plan.target}`);
    if (!window.confirm(`確定由 ${roleName} 執行批次精練？\n${planSummary(chosen, batch)}\n\n${items.join("\n")}`)) return;
    started = true;
    results.hidden = true;
    stop.disabled = false;
    if (batch.withdraw.length) {
      status("正在取出倉庫物品…");
      const payload = guardedCommand(view, {type: "storageWithdraw", items: batch.withdraw});
      const reply = await gameRequest(`/api/characters/${id}/commands`, payload);
      const next = checkView(reply.view, id);
      chosen = associateWithdrawnEquipment(view, next, chosen);
      view = next;
    } else {
      chosen = chosen.map(plan => ({...plan, uid: plan.item.uid}));
    }

    for (const plan of chosen) {
      if (cancelled) break;
      let level = plan.from;
      while (!cancelled && level < plan.target) {
        const nextLevel = plan.method === "safe" ? plan.target : level + 1;
        status(`精練 ${plan.name} +${level} → +${nextLevel}…`);
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
        if (nextLevel === plan.target) success++;
        level = nextLevel;
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
    refresh.disabled = storageMaterials.disabled = storageWeapons.disabled = false;
    stop.disabled = true;
    mode.disabled = needsRefresh;
    target.disabled = needsRefresh;
    if (started) {
      results.hidden = false;
      results.textContent = `成功 ${success} 件 · 失敗 ${failure} 件 · 未完成 ${chosen.length - success - failure - uncertain} 件${uncertain ? ` · 結果待確認 ${uncertain} 件` : ""}`;
      if (storage) {
        needsRefresh = true;
        target.disabled = true;
      }
    }
    renderEquipment(!started);
  }
}

all.onchange = () => {
  for (const label of selection.children) label.firstElementChild.checked = all.checked;
  updatePlan();
};
selection.onchange = updatePlan;
mode.onchange = () => updateMode(false);
refresh.onclick = storageMaterials.onchange = storageWeapons.onchange = () => loadGear(true);
target.onchange = () => renderEquipment(true);
start.onclick = runBatch;
stop.onclick = () => { cancelled = true; stop.disabled = true; };

try {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.url || new URL(tab.url).origin !== host || new URL(tab.url).pathname.startsWith("/info")) {
    throw new Error("請先開啟並登入 ro-idle.app 遊戲，再點這個擴充功能。");
  }
  tabId = tab.id;
  catalog = await fetch("catalog.json").then(response => response.json());
  refresh.disabled = storageMaterials.disabled = storageWeapons.disabled = false;
  await loadGear();
} catch (error) {
  status(error.message);
}
