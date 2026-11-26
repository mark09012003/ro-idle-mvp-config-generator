import {weaponPlan, nextRefineCommand} from "./refine.mjs";

const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const character = $("character");
const gear = $("gear");
const selection = $("weapons");
const start = $("start");
const stop = $("stop");
const refresh = $("refresh");
const all = $("select-all");
const status = message => { $("status").textContent = message; };
let catalog, tabId, view;
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
      if (!response.ok) return {error: data.error?.message ?? `HTTP ${response.status}`};
      return {data};
    },
  });
  if (!reply?.result?.data) throw new Error(reply?.result?.error ?? "遊戲未傳回完整結果。");
  return reply.result.data;
}

function selectedPlans() {
  return plans.filter((_, index) => selection.children[index]?.firstElementChild.checked);
}

function updatePlan() {
  const chosen = selectedPlans();
  all.checked = plans.length > 0 && chosen.length === plans.length;
  all.indeterminate = chosen.length > 0 && !all.checked;
  start.disabled = busy || needsRefresh || !chosen.length;
  const materials = new Map();
  for (const plan of chosen) {
    for (const [, name] of plan.materials) materials.set(name, (materials.get(name) ?? 0) + 1);
  }
  const steps = chosen.reduce((sum, plan) => sum + plan.target - plan.from, 0);
  $("plan").textContent = steps
    ? `${chosen.length} 件，${steps} 次精練 · SP ${steps * 5} · ${[...materials].map(([name, qty]) => `${name} ×${qty}`).join("、")}`
    : "目標為武器安全值與技能等級中較低者。";
}

function renderWeapons() {
  plans = (view?.snapshot?.inventory ?? [])
    .map(item => weaponPlan(view, catalog, item.uid))
    .filter(Boolean);
  selection.replaceChildren(...plans.map(plan => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    label.append(input, `${plan.name} +${plan.from} → +${plan.target}（#${plan.uid}）`);
    return label;
  }));
  gear.disabled = busy || !plans.length;
  updatePlan();
}

async function loadGear() {
  const id = Number(character.value);
  view = null;
  needsRefresh = true;
  renderWeapons();
  if (!id) { status("請選擇神工匠角色。"); return; }
  try {
    const snapshot = await gameRequest(`/api/characters/${id}?deferCatchup=1`);
    if (Number(character.value) !== id) return;
    if (snapshot.characterId !== id || snapshot.snapshot?.character?.job !== "whitesmith") {
      throw new Error("找不到這位神工匠。");
    }
    view = snapshot;
    needsRefresh = false;
    renderWeapons();
    status(view.running ? "請先停止角色掛機。" : plans.length ? "請勾選要精練的武器。" : "沒有可精練的背包武器，請確認技能、武器等級與上鎖狀態。");
  } catch (error) {
    if (Number(character.value) === id) status(error.message);
  }
}

async function runBatch() {
  if (busy || needsRefresh) return;
  const chosen = selectedPlans();
  if (!chosen.length) return;
  const id = Number(character.value);
  const summary = $("plan").textContent;
  if (!window.confirm(`確定對 ${character.selectedOptions[0].text} 執行神工匠武器精練？\n${summary}`)) return;
  busy = true;
  cancelled = false;
  character.disabled = refresh.disabled = gear.disabled = start.disabled = true;
  stop.disabled = false;
  let completed = 0;
  try {
    for (const plan of chosen) {
      for (let level = plan.from; level < plan.target; level++) {
        if (cancelled) break;
        status(`精練 ${plan.name} +${level} → +${level + 1}…`);
        const payload = nextRefineCommand(view, catalog, plan, crypto.randomUUID());
        const response = await gameRequest(`/api/characters/${id}/commands`, payload);
        const next = response.view;
        const updated = next?.snapshot?.inventory?.find(item => item.uid === plan.uid);
        if (next?.characterId !== id || updated?.itemId !== plan.itemId || updated?.refine !== level + 1) {
          throw new Error("伺服器未確認預期精練結果。");
        }
        view = next;
        completed++;
        await new Promise(resolve => setTimeout(resolve, 450));
      }
      if (cancelled) break;
    }
    status(`${cancelled ? "已停止" : "批次完成"}。已確認 ${completed} 次精練。`);
  } catch (error) {
    needsRefresh = true;
    status(`批次停止，已確認 ${completed} 次精練。${error.message} 請先更新背包確認結果。`);
  } finally {
    busy = false;
    character.disabled = refresh.disabled = false;
    stop.disabled = true;
    renderWeapons();
  }
}

all.onchange = () => {
  for (const label of selection.children) label.firstElementChild.checked = all.checked;
  updatePlan();
};
selection.onchange = updatePlan;
character.onchange = refresh.onclick = loadGear;
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
  character.disabled = refresh.disabled = !smiths.length;
  status(smiths.length ? "請選擇神工匠角色。" : "目前帳號找不到神工匠角色。");
} catch (error) {
  status(error.message);
}
