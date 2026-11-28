import {destinationConfig, handoffItems, matchMoved, planClearNewCharacter, planHandoffArrows, planHandoffZeny, profileName, rebindPlan, sameBindings, sourceHandoffConfig, validateReceiveHandoff} from "./handoff.mjs";
import {itemFingerprint, remapRules, ruleReferences, suitableItem} from "./rebind.mjs";
import {diffPurchasedBatch, groupVendorOrders, isOverHalfWeight, marketPlan, planAutoDeposit, takeVendorBatch, verifyDeposited} from "./market.mjs";
import {associateWithdrawnEquipment, batchPlan, equipmentLocation, guardedCommand, matchesEquipment, nextRefineCommand, planNextRefineWave, refineOutcome, restoreEquipment, skillLevel, equipmentPlan} from "./refine.mjs";
import {exportAllSettings, importAllSettings, removeMarketPreset, sanitizeHandoffOptions, sanitizeMarketPreset, sanitizeMarketQuery, sanitizeRefineUi, storageKeys, upsertMarketPreset} from "./settings.mjs";

const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const floatingTab = new URL(location.href).searchParams.get("gameTab");
const floating = floatingTab !== null;
const character = $("character");
const keepAwakeBtn = $("keep-awake");
const themeToggle = $("theme-toggle");
const roleMeta = $("role-meta");
const roleTown = $("role-town");
const roleWeight = $("role-weight");
const roleSlots = $("role-slots");
const roleZeny = $("role-zeny");
const gear = $("gear");
const selection = $("equipment");
const mode = $("mode");
const autoEquip = $("auto-equip");
const query = $("equipment-query");
const locationFilter = $("equipment-location");
const start = $("start");
const stop = $("stop");
const refresh = $("refresh");
const all = $("select-all");
const target = $("target");
const refineOptions = $("refine-options");
const refineOptionsSummary = $("refine-options-summary");
const storageMaterials = $("storage-materials");
const storageWeapons = $("storage-weapons");
const refineShopMetals = $("refine-shop-metals");
const refineBuyMaterials = $("refine-buy-materials");
const refineBuyOptions = $("refine-buy-options");
const refineMaxInputs = [984, 985, 1010, 1011].map(id => [id, $(`refine-max-${id}`)]);
const marketAutoStore = $("market-auto-store");
const marketPresetSelect = $("market-preset-select");
const marketPresetSave = $("market-preset-save");
const marketPresetDelete = $("market-preset-delete");
const handoffClearNew = $("handoff-clear-new");
const handoffAutoArrows = $("handoff-auto-arrows");
const handoffArrowQty = $("handoff-arrow-qty");
const handoffAutoZeny = $("handoff-auto-zeny");
const handoffZenyTarget = $("handoff-zeny-target");
const results = $("results");
const status = message => { $("status").textContent = message; };
let catalog, marketSlots, marketTowns, marketWeights, rebindItems, tabId, view, storage, activeRole;
let marketPreview;
let marketPresets = [];
let rebindPreview;
const marketAutoStoreKey = storageKeys.marketAutoStore;
const refineSupplyKey = storageKeys.refineSupply;
const rebindKey = "equipment-rebind-reference";
const handoffKey = "archer-equipment-handoff-v1";
let loadVersion = 0;
let plans = [];
let busy = false;
let cancelled = false;
let needsRefresh = false;
let focusCheckInFlight = false;

function isDarkThemeActive(theme) {
  return theme === "dark" || (!theme && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches));
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = isDarkThemeActive(theme);
  themeToggle.textContent = dark ? "☀" : "☾";
  themeToggle.title = dark ? "切換為淺色主題" : "切換為深色主題";
  themeToggle.setAttribute("aria-label", themeToggle.title);
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(storageKeys.theme);
    applyTheme(saved === "light" || saved === "dark" ? saved : "");
  } catch {
    applyTheme("");
  }
}

loadTheme();
themeToggle.onclick = () => {
  const current = document.documentElement.dataset.theme ?? "";
  const next = isDarkThemeActive(current) ? "light" : "dark";
  try { localStorage.setItem(storageKeys.theme, next); } catch {}
  applyTheme(next);
};

let keepAwakeEnabled = true;
let keepAwakeTimer = null;
let keepAwakeInitTimer = null;
let keepAwakeStep = 0;
let lastKeepAwakeAt = 0;
const keepAwakeIntervalMs = 45_000;
const keepAwakeClock = new Intl.DateTimeFormat("zh-TW", {timeStyle: "medium"});

function renderKeepAwakeButton() {
  keepAwakeBtn.hidden = !floating;
  keepAwakeBtn.classList.toggle("is-active", keepAwakeEnabled);
  keepAwakeBtn.textContent = keepAwakeEnabled ? "● 防休息" : "○ 防休息";
  const lastText = lastKeepAwakeAt ? `（上次滑動 ${keepAwakeClock.format(lastKeepAwakeAt)}）` : "";
  keepAwakeBtn.title = keepAwakeEnabled
    ? `開啟懸浮視窗時每 45 秒於遊戲分頁模擬滑鼠滑動，避免放置太久進入休息${lastText} · 點擊暫停`
    : "已暫停自動模擬滑鼠滑動 · 點擊重新啟用";
}

async function simulateMouseSlide() {
  if (!floating || !keepAwakeEnabled || !tabId) return;
  try {
    const [reply] = await chrome.scripting.executeScript({
      target: {tabId},
      args: [host, ++keepAwakeStep],
      func: (origin, step) => {
        if (location.origin !== origin || location.pathname.startsWith("/info")) return {skipped: true};
        const width = Math.max(320, window.innerWidth || 1024);
        const height = Math.max(240, window.innerHeight || 768);
        const cx = Math.round(width * 0.5) + ((step * 17) % 61) - 30;
        const cy = Math.round(height * 0.5) + ((step * 13) % 49) - 24;
        const sx = (window.screenX || 0) + cx;
        const sy = (window.screenY || 0) + cy;
        const angle = (step * 1.15) % (Math.PI * 2);
        const frames = [0, 1, 2, 3];
        let prevX = cx;
        let prevY = cy;
        for (const index of frames) {
          setTimeout(() => {
            const dist = 6 + index * 6;
            const x = Math.round(cx + Math.cos(angle + index * 0.35) * dist);
            const y = Math.round(cy + Math.sin(angle + index * 0.35) * dist);
            const screenX = Math.round(sx + (x - cx));
            const screenY = Math.round(sy + (y - cy));
            const movementX = x - prevX;
            const movementY = y - prevY;
            prevX = x;
            prevY = y;
            if (typeof PointerEvent === "function") {
              window.dispatchEvent(new PointerEvent("pointermove", {
                bubbles: true, cancelable: false, composed: true,
                pointerId: 1, pointerType: "mouse", isPrimary: true,
                clientX: x, clientY: y, screenX, screenY, movementX, movementY,
              }));
            }
            window.dispatchEvent(new MouseEvent("mousemove", {
              bubbles: true, cancelable: false,
              clientX: x, clientY: y, screenX, screenY, movementX, movementY,
            }));
          }, index * 85);
        }
        return {ok: true, visible: document.visibilityState === "visible"};
      },
    });
    if (reply?.result?.ok) {
      lastKeepAwakeAt = Date.now();
      renderKeepAwakeButton();
    }
  } catch {}
}

function syncKeepAwakeTimer(immediate = false) {
  clearInterval(keepAwakeTimer);
  clearTimeout(keepAwakeInitTimer);
  keepAwakeTimer = keepAwakeInitTimer = null;
  if (!floating || !keepAwakeEnabled || !tabId) return;
  keepAwakeTimer = setInterval(() => void simulateMouseSlide(), keepAwakeIntervalMs);
  if (immediate) keepAwakeInitTimer = setTimeout(() => void simulateMouseSlide(), 2500);
}

function loadKeepAwake() {
  try {
    keepAwakeEnabled = localStorage.getItem(storageKeys.keepAwake) !== "false";
  } catch {
    keepAwakeEnabled = true;
  }
  renderKeepAwakeButton();
  syncKeepAwakeTimer(false);
}

loadKeepAwake();
keepAwakeBtn.onclick = () => {
  keepAwakeEnabled = !keepAwakeEnabled;
  try { localStorage.setItem(storageKeys.keepAwake, String(keepAwakeEnabled)); } catch {}
  renderKeepAwakeButton();
  syncKeepAwakeTimer(keepAwakeEnabled);
};

function renderRoleMeta(currentView = view) {
  const snap = currentView?.snapshot;
  if (!snap) {
    roleMeta.hidden = true;
    return;
  }
  roleMeta.hidden = false;
  roleTown.textContent = marketTowns?.[snap.mapId] ?? snap.mapId ?? "未知城鎮";
  const weight = Number(snap.weight ?? 0);
  const weightMax = Number(snap.derived?.weightMax ?? 0);
  const pct = Number.isFinite(snap.weightPercent)
    ? Math.round(snap.weightPercent)
    : weightMax > 0 ? Math.round((weight / weightMax) * 100) : 0;
  const fmt = value => Number.isInteger(value) ? String(value) : value.toFixed(1);
  roleWeight.textContent = weightMax > 0 ? `負重 ${pct}% (${fmt(weight)}/${fmt(weightMax)})` : `負重 ${fmt(weight)}`;
  roleWeight.classList.toggle("meta-warn", isOverHalfWeight(snap));
  const slots = Array.isArray(snap.inventory) ? snap.inventory.length : 0;
  roleSlots.textContent = `背包 ${slots}/100`;
  roleSlots.classList.toggle("meta-warn", slots >= 90);
  const zeny = Number(snap.character?.zeny ?? 0);
  roleZeny.textContent = `${zeny.toLocaleString()} Z`;
}

$("open-floating").onclick = async () => {
  if (!tabId || busy) return;
  $("open-floating").disabled = true;
  try {
    const url = new URL(chrome.runtime.getURL("popup.html"));
    url.searchParams.set("gameTab", tabId);
    const windows = await chrome.windows.getAll({populate: true, windowTypes: ["popup"]});
    const existing = windows.find(candidate => candidate.tabs?.some(tab => tab.url === url.href));
    if (existing) {
      await chrome.windows.update(existing.id, {focused: true, state: "normal"});
    } else {
      await chrome.windows.create({url: url.href, type: "popup", width: 420, height: 720, focused: true});
    }
    window.close();
  } catch (error) {
    status(`無法開啟浮動視窗：${error.message}`);
  } finally {
    $("open-floating").disabled = false;
  }
};

async function gameRequest(path, payload) {
  let timeout;
  try {
    const request = chrome.scripting.executeScript({
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
          '.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child, b[class*="text-[var(--ink-name"]',
        );
        const modernName = nameNode && [...nameNode.childNodes]
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent).join("").trim();
        const name = classicName || modernName;
        if (body && (!expectedName || name !== expectedName)) return {error: "遊戲分頁已切換角色。", status: 409};
        const response = await fetch(requestPath, {
          method: body ? "POST" : "GET",
          credentials: "same-origin",
          signal: AbortSignal.timeout(15000),
          ...(body ? {
            headers: {"content-type": "application/json", "x-ro-client": "1"},
            body: JSON.stringify(body),
          } : {}),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          return {
            error: data?.error?.message ?? data?.message ?? (typeof data?.error === "string" ? data.error : `HTTP ${response.status}`),
            status: response.status,
          };
        }
        return {data, name};
      },
    });
    const [reply] = await Promise.race([request, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("讀取遊戲逾時，請確認網路後重試。")), 20000);
    })]);
    if (!reply?.result?.data) {
      throw Object.assign(new Error(reply?.result?.error ?? "遊戲未傳回完整結果。"), {
        status: reply?.result?.status ?? null,
      });
    }
    if (path === "/api/characters") return {...reply.result.data, activeName: reply.result.name};
    return reply.result.data;
  } finally {
    clearTimeout(timeout);
  }
}

function selectedPlans() {
  return plans.filter((_, index) => selection.children[index]?.firstElementChild.checked);
}

function refineSupplyOptions() {
  const vendingCaps = {};
  for (const [id, input] of refineMaxInputs) {
    const val = Number(input.value);
    if (Number.isSafeInteger(val) && val > 0) vendingCaps[id] = val;
  }
  return {
    useStorageMaterials: storageMaterials.checked,
    buyShopMetals: refineShopMetals.checked,
    buyVendingMaterials: refineBuyMaterials.checked,
    vendingCaps,
  };
}

function saveRefineSupplyOptions() {
  try {
    const caps = Object.fromEntries(refineMaxInputs.map(([id, input]) => [id, input.value.trim()]));
    localStorage.setItem(refineSupplyKey, JSON.stringify({
      shopMetals: refineShopMetals.checked,
      buyVending: refineBuyMaterials.checked,
      caps,
    }));
  } catch {}
}

function loadRefineSupplyOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(refineSupplyKey));
    refineShopMetals.checked = saved?.shopMetals !== false;
    refineBuyMaterials.checked = saved?.buyVending === true;
    for (const [id, input] of refineMaxInputs) {
      if (typeof saved?.caps?.[id] === "string") input.value = saved.caps[id];
    }
  } catch {
    refineShopMetals.checked = true;
    refineBuyMaterials.checked = false;
  }
}

function saveRefineUiPrefs() {
  try {
    localStorage.setItem(storageKeys.refineUi, JSON.stringify({
      storageMaterials: storageMaterials.checked,
      storageWeapons: storageWeapons.checked,
      autoEquip: autoEquip.checked,
      location: locationFilter.value,
      optionsOpen: refineOptions.open,
    }));
  } catch {}
}

function loadRefineUiPrefs() {
  try {
    const saved = sanitizeRefineUi(JSON.parse(localStorage.getItem(storageKeys.refineUi)));
    storageMaterials.checked = saved.storageMaterials;
    storageWeapons.checked = saved.storageWeapons;
    autoEquip.checked = saved.autoEquip;
    locationFilter.value = saved.location;
    refineOptions.open = saved.optionsOpen;
  } catch {
    refineOptions.open = false;
  }
}

function updateRefineOptionsSummary() {
  const parts = [];
  if (storageWeapons.checked) parts.push("倉庫裝備");
  if (storageMaterials.checked) parts.push("倉庫材料");
  if (refineShopMetals.checked) parts.push("商店金屬");
  if (refineBuyMaterials.checked) {
    const armor = mode.value === "armor";
    const labels = {984: "神金", 985: "鋁", 1010: "1級", 1011: "2級"};
    const activeCaps = refineMaxInputs
      .filter(([id]) => armor ? id === 985 : id !== 985)
      .map(([id, input]) => {
        const val = Number(input.value);
        return Number.isSafeInteger(val) && val > 0 ? `${labels[id]}≤${val.toLocaleString()}` : "";
      })
      .filter(Boolean);
    parts.push(activeCaps.length ? `攤位（${activeCaps.join("、")}）` : "攤位（未設上限）");
  }
  if (mode.value === "armor" && autoEquip.checked) parts.push("自動穿戴");
  refineOptionsSummary.textContent = `補給與進階設定：${parts.length ? parts.join("＋") : "無"}`;
}

function updateRefineSupplyVisibility() {
  refineBuyOptions.hidden = !refineBuyMaterials.checked;
  const armor = mode.value === "armor";
  for (const [id, input] of refineMaxInputs) {
    const relevant = armor ? id === 985 : id !== 985;
    input.closest("label").hidden = !relevant;
  }
  updateRefineOptionsSummary();
}

function setRefineSupplyDisabled(disabled) {
  storageMaterials.disabled = storageWeapons.disabled = autoEquip.disabled =
    refineShopMetals.disabled = refineBuyMaterials.disabled = disabled;
  for (const [, input] of refineMaxInputs) input.disabled = disabled;
}

function planSummary(chosen, batch) {
  const materials = batch.materials.map(({name, qty, missing, shopBuy, vendingBuy, vendingCap}) => {
    const sources = [];
    if (missing) sources.push(`倉庫補 ${missing}`);
    if (shopBuy) sources.push(`商店買 ${shopBuy}`);
    if (vendingBuy) sources.push(`攤位買 ${vendingBuy}（上限 ${vendingCap.toLocaleString()}）`);
    return `${name} ×${qty}${sources.length ? `（${sources.join("、")}）` : ""}`;
  });
  const stored = chosen.filter(plan => plan.source === "storage").length;
  const withdrawals = [];
  if (stored) withdrawals.push(`${stored} 件裝備`);
  if (batch.materials.some(material => material.missing)) withdrawals.push("上列倉庫材料");
  const storageNote = !withdrawals.length ? []
    : batch.waves > 1
      ? [`依目前負重與背包格數自動分批從倉庫領取 ${withdrawals.join("及")}（預計至少 ${batch.waves} 批，單次倉庫費 ${batch.fee} Zeny${stored ? "；完成的倉庫裝備在負重超過 50% 或空間不足時自動存回倉庫" : ""}）。`]
      : [`從倉庫取出 ${withdrawals.join("及")}，倉庫費 ${batch.fee} Zeny。`];
  const buyNotes = [];
  if (batch.shopCost > 0) {
    buyNotes.push(`商店購買一／二級金屬預計 ${batch.shopCost.toLocaleString()} Zeny（含折扣）。`);
  }
  if (batch.vendingBuy.length > 0) {
    buyNotes.push(`攤位購買材料預算上限 ${batch.vendingMaxCost.toLocaleString()} Zeny（實際依目前城鎮最低價購買）。`);
  }
  return [
    `${chosen.length} 件裝備，最多 ${batch.steps} 次精練，${mode.value === "weapon" ? `${batch.steps * 5} SP` : `精練費 ${batch.zeny.toLocaleString()} Zeny`}`,
    materials.join("、"),
    ...storageNote,
    ...buyNotes,
    ...(chosen.some(plan => plan.rates.some(rate => rate < 100))
      ? ["有精練步驟低於 100% 成功率。失敗時裝備和已插入的卡片會消失。"] : []),
  ].join("\n");
}

function updatePlan() {
  const chosen = selectedPlans();
  const visible = [...selection.children].filter(row => !row.hidden);
  const visibleSelected = visible.filter(row => row.firstElementChild.checked).length;
  const hiddenSelected = chosen.length - visibleSelected;
  all.disabled = visible.length === 0;
  all.checked = visible.length > 0 && visibleSelected === visible.length;
  all.indeterminate = visibleSelected > 0 && !all.checked;
  $("equipment-count").textContent = `顯示 ${visible.length} ／ ${plans.length} 件 · 已選 ${chosen.length} 件` +
    (hiddenSelected ? `（含篩選隱藏的 ${hiddenSelected} 件）` : "");
  start.disabled = true;
  const summary = $("plan");
  summary.textContent = "";
  if (busy || needsRefresh || !chosen.length) return;
  try {
    summary.textContent = planSummary(chosen, batchPlan(view, storage, chosen, refineSupplyOptions(), catalog));
    start.disabled = false;
  } catch (error) {
    summary.textContent = error.message;
  }
}

function planKey(plan) {
  return plan.source === "bag" ? `bag:${plan.item.uid}` : `storage:${plan.item.sid}`;
}

function renderEquipment(preserve = false) {
  renderRoleMeta(view);
  const checked = new Set(preserve ? selectedPlans().map(planKey) : []);
  const level = Number(target.value);
  plans = [
    ...(view?.snapshot?.inventory ?? []).map(item => equipmentPlan(view, catalog, item, level, "bag", mode.value, autoEquip.checked)),
    ...(storageWeapons.checked ? storage?.items ?? [] : []).map(item => equipmentPlan(view, catalog, item, level, "storage", mode.value, autoEquip.checked)),
  ].filter(Boolean);
  selection.replaceChildren(...plans.map(plan => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked.has(planKey(plan));
    const source = {storage: "倉庫", worn: "已穿戴", bag: "背包"}[equipmentLocation(plan)];
    const lowest = Math.min(...plan.rates);
    const auto = plan.needsEquip ? "，自動穿戴" : "";
    label.append(input, `[${source}] ${plan.name} +${plan.from} → +${plan.target}（#${plan.item.uid ?? plan.item.sid}${lowest < 100 ? `，最低單步 ${lowest}%` : ""}${auto}）`);
    return label;
  }));
  gear.disabled = busy || needsRefresh || !plans.length;
  applyEquipmentFilters();
}

function applyEquipmentFilters() {
  for (const [index, row] of [...selection.children].entries()) {
    row.hidden = !matchesEquipment(plans[index], query.value, locationFilter.value);
  }
  updatePlan();
}

async function getStorage() {
  const {storage: current} = await gameRequest("/api/storage");
  if (!Array.isArray(current?.items)) throw new Error("無法讀取倉庫。");
  return current;
}

async function loadGear(preserve = false) {
  if (busy) return;
  const version = ++loadVersion;
  $("market-fields").disabled = true;
  clearMarketPreview();
  clearRebind();
  $("rebind-capture").disabled = $("rebind-preview").disabled = true;
  $("handoff-send").disabled = $("handoff-receive").disabled = true;
  const showStorage = storageMaterials.checked || storageWeapons.checked;
  needsRefresh = true;
  mode.disabled = target.disabled = gear.disabled = start.disabled = true;
  character.textContent = "讀取目前角色中…";
  status("正在確認遊戲分頁的角色…");
  try {
    const {characters, activeName} = await gameRequest("/api/characters");
    if (version !== loadVersion) return;
    const matches = (characters ?? []).filter(entry => activeName && entry.name === activeName);
    if (matches.length !== 1) throw new Error("請先在遊戲分頁進入角色，再更新物品。");
    const role = matches[0];
    status(`正在讀取 ${role.name} 的背包…`);
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
    if (!preserve) mode.value = canUseSkill ? "weapon" : "weapon-npc";
    if (mode.value === "weapon" && !canUseSkill) mode.value = "weapon-npc";
    mode.disabled = $("market-fields").disabled = false;
    needsRefresh = false;
    updateMode(preserve);
    $("rebind-capture").disabled = $("rebind-preview").disabled = false;
    updateHandoff();
    void archerMonitor("status");
    if (!$("panel-growth").hidden) void renderArcherTiming();
  } catch (error) {
    if (version !== loadVersion) return;
    view = storage = activeRole = null;
    character.textContent = "尚未辨識目前角色";
    renderEquipment();
    status(error.message);
  }
}

function updateMode(preserve) {
  const usesSkill = mode.value === "weapon";
  $("auto-equip-option").hidden = mode.value !== "armor";
  updateRefineSupplyVisibility();
  const previousLevel = preserve ? Number(target.value) : 0;
  const cap = usesSkill ? skillLevel(view) : 10;
  const hasNpc = catalog.refineTowns.includes(view.snapshot.mapId);
  $("mode-help").textContent = usesSkill
    ? "使用神工匠的武器精練技能，每級消耗 1 份材料和 5 SP。"
    : "須在有精練師的城鎮。未穿戴的裝備可直接精練到安全值，其他等級需要穿戴。";
  target.replaceChildren(new Option("安全值（100% 成功）", "0"));
  for (let level = 1; level <= cap; level++) target.add(new Option(`+${level}`, level));
  target.value = String(previousLevel <= cap ? previousLevel : 0);
  target.disabled = needsRefresh || view.running || (!usesSkill && !hasNpc);
  renderEquipment(preserve);
  status(view.running ? "請先停止角色掛機。" : !usesSkill && !hasNpc
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
  busy = $("market-fields").disabled = true;
  clearMarketPreview();
  cancelled = false;
  mode.disabled = refresh.disabled = gear.disabled = start.disabled = target.disabled = true;
  setRefineSupplyDisabled(true);
  let success = 0;
  let failure = 0;
  let uncertain = 0;
  let refinedSteps = 0;
  let returnedToStorage = 0;
  let shopBought = 0;
  let shopSpent = 0;
  let vendingBought = 0;
  let vendingSpent = 0;
  let awaitingRefine = false;
  let started = false;
  const renderRefineProgress = (running, currentAction = "") => {
    results.hidden = false;
    results.classList.toggle("callout-running", running);
    const done = success + failure;
    const pending = Math.max(0, chosen.length - done - uncertain);
    const extras = [
      uncertain ? `結果待確認 ${uncertain} 件` : "",
      returnedToStorage ? `已存回倉庫 ${returnedToStorage} 件` : "",
      shopBought ? `商店補材料 ${shopBought} 個（${shopSpent.toLocaleString()} Zeny）` : "",
      vendingBought ? `攤位買材料 ${vendingBought} 個（${vendingSpent.toLocaleString()} Zeny）` : "",
    ].filter(Boolean);
    const summaryLine = running
      ? `精練中（${done}／${chosen.length} 件）· 成功 ${success} 件 · 失敗 ${failure} 件 · 已精練 ${refinedSteps} 次`
      : `成功 ${success} 件 · 失敗 ${failure} 件 · 未完成 ${pending} 件 · 共精練 ${refinedSteps} 次`;
    results.textContent = [
      summaryLine,
      ...(currentAction ? [currentAction] : []),
      ...(extras.length ? [extras.join(" · ")] : []),
    ].join("\n");
  };
  try {
    if (storage) {
      storage = await getStorage();
      for (const plan of chosen.filter(plan => plan.source === "storage")) {
        const item = storage.items.find(({sid}) => sid === plan.item.sid);
        if (JSON.stringify(item) !== JSON.stringify(plan.item)) throw new Error("選取的倉庫裝備已變更。");
      }
    }
    const supply = refineSupplyOptions();
    const batch = batchPlan(view, storage, chosen, supply, catalog);
    let vendingPreviewNote = "";
    if (batch.vendingBuy.length) {
      status("正在查詢目前城鎮攤位材料價格…");
      let estimatedVendingTotal = 0;
      const lines = [];
      let remainingZeny = view.snapshot.character.zeny - batch.fee - batch.zeny - batch.shopCost;
      for (const need of batch.vendingBuy) {
        const response = await gameRequest(`/api/vending?q=${encodeURIComponent(need.name)}`);
        if (!Array.isArray(response.shops)) throw new Error("無法讀取攤位。");
        const market = marketPlan(
          response,
          marketSlots,
          {id, mapId: view.snapshot.mapId, zeny: Math.max(0, remainingZeny)},
          {keyword: need.name, itemId: need.itemId, holes: "any", ceiling: need.maxPrice, quantity: need.qty},
          marketWeights,
        );
        if (market.count < need.qty) {
          throw new Error(`目前城鎮攤位單價 ${need.maxPrice.toLocaleString()} Zeny 以下的 ${need.name} 不足（需要 ${need.qty}，可買 ${market.count}）。`);
        }
        estimatedVendingTotal += market.total;
        remainingZeny -= market.total;
        lines.push(`${need.name} ×${need.qty} 約 ${market.total.toLocaleString()} Zeny`);
      }
      vendingPreviewNote = `\n目前攤位現貨估計：${lines.join("、")}（共約 ${estimatedVendingTotal.toLocaleString()} Zeny）。`;
    }
    const items = chosen.map(plan =>
      `${plan.source === "storage" ? "倉庫" : "背包"} · ${plan.name} +${plan.from} → +${plan.target}`);
    const equipNote = chosen.some(plan => plan.needsEquip) ? "\n將暫時更換防具，請保持擴充視窗開啟，直到原裝備還原。" : "";
    if (!window.confirm(`確定由 ${roleName} 執行批次精練？\n${planSummary(chosen, batch)}${vendingPreviewNote}${equipNote}\n\n${items.join("\n")}`)) return;
    started = true;
    renderRefineProgress(true, "準備執行批次精練…");
    stop.disabled = false;

    const send = async (current, command) => {
      const reply = await gameRequest(`/api/characters/${id}/commands`, guardedCommand(current, command));
      return checkView(reply.view, id);
    };

    const finishedStorageUids = new Set();
    const depositFinishedStorage = async reason => {
      while (finishedStorageUids.size) {
        const entries = [...finishedStorageUids].map(uid => [uid, 1]);
        const deposit = planAutoDeposit(view.snapshot, storage, entries, marketSlots);
        if (!deposit.items.length) break;
        status(`${reason}，正在將已完成的 ${deposit.totalQty} 件倉庫裝備存回倉庫…`);
        const beforeInventory = view.snapshot.inventory;
        const reply = await gameRequest(
          `/api/characters/${id}/commands`,
          guardedCommand(view, {type: "storageDeposit", items: deposit.items}),
        );
        const next = checkView(reply.view, id);
        verifyDeposited(beforeInventory, next.snapshot.inventory, deposit.items);
        view = next;
        renderRoleMeta(view);
        storage = Array.isArray(reply.storage?.items) ? reply.storage : await getStorage();
        for (const {uid} of deposit.items) finishedStorageUids.delete(uid);
        returnedToStorage += deposit.totalQty;
        renderRefineProgress(true);
      }
    };

    let remaining = chosen.map(plan => ({...plan, originSource: plan.source}));
    let waveIndex = 0;

    while (!cancelled && remaining.length) {
      const needsExternalNow = remaining.some(plan => plan.source === "storage") ||
        supply.useStorageMaterials || supply.buyShopMetals || supply.buyVendingMaterials;
      if (needsExternalNow && finishedStorageUids.size && isOverHalfWeight(view.snapshot)) {
        await depositFinishedStorage("負重超過 50%");
      }

      let wave = planNextRefineWave(view, storage, remaining, supply, catalog);
      if (!wave.wavePlans.length && finishedStorageUids.size) {
        await depositFinishedStorage("騰出負重與背包空間");
        wave = planNextRefineWave(view, storage, remaining, supply, catalog);
      }
      if (!wave.wavePlans.length) {
        throw new Error(wave.blockedReason ?? "目前負重或背包空間不足以領取或購買下一批材料。");
      }

      let wavePlans = wave.wavePlans;
      const tail = remaining.slice(wavePlans.length);

      if (wave.withdraw.length) {
        waveIndex++;
        for (const plan of wavePlans.filter(plan => plan.source === "storage")) {
          const item = storage?.items?.find(({sid}) => sid === plan.item.sid);
          if (JSON.stringify(item) !== JSON.stringify(plan.item)) throw new Error("選取的倉庫裝備已變更。");
        }
        const fee = storage?.fees?.[view.snapshot.mapId];
        if (!Number.isFinite(fee)) throw new Error("請先讓角色回到有卡普拉倉庫服務的城鎮。");
        if (view.snapshot.character.zeny < fee) throw new Error(`Zeny 不足，無法支付倉庫費 ${fee} Zeny。`);
        status(batch.waves > 1
          ? `正在依負重自動領取第 ${waveIndex} 批倉庫物品…`
          : "正在取出倉庫物品…");
        const payload = guardedCommand(view, {type: "storageWithdraw", items: wave.withdraw});
        const reply = await gameRequest(`/api/characters/${id}/commands`, payload);
        const next = checkView(reply.view, id);
        wavePlans = associateWithdrawnEquipment(view, next, wavePlans);
        view = next;
        renderRoleMeta(view);
        storage = Array.isArray(reply.storage?.items) ? reply.storage : await getStorage();
      } else {
        wavePlans = wavePlans.map(plan => ({...plan, uid: plan.uid ?? plan.item.uid}));
      }

      for (const {itemId, name, qty, unitPrice, cost} of wave.shopBuy) {
        if (cancelled) break;
        if (view.snapshot.character.zeny < cost) {
          throw new Error(`Zeny 不足，向商店購買 ${name} ×${qty} 需要 ${cost.toLocaleString()} Zeny。`);
        }
        status(`正在向金屬商人購買 ${name} ×${qty}…`);
        const beforeInventory = view.snapshot.inventory;
        const reply = await gameRequest(
          `/api/characters/${id}/commands`,
          guardedCommand(view, {type: "buy", itemId, qty, shop: catalog.metalShop.shop}),
        );
        const next = checkView(reply.view, id);
        diffPurchasedBatch(beforeInventory, next.snapshot.inventory, [{itemId, qty}]);
        view = next;
        renderRoleMeta(view);
        shopBought += qty;
        shopSpent += unitPrice * qty;
        renderRefineProgress(true);
      }

      for (const {itemId, name, qty, maxPrice} of wave.vendingBuy) {
        if (cancelled) break;
        status(`正在搜尋並向攤位購買 ${name} ×${qty}（上限 ${maxPrice.toLocaleString()} Zeny）…`);
        const response = await gameRequest(`/api/vending?q=${encodeURIComponent(name)}`);
        if (!Array.isArray(response.shops)) throw new Error("無法讀取攤位。");
        const market = marketPlan(
          response,
          marketSlots,
          {id, mapId: view.snapshot.mapId, zeny: view.snapshot.character.zeny},
          {keyword: name, itemId, holes: "any", ceiling: maxPrice, quantity: qty},
          marketWeights,
        );
        if (market.count < qty) {
          throw new Error(`目前城鎮攤位單價 ${maxPrice.toLocaleString()} Zeny 以下的 ${name} 不足（需要 ${qty}，可買 ${market.count}）。`);
        }
        for (const group of groupVendorOrders(market.orders)) {
          if (cancelled) break;
          const expectedPaid = group.orders.reduce((sum, entry) => sum + entry.item.price * entry.qty, 0);
          const groupQty = group.orders.reduce((sum, entry) => sum + entry.qty, 0);
          status(`正在向 ${group.seller} 購買 ${name} ×${groupQty}…`);
          const beforeInventory = view.snapshot.inventory;
          const reply = await gameRequest(`/api/characters/${id}/vending/buy`, {
            vendorId: group.vendorId,
            orders: group.orders.map(({item, qty: orderQty}) => ({cartUid: item.cartUid, qty: orderQty, price: item.price})),
          });
          if (reply.result?.paid !== expectedPaid) throw new Error(`未能確認向 ${group.seller} 購買 ${name} 的金額。`);
          const next = reply.view?.characterId === id && Array.isArray(reply.view?.snapshot?.inventory)
            ? checkView(reply.view, id)
            : checkView(await gameRequest(`/api/characters/${id}?deferCatchup=1`), id);
          diffPurchasedBatch(beforeInventory, next.snapshot.inventory, group.orders);
          view = next;
          renderRoleMeta(view);
          vendingBought += groupQty;
          vendingSpent += reply.result.paid;
          renderRefineProgress(true);
        }
      }

      const carryOver = [];
      for (const plan of wavePlans) {
        if (cancelled) break;
        const original = plan.needsEquip ? {...view.snapshot.equipment} : null;
        let equipConfirmed = false;
        let level = plan.from;
        let broken = false;
        const maxStepsThisWave = wave.partialMaterials && wave.stepCap ? wave.stepCap : Infinity;
        let stepsThisWave = 0;
        try {
          if (original) {
            status(`正在穿戴 ${plan.name}…`);
            view = await send(view, {type: "equip", uid: plan.uid});
            equipConfirmed = Object.values(view.snapshot.equipment).includes(plan.uid);
            if (!equipConfirmed) throw new Error("未確認穿戴成功，請檢查裝備欄。");
          }
          while (!cancelled && level < plan.target && stepsThisWave < maxStepsThisWave) {
            const nextLevel = plan.method === "safe" ? plan.target : level + 1;
            const stepText = `目前：${plan.name} +${level} → +${nextLevel}`;
            status(`精練 ${plan.name} +${level} → +${nextLevel}…`);
            renderRefineProgress(true, stepText);
            const payload = nextRefineCommand(view, catalog, plan, plan.uid, level);
            awaitingRefine = true;
            const reply = await gameRequest(`/api/characters/${id}/commands`, payload);
            const next = checkView(reply.view, id);
            view = next;
            renderRoleMeta(view);
            const outcome = refineOutcome(next, plan, level);
            awaitingRefine = false;
            const stepDelta = plan.method === "safe" ? plan.target - level : 1;
            refinedSteps += stepDelta;
            if (outcome === "failure") {
              failure++;
              broken = true;
              renderRefineProgress(true, `失敗：${plan.name}（+${level} → +${nextLevel}）`);
              break;
            }
            stepsThisWave += stepDelta;
            if (nextLevel === plan.target) {
              success++;
              if (plan.originSource === "storage") finishedStorageUids.add(plan.uid);
            }
            level = nextLevel;
            renderRefineProgress(true, nextLevel === plan.target
              ? `達成目標：${plan.name} +${nextLevel}`
              : `成功：${plan.name} +${nextLevel}`);
            await new Promise(resolve => setTimeout(resolve, 450));
          }
        } finally {
          if (original) {
            status("正在換回原裝備…");
            try {
              if (!equipConfirmed || awaitingRefine) {
                view = checkView(await gameRequest(`/api/characters/${id}?deferCatchup=1`), id);
              }
              if (view.running) throw new Error("角色已開始掛機。");
              view = await restoreEquipment(view, original, plan.uid, catalog, send);
            } catch (error) {
              throw new Error(`未能確認原裝備已還原，請檢查裝備欄。${error.message}`);
            }
          }
        }
        if (!cancelled && !broken && level < plan.target) {
          const updatedItem = view.snapshot.inventory.find(item => item.uid === plan.uid);
          if (!updatedItem) throw new Error("無法確認未完成精練裝備的背包位置。");
          const advance = level - plan.from;
          carryOver.push({
            ...plan,
            source: "bag",
            item: updatedItem,
            from: level,
            steps: plan.steps.slice(advance),
            rates: plan.rates.slice(advance),
          });
        }
      }
      remaining = [...carryOver, ...tail];
    }

    if (!cancelled && finishedStorageUids.size && isOverHalfWeight(view.snapshot)) {
      const fee = storage?.fees?.[view.snapshot.mapId];
      const canReturn = Number.isFinite(fee) && view.snapshot.character.zeny >= fee &&
        Array.isArray(storage?.items) && Number.isInteger(storage?.capacity) &&
        storage.items.length + finishedStorageUids.size <= storage.capacity;
      if (canReturn) await depositFinishedStorage("精練完成且負重超過 50%");
    }
    status(cancelled ? "批次已停止。" : "批次已結束。");
  } catch (error) {
    if (awaitingRefine) uncertain++;
    needsRefresh = true;
    status(`批次停止。${error.message} 請更新物品並確認裝備欄。`);
  } finally {
    busy = $("market-fields").disabled = false;
    refresh.disabled = false;
    setRefineSupplyDisabled(false);
    stop.disabled = true;
    mode.disabled = needsRefresh;
    target.disabled = needsRefresh;
    if (started) {
      renderRefineProgress(false);
      if (storage) {
        needsRefresh = true;
        target.disabled = true;
      }
    }
    renderEquipment(!started);
  }
}

function clearMarketPreview() {
  marketPreview = null;
  $("market-preview").hidden = true;
  $("market-preview").replaceChildren();
  $("market-buy").disabled = true;
  $("market-other").hidden = true;
  $("market-remote-list").replaceChildren();
}

async function searchMarket(role, criteria) {
  const {characters, activeName} = await gameRequest("/api/characters");
  if (activeName !== role.name || !characters?.some(entry => entry.id === role.id && entry.name === activeName)) {
    throw new Error("遊戲分頁已切換角色，請更新物品。");
  }
  const current = checkView(await gameRequest(`/api/characters/${role.id}?deferCatchup=1`), role.id);
  const {mapId, character: {zeny}} = current.snapshot;
  if (!Number.isSafeInteger(zeny) || zeny < 0) throw new Error("無法確認可用 Zeny。");
  const response = await gameRequest(`/api/vending?q=${encodeURIComponent(criteria.keyword)}`);
  if (!Array.isArray(response.shops)) throw new Error("無法讀取攤位。");
  return {...marketPlan(response, marketSlots, {id: role.id, mapId, zeny}, criteria, marketWeights), current};
}

function lockMarket(locked) {
  busy = locked;
  $("market-fields").disabled = locked;
  mode.disabled = locked || needsRefresh;
  target.disabled = gear.disabled = refresh.disabled = locked;
  setRefineSupplyDisabled(locked);
  if (locked) start.disabled = true;
  else if (view) updateMode(true);
}

function marketRow({seller, item, isEquipment, cardSlots}, qty, town) {
  const row = document.createElement("li");
  const refine = item.refine ? `+${item.refine} ` : "";
  const slotsText = isEquipment && Number.isInteger(cardSlots) ? `［${cardSlots} 洞］` : "";
  const flags = [item.unidentified && "未鑑定", item.broken && "損壞", item.cards?.some(Boolean) && "已插卡"].filter(Boolean);
  const state = flags.length ? `（${flags.join("、")}）` : "";
  row.textContent = `${refine}${item.name}${slotsText}${state} · ${item.price.toLocaleString()} Zeny ×${qty} · ${seller}` +
    (town ? ` · ${town}` : "");
  return row;
}

async function previewMarket() {
  if (busy || !activeRole) return;
  const autoStore = marketAutoStore.checked;
  const rawHoles = $("market-holes").value;
  const holes = rawHoles === "any" || rawHoles === "non-equip"
    ? rawHoles
    : rawHoles === "" ? NaN : Number(rawHoles);
  const criteria = {
    keyword: $("market-name").value.trim(),
    holes,
    ceiling: Number($("market-price").value),
    quantity: Number($("market-qty").value),
  };
  clearMarketPreview();
  const validHoles = criteria.holes === "any" || criteria.holes === "non-equip" ||
    (Number.isInteger(criteria.holes) && criteria.holes >= 0);
  if (!criteria.keyword || !validHoles ||
      !Number.isSafeInteger(criteria.ceiling) || criteria.ceiling < 1 ||
      !Number.isInteger(criteria.quantity) || criteria.quantity < 1 || criteria.quantity > 10000) {
    $("market-status").textContent = "請填寫道具名稱、篩選條件、單價上限與購買數量（1～10000）。";
    return;
  }
  lockMarket(true);
  try {
    const plan = await searchMarket(activeRole, criteria);
    let storeNote = "";
    if (plan.count && autoStore) {
      if (plan.current.running !== false) {
        throw new Error("開啟自動存倉時，請先停止角色掛機（或取消勾選自動存倉）。");
      }
      if (plan.current.snapshot.activity === "dead") {
        throw new Error("角色目前處於死亡狀態，無法使用倉庫。");
      }
      const box = await getStorage();
      const fee = box.fees?.[plan.current.snapshot.mapId];
      if (!Number.isFinite(fee)) {
        throw new Error("目前城鎮沒有卡普拉倉庫服務，請取消勾選自動存倉或改到有倉庫的城鎮。");
      }
      const alreadyHeavy = isOverHalfWeight(plan.current.snapshot);
      storeNote = ` 負重超過 50% 自動存倉（每次倉庫費 ${fee} Zeny${alreadyHeavy ? "；目前負重已超過 50%，將按攤位批次存倉" : ""}）。`;
    }
    const vendorCount = groupVendorOrders(plan.orders).length;
    const localStatus = plan.count
      ? `目前城鎮預計向 ${vendorCount} 個攤位購買 ${plan.count} 個，合計 ${plan.total.toLocaleString()} Zeny。${storeNote}`
      : plan.localMatches ? "目前 Zeny 不足。" : "目前城鎮沒有符合條件的道具。";
    $("market-status").textContent = localStatus +
      (plan.remote.length ? `其他城鎮有 ${plan.remote.length} 筆符合商品。` : "");
    $("market-remote-list").replaceChildren(...plan.remote.map(line =>
      marketRow(line, line.item.qty, marketTowns[line.mapId] ?? line.mapId)));
    $("market-other").hidden = !plan.remote.length;
    if (!plan.count) return;
    marketPreview = {criteria, plan, autoStore};
    $("market-preview").replaceChildren(...plan.orders.map(line =>
      marketRow(line, line.qty)));
    $("market-preview").hidden = false;
    $("market-buy").disabled = false;
  } catch (error) {
    $("market-status").textContent = error.message;
  } finally {
    lockMarket(false);
  }
}

async function buyMarket() {
  if (busy || !activeRole || !marketPreview) return;
  const {criteria, plan, autoStore} = marketPreview;
  const role = activeRole;
  lockMarket(true);
  let bought = 0;
  let paid = 0;
  let stored = 0;
  let storageFees = 0;
  let depositRuns = 0;
  let submitted = false;
  try {
    const fresh = await searchMarket(role, criteria);
    if (JSON.stringify(fresh.orders) !== JSON.stringify(plan.orders)) {
      throw new Error("攤位商品、價格或可購買數量已變動，請重新搜尋。");
    }
    let currentView = fresh.current;
    let storageBox = null;
    const pendingDeposit = new Map();
    if (autoStore) {
      if (currentView.running !== false) {
        throw new Error("開啟自動存倉時，請先停止角色掛機。");
      }
      if (currentView.snapshot.activity === "dead") {
        throw new Error("角色目前處於死亡狀態，無法自動存倉。");
      }
      storageBox = await getStorage();
      if (!Number.isFinite(storageBox.fees?.[currentView.snapshot.mapId])) {
        throw new Error("目前城鎮沒有卡普拉倉庫服務，無法自動存倉。");
      }
    }

    const flushAutoDeposit = async reason => {
      while (pendingDeposit.size) {
        const deposit = planAutoDeposit(currentView.snapshot, storageBox, pendingDeposit.entries(), marketSlots);
        if (!deposit.items.length) break;
        $("market-status").textContent = `已購買 ${bought}／${fresh.count} 個，${reason}，正在自動存倉（${deposit.totalQty} 個）…`;
        const beforeInventory = currentView.snapshot.inventory;
        const reply = await gameRequest(
          `/api/characters/${role.id}/commands`,
          guardedCommand(currentView, {type: "storageDeposit", items: deposit.items}),
        );
        const next = checkView(reply.view, role.id);
        verifyDeposited(beforeInventory, next.snapshot.inventory, deposit.items);
        currentView = next;
        renderRoleMeta(currentView);
        storageBox = Array.isArray(reply.storage?.items) ? reply.storage : await getStorage();
        for (const {uid, qty} of deposit.items) {
          const remaining = (pendingDeposit.get(uid) ?? 0) - qty;
          if (remaining > 0) pendingDeposit.set(uid, remaining);
          else pendingDeposit.delete(uid);
        }
        stored += deposit.totalQty;
        storageFees += deposit.fee;
        depositRuns++;
      }
    };

    for (const group of groupVendorOrders(fresh.orders)) {
      const queue = group.orders.map(order => ({...order}));
      while (queue.length) {
        if (autoStore && pendingDeposit.size && isOverHalfWeight(currentView.snapshot)) {
          await flushAutoDeposit("負重超過 50%");
        }
        let batch = takeVendorBatch(queue, currentView.snapshot, autoStore);
        if (!batch.length && autoStore && pendingDeposit.size) {
          await flushAutoDeposit("騰出負重與背包空間");
          batch = takeVendorBatch(queue, currentView.snapshot, autoStore);
        }
        if (!batch.length) {
          throw new Error("目前剩餘負重或背包空間不足，無法繼續購買。");
        }
        const expectedPaid = batch.reduce((sum, entry) => sum + entry.item.price * entry.qty, 0);
        const batchQty = batch.reduce((sum, entry) => sum + entry.qty, 0);
        if (autoStore && currentView.snapshot.character.zeny < expectedPaid) {
          throw new Error("扣除倉庫費後 Zeny 不足，無法繼續購買。");
        }
        $("market-status").textContent = `正在向 ${group.seller} 購買 ${batchQty} 個（累計 ${bought}／${fresh.count}）…`;
        submitted = true;
        const reply = await gameRequest(`/api/characters/${role.id}/vending/buy`, {
          vendorId: group.vendorId,
          orders: batch.map(({item, qty}) => ({cartUid: item.cartUid, qty, price: item.price})),
        });
        const {result} = reply;
        if (result?.paid !== expectedPaid) throw new Error("未能確認這筆購買金額。");
        bought += batchQty;
        paid += result.paid;
        if (autoStore) {
          const nextView = reply.view?.characterId === role.id && Array.isArray(reply.view?.snapshot?.inventory)
            ? checkView(reply.view, role.id)
            : checkView(await gameRequest(`/api/characters/${role.id}?deferCatchup=1`), role.id);
          const added = diffPurchasedBatch(currentView.snapshot.inventory, nextView.snapshot.inventory, batch);
          for (const entry of added) {
            pendingDeposit.set(entry.uid, (pendingDeposit.get(entry.uid) ?? 0) + entry.qty);
          }
          currentView = nextView;
          renderRoleMeta(currentView);
          if (isOverHalfWeight(currentView.snapshot) && pendingDeposit.size) {
            await flushAutoDeposit("負重超過 50%");
          }
        }
      }
    }
    const storedSummary = stored
      ? `；已自動存倉 ${stored} 個（${depositRuns} 次，倉庫費 ${storageFees.toLocaleString()} Zeny）`
      : "";
    $("market-status").textContent = `已購買 ${bought} 個，共花費 ${paid.toLocaleString()} Zeny${storedSummary}。`;
  } catch (error) {
    const storedNote = stored
      ? `（已自動存倉 ${stored} 個，倉庫費 ${storageFees.toLocaleString()} Zeny）`
      : "";
    $("market-status").textContent = `購買停止。已確認 ${bought} 個、${paid.toLocaleString()} Zeny${storedNote}。${error.message}${submitted ? " 請先確認背包與倉庫再重試。" : ""}`;
  } finally {
    clearMarketPreview();
    lockMarket(false);
    if (submitted) await loadGear(true);
  }
}

function renderMarketPresets(selectedId = "") {
  marketPresetSelect.replaceChildren(new Option("— 常用掃貨預設 —", ""));
  for (const preset of marketPresets) {
    marketPresetSelect.add(new Option(preset.name, preset.id));
  }
  marketPresetSelect.value = marketPresets.some(item => item.id === selectedId) ? selectedId : "";
  marketPresetDelete.disabled = !marketPresetSelect.value;
}

function saveMarketLastQuery() {
  try {
    localStorage.setItem(storageKeys.marketLastQuery, JSON.stringify({
      keyword: $("market-name").value,
      holes: $("market-holes").value,
      ceiling: $("market-price").value,
      quantity: $("market-qty").value,
    }));
  } catch {}
}

function saveMarketPresets() {
  try {
    localStorage.setItem(storageKeys.marketPresets, JSON.stringify(marketPresets));
  } catch {}
}

function loadMarketPrefs() {
  try {
    const savedAutoStore = localStorage.getItem(marketAutoStoreKey);
    marketAutoStore.checked = savedAutoStore === null ? true : savedAutoStore === "true";
  } catch {
    marketAutoStore.checked = true;
  }
  try {
    const last = sanitizeMarketQuery(JSON.parse(localStorage.getItem(storageKeys.marketLastQuery)));
    $("market-name").value = last.keyword;
    $("market-holes").value = last.holes;
    $("market-price").value = last.ceiling;
    $("market-qty").value = last.quantity || "1";
  } catch {}
  try {
    const raw = JSON.parse(localStorage.getItem(storageKeys.marketPresets));
    marketPresets = (Array.isArray(raw) ? raw : []).map(sanitizeMarketPreset).filter(Boolean);
  } catch {
    marketPresets = [];
  }
  renderMarketPresets();
}

loadMarketPrefs();
marketAutoStore.onchange = () => {
  try { localStorage.setItem(marketAutoStoreKey, String(marketAutoStore.checked)); } catch {}
};
marketPresetSelect.onchange = () => {
  const id = marketPresetSelect.value;
  marketPresetDelete.disabled = !id;
  const preset = marketPresets.find(item => item.id === id);
  if (!preset) return;
  $("market-name").value = preset.keyword;
  $("market-holes").value = preset.holes;
  $("market-price").value = preset.ceiling;
  $("market-qty").value = preset.quantity;
  saveMarketLastQuery();
  clearMarketPreview();
  $("market-status").textContent = `已套用常用預設「${preset.name}」，按「搜尋並預覽」即可查詢。`;
};
marketPresetSave.onclick = () => {
  try {
    marketPresets = upsertMarketPreset(marketPresets, {
      keyword: $("market-name").value,
      holes: $("market-holes").value,
      ceiling: $("market-price").value,
      quantity: $("market-qty").value,
    });
    saveMarketPresets();
    renderMarketPresets(marketPresets[0].id);
    $("market-status").textContent = `已儲存常用預設「${marketPresets[0].name}」。`;
  } catch (error) {
    $("market-status").textContent = error.message;
  }
};
marketPresetDelete.onclick = () => {
  const id = marketPresetSelect.value;
  if (!id) return;
  marketPresets = removeMarketPreset(marketPresets, id);
  saveMarketPresets();
  renderMarketPresets();
  $("market-status").textContent = "已刪除選取的常用預設。";
};
$("market-fields").oninput = event => {
  if (event.target === marketPresetSelect) return;
  saveMarketLastQuery();
  clearMarketPreview();
  $("market-status").textContent = "條件已變更，請重新搜尋。";
};
$("market-search").onclick = previewMarket;
$("market-buy").onclick = buyMarket;

function clearRebind() {
  rebindPreview = null;
  $("rebind-rows").replaceChildren();
  $("rebind-apply").disabled = true;
}

async function rebindView() {
  const role = activeRole;
  const {activeName, characters} = await gameRequest("/api/characters");
  if (activeName !== role.name || !characters?.some(entry => entry.id === role.id && entry.name === activeName)) {
    throw new Error("目前角色已切換，請先更新物品。");
  }
  const current = checkView(await gameRequest(`/api/characters/${role.id}?deferCatchup=1`), role.id);
  if (!current.snapshot.config) throw new Error("讀取不到目前角色的掛機設定。");
  return current;
}

function rebindStatus(message) {
  $("rebind-status").textContent = message;
}

function equipmentName(item) {
  const cards = (item.cards ?? []).filter(Boolean).join("、");
  return `${rebindItems[item.itemId]?.[0] ?? `道具 #${item.itemId}`} +${item.refine ?? 0}${cards ? `（卡片 ${cards}）` : ""}`;
}

function savedReference() {
  try { return JSON.parse(localStorage.getItem(rebindKey)); }
  catch { return null; }
}

async function captureRebind() {
  if (!activeRole || busy) return;
  try {
    const current = await rebindView();
    const profile = current.snapshot.profiles?.find(entry => entry.name === profileName)?.config;
    const activeRules = current.snapshot.config.equipRules ?? [];
    const rules = profile?.equipRules?.length ? profile.equipRules : activeRules;
    const refs = ruleReferences(rules);
    const items = current.snapshot.inventory.filter(item => refs.has(item.uid));
    if (!refs.size) throw new Error("原角色沒有可記錄的自動換裝規則。");
    const previous = savedReference();
    if (previous && !window.confirm(`將原本的 ${previous.name} 裝備對照替換成 ${activeRole.name}？`)) return;
    localStorage.setItem(rebindKey, JSON.stringify({
      id: current.characterId, name: current.name ?? activeRole.name, rules, items,
      ...(profile ? {config: {...profile, equipRules: rules}} : {}),
    }));
    clearRebind();
    rebindStatus(`已記錄 ${activeRole.name} 的 ${rules.length} 條規則及 ${items.length} 件裝備對照。${items.length < refs.size ? " 缺少對照的裝備可在新角色手選。" : ""}`);
  } catch (error) { rebindStatus(error.message); }
}

async function previewRebind() {
  if (!activeRole || busy) return;
  clearRebind();
  try {
    const current = await rebindView();
    const backup = savedReference();
    const {rules, useBackup, profile, create} = rebindPlan(current.snapshot, current.characterId, backup);
    const refs = ruleReferences(rules);
    if (!refs.size && !profile) throw new Error("目前沒有可重綁的規則。請先到原角色記錄換裝規則。");
    const previous = new Map(useBackup ? backup.items.map(item => [item.uid, item]) : []);
    const rows = [];
    for (const [uid, slots] of refs) {
      const original = previous.get(uid);
      const eligible = current.snapshot.inventory.filter(item => suitableItem(item, slots, rebindItems));
      const matches = original ? eligible.filter(item => itemFingerprint(item) === itemFingerprint(original)) : [];
      const field = document.createElement("select");
      field.add(new Option(profile ? "請選擇新裝備" : "保留原設定", ""));
      for (const item of eligible) field.add(new Option(`${equipmentName(item)} · UID ${item.uid}`, item.uid));
      if (matches.length === 1) field.value = String(matches[0].uid);
      const label = document.createElement("label");
      const slotNames = {weapon:"主手", shield:"副手", ammo:"箭矢", gear:"其他裝備"};
      label.textContent = `${[...slots].map(slot => slotNames[slot]).join("／")} · 舊 UID ${uid}` +
        (original ? ` · ${equipmentName(original)}${matches.length === 1 ? "" : "（需手選）"}` : "");
      label.append(field);
      $("rebind-rows").append(label);
      rows.push({uid, field});
    }
    rebindPreview = {current, rows, rules, profile, create};
    $("rebind-apply").disabled = false;
    const action = create ? "建立" : "補套用";
    rebindStatus(profile ? `將${action}「${profileName}」。${rows.length ? "請為每個舊 UID 選擇裝備。" : "目前角色沒有須重綁的裝備。"}`
      : useBackup ? `已使用 ${backup.name} 的對照，請核對預選項目。` : "未使用原角色對照，請逐項選擇替換裝備。");
  } catch (error) { rebindStatus(error.message); }
}

async function applyRebind() {
  if (!activeRole || !rebindPreview || busy) return;
  const {current, rows, rules, profile, create} = rebindPreview;
  const mapping = new Map(rows.filter(({field}) => field.value).map(({uid, field}) => [uid, Number(field.value)]));
  if (profile ? mapping.size !== rows.length : !mapping.size) {
    rebindStatus(profile ? "請為每個舊 UID 選擇裝備，再補套用規則。" : "請先選擇要重綁的裝備。");
    return;
  }
  const changed = [...mapping].filter(([old, next]) => old !== next).length;
  if (!changed && !profile) { rebindStatus("選取的裝備 UID 與原設定相同。"); return; }
  const mappingCount = profile ? mapping.size : changed;
  const detail = profile ? `並${create ? "建立" : "更新"}與套用「${profileName}」` : "";
  if (!window.confirm(`確定重綁 ${activeRole.name} 的 ${mappingCount} 個裝備 UID${detail}？`)) return;
  busy = true;
  $("rebind-apply").disabled = true;
  try {
    const fresh = await rebindView();
    if (fresh.characterId !== current.characterId || fresh.commandRevision !== current.commandRevision ||
        JSON.stringify(fresh.snapshot.config.equipRules) !== JSON.stringify(current.snapshot.config.equipRules)) {
      throw new Error("角色狀態已變更，請重新預覽。");
    }
    for (const replacement of mapping.values()) {
      const before = current.snapshot.inventory.find(item => item.uid === replacement);
      const after = fresh.snapshot.inventory.find(item => item.uid === replacement);
      if (!before || !after || itemFingerprint(before) !== itemFingerprint(after)) {
        throw new Error("背包裝備已變更，請重新預覽。");
      }
    }
    const equipRules = remapRules(rules, mapping, fresh.snapshot.inventory);
    if (profile) {
      const existing = fresh.snapshot.profiles?.find(entry => entry.name === profileName);
      if (Boolean(existing) === create) throw new Error("同名配置狀態已變更，請重新預覽確認。");
      if (create && (fresh.snapshot.profiles?.length ?? 0) >= 10) {
        throw new Error(`目前角色已存滿 10 個配置檔，請先刪除一個配置再建立「${profileName}」。`);
      }
      await saveAndApplyHandoff(fresh, {...profile, equipRules});
    } else {
      const reply = await handoffCommand(fresh, {type:"updateConfig", config:{...fresh.snapshot.config, equipRules}});
      if (!sameBindings(reply.view.snapshot.config?.equipRules, equipRules)) {
        throw new Error("伺服器未確認換裝規則，請先檢查遊戲設定。");
      }
    }
    rebindStatus(profile ? `已${create ? "建立" : "更新"}並套用「${profileName}」，重綁 ${mappingCount} 個裝備 UID。`
      : `已重綁 ${mappingCount} 個裝備 UID。`);
  } catch (error) { rebindStatus(error.message); }
  finally {
    busy = false;
    clearRebind();
    await loadGear(true);
  }
}

$("rebind-capture").onclick = captureRebind;
$("rebind-preview").onclick = previewRebind;
$("rebind-apply").onclick = applyRebind;

function readHandoff() {
  try { return JSON.parse(localStorage.getItem(handoffKey)); }
  catch { return null; }
}

function saveHandoff(record, stage) {
  record.stage = stage;
  localStorage.setItem(handoffKey, JSON.stringify(record));
}

function handoffStatus(text) { $("handoff-status").textContent = text; }

function updateHandoff() {
  const record = readHandoff();
  const id = activeRole?.id;
  $("handoff-clear").hidden = !record;
  $("handoff-send").disabled = !id || (record && (record.stage !== "preparing" || record.source !== id));
  $("handoff-receive").disabled = !id || !record || record.source === id ||
    !(record.stage === "stored" || (record.stage === "received" && record.target === id));
  if (record?.stage === "stored") handoffStatus(`已存好 ${record.items.length} 件裝備。請切到同帳號的新角色領取。`);
  if (record?.stage === "received") handoffStatus("裝備已領出，可繼續建立並套用配置。");
  if (record?.stage.endsWith("Pending")) handoffStatus("上一筆存取結果待確認，請直接檢查背包及倉庫，避免重複操作。");
}

async function handoffAccount() {
  const me = await gameRequest("/api/auth/me");
  const account = me.user ?? me.account ?? me;
  const id = account.accountId ?? account.userId ?? account.uid ?? account.id;
  if (id == null || String(id) === "") throw new Error("無法確認目前登入帳號。");
  return String(id);
}

function handoffFee(current, box) {
  const fee = box.fees?.[current.snapshot.mapId];
  if (!Number.isFinite(fee)) throw new Error("請到有卡普拉服務的城鎮。");
  if (current.snapshot.character.zeny < fee) throw new Error(`倉庫費需要 ${fee} Zeny。`);
  return fee;
}

async function handoffCommand(current, command) {
  const result = await gameRequest(`/api/characters/${current.characterId}/commands`, guardedCommand(current, command));
  return {...result, view: checkView(result.view, current.characterId)};
}

async function sendHandoff(current, account, record) {
  if (current.snapshot.activity === "dead") throw new Error("角色目前處於死亡狀態，無法使用倉庫。");
  const box = await getStorage();
  const fee = handoffFee(current, box);
  if (record && (record.account !== account || record.source !== current.characterId || record.stage !== "preparing")) {
    throw new Error("目前已有一筆裝備交接。");
  }
  if (!record) {
    const config = sourceHandoffConfig(current.snapshot);
    const items = handoffItems(current.snapshot, config, rebindItems, [...(current.heldItems ?? []), ...(box.heldItems ?? [])]);
    if (!items.length || items.length > 100) throw new Error("請確認交接裝備清單介於 1 到 100 件。");
    if (box.items.length + items.length > box.capacity) throw new Error("倉庫空間不足。");
    const ammo = Object.fromEntries(current.snapshot.inventory.map(({uid, itemId}) => [uid, itemId]));
    record = {account, source: current.characterId, config, items, ammo};
  }
  if (!window.confirm(`卸下並存入以下裝備？倉庫費 ${fee} Zeny。\n${record.items.map(equipmentName).join("\n")}`)) return;
  const inventory = current.snapshot.inventory;
  if (record.items.some(item => !inventory.some(candidate => candidate.uid === item.uid &&
      itemFingerprint(candidate) === itemFingerprint(item)))) throw new Error("原角色背包的交接裝備已變更。");
  if (box.items.length + record.items.length > box.capacity) throw new Error("倉庫空間不足。");
  saveHandoff(record, "preparing");
  const uids = new Set(record.items.map(item => item.uid));
  for (const [slot, uid] of Object.entries(current.snapshot.equipment)) {
    if (!uids.has(uid)) continue;
    const reply = await handoffCommand(current, {type:"unequip", slot});
    current = reply.view;
    if (current.snapshot.equipment[slot] != null) throw new Error("伺服器未確認裝備已卸下。");
  }
  const before = await getStorage();
  saveHandoff(record, "depositPending");
  let reply;
  try {
    reply = await handoffCommand(current, {type:"storageDeposit", items:record.items.map(({uid}) => ({uid,qty:1}))});
  } catch (error) {
    if (error.status >= 400 && error.status < 500) saveHandoff(record, "preparing");
    throw error;
  }
  const deposited = matchMoved(before.items, (reply.storage ?? await getStorage()).items, record.items, "sid");
  record.sids = deposited.map(item => item.sid);
  saveHandoff(record, "stored");
}

async function saveAndApplyHandoff(current, config) {
  const saved = await handoffCommand(current, {type:"profileSave", name:profileName, config});
  const profile = saved.view.snapshot.profiles?.find(entry => entry.name === profileName);
  if (!profile || !sameBindings(profile.config?.equipRules, config.equipRules)) {
    throw new Error("未確認換裝規則已寫入同名配置。");
  }
  const applied = await handoffCommand(saved.view, {type:"profileApply", name:profileName});
  if (applied.view.snapshot.activeProfile !== profileName ||
      !sameBindings(applied.view.snapshot.config?.equipRules, config.equipRules)) {
    throw new Error("未確認換裝規則已套用至目前角色。");
  }
}

function currentHandoffOptions() {
  return sanitizeHandoffOptions({
    clearNew: handoffClearNew.checked,
    autoArrows: handoffAutoArrows.checked,
    arrowQty: Number(handoffArrowQty.value),
    autoZeny: handoffAutoZeny.checked,
    targetZeny: Number(handoffZenyTarget.value),
  });
}

function saveHandoffOptions() {
  try {
    localStorage.setItem(storageKeys.handoffOptions, JSON.stringify(currentHandoffOptions()));
  } catch {}
}

function loadHandoffOptions() {
  try {
    const opts = sanitizeHandoffOptions(JSON.parse(localStorage.getItem(storageKeys.handoffOptions)));
    handoffClearNew.checked = opts.clearNew;
    handoffAutoArrows.checked = opts.autoArrows;
    handoffArrowQty.value = String(opts.arrowQty);
    handoffAutoZeny.checked = opts.autoZeny;
    handoffZenyTarget.value = String(opts.targetZeny);
  } catch {
    handoffClearNew.checked = true;
    handoffAutoArrows.checked = true;
    handoffArrowQty.value = "100";
    handoffAutoZeny.checked = true;
    handoffZenyTarget.value = "15000000";
  }
}

loadHandoffOptions();
for (const el of [handoffClearNew, handoffAutoArrows, handoffArrowQty, handoffAutoZeny, handoffZenyTarget]) {
  el.onchange = el.oninput = saveHandoffOptions;
}

async function receiveHandoff(current, account, record) {
  if (!record || record.account !== account || record.source === current.characterId ||
      !(record.stage === "stored" || (record.stage === "received" && record.target === current.characterId))) {
    throw new Error("找不到這個角色可領取的交接裝備。");
  }
  if (!record.config.equipRules?.length) {
    throw new Error("這筆舊交接缺少原角色的換裝規則，請用「跨角色換裝重綁」補套用。");
  }
  const options = currentHandoffOptions();
  const needsStorage = record.stage === "stored" || (options.autoZeny && options.targetZeny > 0);
  let box = needsStorage ? await getStorage() : null;
  const gearBox = record.stage === "stored" ? box : null;
  const withdrawFee = gearBox ? box.fees?.[current.snapshot.mapId] : 0;
  if (gearBox && !Number.isFinite(withdrawFee)) throw new Error("請到有卡普拉服務的城鎮。");

  const clearPlan = record.stage === "stored" && options.clearNew
    ? planClearNewCharacter(current.snapshot, catalog, marketWeights, [...(current.heldItems ?? []), ...(box?.heldItems ?? [])])
    : {unequipSlots: [], clearItems: [], sellUids: [], discardItems: [], freedWeight10: 0, freedSlots: 0};
  const arrowPlan = planHandoffArrows(record, current.snapshot, {
    autoArrows: options.autoArrows,
    arrowQty: options.arrowQty,
    clearedInventory: clearPlan.clearItems.length > 0,
  }, catalog, marketWeights);
  const zenyPlan = planHandoffZeny(current.snapshot, box, options);
  const projectedZeny = current.snapshot.character.zeny + zenyPlan.netGain;
  const requiredZeny = withdrawFee + arrowPlan.totalCost;

  const {sameName, skippedWeaponRule} = validateReceiveHandoff(current.snapshot, gearBox, record, marketWeights, {
    freedSlots: clearPlan.freedSlots,
    freedWeight10: clearPlan.freedWeight10,
    extraArrowSlots: arrowPlan.extraSlots,
    extraArrowWeight10: arrowPlan.extraWeight10,
    projectedZeny,
    requiredZeny,
  });

  const summaryLines = [];
  if (clearPlan.clearItems.length) {
    const preview = clearPlan.clearItems.slice(0, 8).map(item => `${equipmentName(item)} ×${item.qty}`).join("、");
    const more = clearPlan.clearItems.length > 8 ? `…等共 ${clearPlan.clearItems.length} 項` : "";
    summaryLines.push(`• 清空新角色原有 ${clearPlan.clearItems.length} 項物品（略過已上鎖）：${preview}${more}`);
  }
  if (zenyPlan.amount > 0) {
    summaryLines.push(`• 從倉庫提領 ${zenyPlan.amount.toLocaleString()} Zeny（含倉庫費 ${zenyPlan.fee}，補足至 ${(current.snapshot.character.zeny + zenyPlan.netGain).toLocaleString()} Zeny）`);
  }
  if (gearBox) {
    summaryLines.push(`• 領取 ${record.items.length} 件交接裝備（倉庫費 ${withdrawFee} Zeny）`);
  }
  if (arrowPlan.buy.length) {
    const arrowsText = arrowPlan.buy.map(a => `${a.name} ×${a.qty}`).join("、");
    summaryLines.push(`• 自動向商店購買 ${arrowsText}（共 ${arrowPlan.totalCost.toLocaleString()} Zeny）`);
  }
  summaryLines.push(`• 重綁並套用「${profileName}」`);
  if (sameName) summaryLines.push("※ 會覆蓋目前角色的同名配置。");
  if (skippedWeaponRule) summaryLines.push("※ 未轉生角色將略過「Base Lv 至少 64」主手規則（轉生後須重新補上）。");

  if (!window.confirm(`確定執行以下交接步驟？\n${summaryLines.join("\n")}`)) return;

  if (clearPlan.clearItems.length) {
    handoffStatus("正在清空新角色原有穿戴與背包…");
    for (const {slot} of clearPlan.unequipSlots) {
      const reply = await handoffCommand(current, {type: "unequip", slot});
      current = reply.view;
      if (current.snapshot.equipment[slot] != null) throw new Error("伺服器未確認新角色原裝備已卸下。");
    }
    if (clearPlan.sellUids.length) {
      const reply = await handoffCommand(current, {type: "sellBatch", uids: clearPlan.sellUids});
      current = reply.view;
    }
    for (const {uid, qty} of clearPlan.discardItems) {
      const reply = await handoffCommand(current, {type: "discard", uid, qty});
      current = reply.view;
    }
  }

  if (zenyPlan.amount > 0) {
    handoffStatus(`正在從倉庫提領 ${zenyPlan.amount.toLocaleString()} Zeny…`);
    const reply = await handoffCommand(current, {type: "storageZeny", action: "withdraw", amount: zenyPlan.amount});
    current = reply.view;
    box = Array.isArray(reply.storage?.items) ? reply.storage : await getStorage();
  }

  if (gearBox) {
    handoffStatus(`正在領取 ${record.items.length} 件交接裝備…`);
    const items = record.sids.map((sid, index) => {
      const stored = box.items.find(item => item.sid === sid);
      if (!stored || stored.qty !== 1 || itemFingerprint(stored) !== itemFingerprint(record.items[index])) {
        throw new Error("倉庫中的交接裝備已變更。");
      }
      return {sid, qty:1};
    });
    record.target = current.characterId;
    saveHandoff(record, "withdrawPending");
    const before = current.snapshot.inventory;
    let reply;
    try {
      reply = await handoffCommand(current, {type:"storageWithdraw", items});
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        delete record.target;
        saveHandoff(record, "stored");
      }
      throw error;
    }
    current = reply.view;
    record.newUids = matchMoved(before, current.snapshot.inventory, record.items, "uid").map(item => item.uid);
    saveHandoff(record, "received");
  }

  if (arrowPlan.buy.length) {
    for (const arrow of arrowPlan.buy) {
      handoffStatus(`正在向商店購買 ${arrow.name} ×${arrow.qty}…`);
      const reply = await handoffCommand(current, {
        type: "buy",
        itemId: arrow.itemId,
        qty: arrow.qty,
        ...(arrow.shop ? {shop: arrow.shop} : {}),
      });
      current = reply.view;
    }
  }

  if (record.items.some((item, index) => !current.snapshot.inventory.some(candidate =>
      candidate.uid === record.newUids[index] && itemFingerprint(candidate) === itemFingerprint(item)))) {
    throw new Error("領出的裝備已變更，請檢查背包。");
  }
  const config = destinationConfig(record, current.snapshot);
  await saveAndApplyHandoff(current, config);
  localStorage.removeItem(handoffKey);
  const doneParts = [
    clearPlan.clearItems.length ? `清空 ${clearPlan.clearItems.length} 項` : "",
    zenyPlan.amount > 0 ? `提領 ${zenyPlan.amount.toLocaleString()} Zeny` : "",
    arrowPlan.buy.length ? `買 ${arrowPlan.buy.map(a => `${a.name}×${a.qty}`).join("、")}` : "",
  ].filter(Boolean);
  handoffStatus(`已領裝、重綁並套用「${profileName}」${doneParts.length ? `（${doneParts.join("、")}）` : ""}。`);
}

async function runHandoff(direction) {
  if (busy || !activeRole) return;
  busy = true;
  $("handoff-send").disabled = $("handoff-receive").disabled = true;
  let problem;
  try {
    await navigator.locks.request(handoffKey, {ifAvailable: true}, async lock => {
      if (!lock) throw new Error("另一個視窗正在處理交接。");
      const [current, account] = await Promise.all([rebindView(), handoffAccount()]);
      if (current.running !== false) throw new Error("請先停止角色掛機。");
      const record = readHandoff();
      await (direction === "send" ? sendHandoff(current, account, record) : receiveHandoff(current, account, record));
    });
  } catch (error) {
    problem = error.message;
  } finally {
    busy = false;
    await loadGear(true);
    if (problem) handoffStatus(`交接暫停。${problem}`);
  }
}

$("handoff-clear").onclick = async () => {
  if (busy || !window.confirm("已檢查背包與倉庫？清除只會刪除本機交接紀錄，已移動的裝備會留在原處。")) return;
  await navigator.locks.request(handoffKey, {ifAvailable: true}, lock => {
    if (!lock) { handoffStatus("另一個視窗正在處理交接。"); return; }
    localStorage.removeItem(handoffKey);
    updateHandoff();
    handoffStatus("已清除本機交接紀錄。");
  });
};
$("handoff-send").onclick = () => runHandoff("send");
$("handoff-receive").onclick = () => runHandoff("receive");

async function archerMonitor(action) {
  if (!tabId) return;
  try {
    if (action === "start") {
      if (!activeRole || !window.confirm(`啟用 ${activeRole.name} 的弓箭手流程？流程會自動加點、轉職並付費轉生，共計最多 10 次。遊戲會在轉生時停用掛機技能規則和自動配點。`)) return;
      await chrome.scripting.executeScript({
        target: {tabId}, files: ["archer-tree.js", "archer-plan.js", "archer-timing.js", "archer-monitor.js"],
      });
    }
    const state = await chrome.tabs.sendMessage(tabId, {feature: "archer-growth", action, role: activeRole});
    $("archer-status").textContent = state.message;
    $("archer-start").disabled = state.running || !activeRole;
    $("archer-stop").disabled = !state.running;
  } catch (error) {
    if (action !== "status") $("archer-status").textContent = error.message;
    $("archer-start").disabled = !activeRole;
    $("archer-stop").disabled = true;
  }
}

$("archer-start").onclick = () => archerMonitor("start");
$("archer-stop").onclick = () => archerMonitor("stop");

setInterval(() => {
  if (!$("panel-growth").hidden) {
    void archerMonitor("status");
    updateLiveTimingClock();
  }
}, 1500);

const timingDate = new Intl.DateTimeFormat("zh-TW", {month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
const archerTimingClear = $("archer-timing-clear");
const archerJobNames = {
  novice: "初學者", novice_high: "進階初學者", archer: "弓箭手",
  archer_high: "進階弓箭手", hunter: "獵人", sniper: "神射手",
};
let timingRenderKey = "";
let activeRoundTiming = null;

function timingDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours} 小時 ${minutes} 分 ${seconds % 60} 秒`;
}

function timingDurationShort(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function inferEventKind(event) {
  if (event.kind) return event.kind;
  const key = event.key ?? "";
  if (key === "start") return "start";
  if (key.startsWith("job:")) return "job";
  if (key.startsWith("skill:") || key === "windwalkBase" || key === "base75" || key === "windwalk") return "skill";
  if (key === "jobCap" || key === "baseCap" || key === "max") return "cap";
  if (key === "rebirth" || event.label?.includes("轉生")) return "rebirth";
  return "level";
}

function buildTimingStepper(round, liveChar) {
  const keys = new Set((round.events ?? []).map(event => event.key).filter(Boolean));
  const isSniperCycle = round.cycle > 0;
  const liveJob = liveChar?.job ?? "";
  const liveBase = liveChar?.baseLv ?? 0;
  const liveJobLv = liveChar?.jobLv ?? 0;
  const jobRank = {novice: 1, novice_high: 1, archer: 2, archer_high: 2, hunter: 3, sniper: 3}[liveJob] ?? 0;
  const hasSecond = keys.has("job:hunter") || keys.has("job:sniper") || jobRank >= 3;
  const hasFirst = hasSecond || keys.has("job:archer") || keys.has("job:archer_high") || jobRank >= 2;
  const hasNovice = hasFirst || keys.has("job:novice") || keys.has("job:novice_high") || jobRank >= 1;
  const hasMid = isSniperCycle
    ? (keys.has("windwalk") || (liveJob === "sniper" && (liveChar?.skills?.SN_WINDWALK ?? 0) >= 10))
    : (keys.has("base:70") || (hasSecond && liveBase >= 70));
  const targetJobCap = isSniperCycle ? 70 : 50;
  const hasJobCap = keys.has("jobCap") || keys.has("max") || (hasSecond && liveJobLv >= targetJobCap);
  const hasBaseCap = keys.has("baseCap") || keys.has("max") || liveBase >= 99;
  const stages = [
    {label: "初學", done: hasFirst},
    {label: "一轉", done: hasSecond},
    {label: "二轉", done: hasSecond},
    {label: isSniperCycle ? "風步10" : "Lv70", done: hasMid},
    {label: `Job${targetJobCap}`, done: hasJobCap},
    {label: "Lv99", done: hasBaseCap},
  ];
  let currentIdx = stages.findIndex(stage => !stage.done);
  if (currentIdx === -1 && round.end) currentIdx = stages.length;
  else if (currentIdx === 0 && !hasNovice) currentIdx = 0;

  const stepper = document.createElement("div");
  stepper.className = "timing-stepper";
  stages.forEach((stage, index) => {
    const item = document.createElement("div");
    item.className = "timing-step";
    if (stage.done) item.classList.add("is-done");
    else if (index === currentIdx && !round.end) item.classList.add("is-current");
    const bar = document.createElement("span");
    bar.className = "timing-step-bar";
    const text = document.createElement("span");
    text.textContent = stage.label;
    item.append(bar, text);
    stepper.append(item);
  });
  return stepper;
}

function buildKpiCard(label, value, sub = "") {
  const card = document.createElement("div");
  card.className = "timing-kpi";
  const l = document.createElement("span");
  l.className = "timing-kpi-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "timing-kpi-value";
  v.textContent = value;
  card.append(l, v);
  if (sub) {
    const s = document.createElement("span");
    s.className = "timing-kpi-sub";
    s.textContent = sub;
    s.title = sub;
    card.append(s);
  }
  return card;
}

function updateLiveTimingClock() {
  if (!activeRoundTiming) return;
  const now = Date.now();
  const {start, lastAt, durationEl, liveMetaEl} = activeRoundTiming;
  if (durationEl) durationEl.textContent = `已耗 ${timingDurationShort(now - start)}`;
  if (liveMetaEl) {
    liveMetaEl.textContent = `距上一里程碑 ${timingDurationShort(now - lastAt)} · 累計 ${timingDuration(now - start)}`;
  }
}

async function renderArcherTiming() {
  const id = activeRole?.id;
  const target = $("archer-timing");
  if (!id) {
    timingRenderKey = "";
    activeRoundTiming = null;
    archerTimingClear.hidden = true;
    target.textContent = "請先進入遊戲角色。";
    return;
  }
  const key = `archer-timing-v1:${id}`;
  try {
    const data = await chrome.storage.local.get(key);
    if (activeRole?.id !== id) return;
    const rounds = data[key] ?? [];
    archerTimingClear.hidden = !rounds.length;
    const liveChar = view?.characterId === id ? view.snapshot?.character : null;
    const liveKey = liveChar ? [liveChar.job, liveChar.baseLv, liveChar.jobLv, liveChar.rebirth?.count ?? -1] : null;
    const signature = JSON.stringify([id, rounds, liveKey]);
    if (signature === timingRenderKey) {
      updateLiveTimingClock();
      return;
    }
    timingRenderKey = signature;
    activeRoundTiming = null;
    if (!rounds.length) {
      target.textContent = "尚無紀錄。啟用自動加點後開始計時，會記錄轉職、核心技能與等級里程碑。";
      return;
    }

    const latest = rounds.at(-1);
    const fullDone = rounds.filter(r => r.end && !r.partial);
    const anyDone = fullDone.length ? fullDone : rounds.filter(r => r.end);
    const avgMs = anyDone.length ? anyDone.reduce((sum, r) => sum + (r.end - r.start), 0) / anyDone.length : null;
    const fastest = anyDone.length
      ? anyDone.reduce((best, r) => (r.end - r.start) < (best.end - best.start) ? r : best)
      : null;

    const kpiGrid = document.createElement("div");
    kpiGrid.className = "timing-kpi-grid";
    const cycleLabel = latest.cycle ? `第 ${latest.cycle}／10 轉` : "轉生前";
    const liveSub = liveChar && Object.hasOwn(archerJobNames, liveChar.job)
      ? `${archerJobNames[liveChar.job]} ${liveChar.baseLv}/${liveChar.jobLv}`
      : `已記 ${latest.events?.length ?? 0} 里程碑`;
    kpiGrid.append(
      buildKpiCard("目前進度", cycleLabel, liveSub),
      buildKpiCard(
        "平均單轉",
        avgMs !== null ? timingDurationShort(avgMs) : "—",
        anyDone.length ? `${fullDone.length ? "完整" : "含部分"} ${anyDone.length} 輪` : "尚未完成單輪",
      ),
      buildKpiCard(
        "最快紀錄",
        fastest ? timingDurationShort(fastest.end - fastest.start) : "—",
        fastest ? (fastest.cycle ? `第 ${fastest.cycle} 轉` : "轉生前") : `累計觀測 ${rounds.length} 輪`,
      ),
    );

    const nodes = [kpiGrid, buildTimingStepper(latest, liveChar)];
    const now = Date.now();
    for (const [index, round] of [...rounds].reverse().entries()) {
      const block = document.createElement("details");
      block.className = "timing-round";
      block.open = index === 0;

      const summary = document.createElement("summary");
      const left = document.createElement("div");
      left.className = "timing-round-left";
      const title = document.createElement("span");
      title.className = "timing-round-title";
      title.textContent = round.cycle ? `第 ${round.cycle} 轉` : "轉生前";
      const tag = document.createElement("span");
      tag.className = "timing-tag";
      if (round.end) {
        tag.classList.add(round.partial ? "timing-tag-partial" : "timing-tag-done");
        tag.textContent = round.partial ? "部分完成" : "已完成";
      } else if (index === 0) {
        tag.classList.add("timing-tag-live");
        tag.textContent = round.partial ? "進行中·續記" : "進行中";
      } else {
        tag.classList.add("timing-tag-partial");
        tag.textContent = "未結算";
      }
      left.append(title, tag);

      const dur = document.createElement("span");
      dur.className = "timing-round-duration";
      if (round.end) {
        dur.textContent = timingDurationShort(round.end - round.start);
        dur.title = timingDuration(round.end - round.start);
      } else if (index === 0) {
        dur.textContent = `已耗 ${timingDurationShort(now - round.start)}`;
      } else {
        dur.textContent = "—";
      }
      summary.append(left, dur);

      const timeline = document.createElement("ol");
      timeline.className = "timing-timeline";
      const events = round.events ?? [];
      events.forEach((event, eventIdx) => {
        const li = document.createElement("li");
        li.className = `timing-node kind-${inferEventKind(event)}`;
        const head = document.createElement("div");
        head.className = "timing-node-head";
        const label = document.createElement("span");
        label.className = "timing-node-label";
        label.textContent = event.label;
        const delta = document.createElement("span");
        delta.className = "timing-node-delta";
        if (eventIdx === 0) {
          delta.textContent = "起點";
        } else {
          const stepMs = Math.max(0, event.at - events[eventIdx - 1].at);
          delta.textContent = `+${timingDurationShort(stepMs)}`;
          delta.title = `本段耗時 ${timingDuration(stepMs)}`;
        }
        head.append(label, delta);

        const meta = document.createElement("div");
        meta.className = "timing-node-meta";
        const timeSpan = document.createElement("span");
        timeSpan.textContent = timingDate.format(event.at);
        const totalSpan = document.createElement("span");
        totalSpan.textContent = `累計 ${timingDurationShort(event.at - round.start)}`;
        totalSpan.title = timingDuration(event.at - round.start);
        meta.append(timeSpan, totalSpan);
        if (Number.isInteger(event.baseLv) && Number.isInteger(event.jobLv) && !event.label.includes("Base")) {
          const lv = document.createElement("span");
          lv.className = "timing-node-lv";
          lv.textContent = `B${event.baseLv}/J${event.jobLv}`;
          meta.append(lv);
        }
        li.append(head, meta);
        timeline.append(li);
      });

      if (!round.end && index === 0 && events.length) {
        const lastAt = events.at(-1).at;
        const liveNode = document.createElement("li");
        liveNode.className = "timing-node kind-live";
        const head = document.createElement("div");
        head.className = "timing-node-head";
        const label = document.createElement("span");
        label.className = "timing-node-label";
        label.textContent = "持續練級中…";
        head.append(label);
        const meta = document.createElement("div");
        meta.className = "timing-node-meta";
        meta.textContent = `距上一里程碑 ${timingDurationShort(now - lastAt)} · 累計 ${timingDuration(now - round.start)}`;
        liveNode.append(head, meta);
        timeline.append(liveNode);
        activeRoundTiming = {start: round.start, lastAt, durationEl: dur, liveMetaEl: meta};
      }

      block.append(summary, timeline);
      nodes.push(block);
    }
    target.replaceChildren(...nodes);
  } catch {
    timingRenderKey = "";
    archerTimingClear.hidden = true;
    target.textContent = "無法讀取本機計時紀錄。";
  }
}

archerTimingClear.onclick = async () => {
  const id = activeRole?.id;
  if (!id || !window.confirm(`確定清除 ${activeRole.name} 的全部轉生計時與里程碑紀錄？`)) return;
  try {
    await chrome.storage.local.remove(`archer-timing-v1:${id}`);
    timingRenderKey = "";
    await renderArcherTiming();
  } catch {}
};

globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes[`archer-timing-v1:${activeRole?.id}`]) void renderArcherTiming();
});

const tabs = [...$("tool-tabs").querySelectorAll('[role="tab"]')];

function activateToolTab(active, focus = false) {
  for (const tab of tabs) {
    const selected = tab === active;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !selected;
  }
  try { localStorage.setItem(storageKeys.activeTab, active.id); } catch {}
  if (focus) active.focus();
  if (active.id === "tab-growth") {
    void archerMonitor("status");
    void renderArcherTiming();
  }
}

try {
  const savedTabId = localStorage.getItem(storageKeys.activeTab);
  const savedTab = tabs.find(tab => tab.id === savedTabId);
  if (savedTab) activateToolTab(savedTab);
} catch {}

for (const tab of tabs) {
  tab.onclick = () => activateToolTab(tab);
  tab.onkeydown = event => {
    const index = tabs.indexOf(tab);
    const next = {
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    activateToolTab(tabs[next], true);
  };
}

all.onchange = () => {
  for (const row of selection.children) {
    if (!row.hidden) row.firstElementChild.checked = all.checked;
  }
  updatePlan();
};
selection.onchange = updatePlan;
query.oninput = applyEquipmentFilters;
locationFilter.onchange = () => { saveRefineUiPrefs(); applyEquipmentFilters(); };
refineOptions.ontoggle = saveRefineUiPrefs;
mode.onchange = () => updateMode(false);
refresh.onclick = () => catalog ? loadGear(true) : initialize();
storageMaterials.onchange = storageWeapons.onchange = () => {
  saveRefineUiPrefs();
  updateRefineOptionsSummary();
  loadGear(true);
};
refineShopMetals.onchange = () => { saveRefineSupplyOptions(); updateRefineOptionsSummary(); updatePlan(); };
refineBuyMaterials.onchange = () => { saveRefineSupplyOptions(); updateRefineSupplyVisibility(); updatePlan(); };
for (const [, input] of refineMaxInputs) {
  input.oninput = () => { saveRefineSupplyOptions(); updateRefineOptionsSummary(); updatePlan(); };
}
loadRefineUiPrefs();
loadRefineSupplyOptions();
updateRefineSupplyVisibility();
target.onchange = () => renderEquipment(true);
autoEquip.onchange = () => { saveRefineUiPrefs(); updateRefineOptionsSummary(); renderEquipment(true); };
start.onclick = runBatch;
stop.onclick = () => { cancelled = true; stop.disabled = true; };

$("settings-export").onclick = async () => {
  const text = JSON.stringify(exportAllSettings(localStorage), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $("settings-status").textContent = "已複製設定 JSON 到剪貼簿，可貼到其他電腦匯入。";
  } catch {
    window.prompt("請複製以下設定 JSON：", text);
    $("settings-status").textContent = "已顯示設定 JSON 供複製。";
  }
};

$("settings-import").onclick = async () => {
  if (busy) return;
  const text = window.prompt("貼上從其他電腦複製的設定 JSON：");
  if (!text) return;
  try {
    const imported = importAllSettings(text, localStorage);
    loadTheme();
    loadKeepAwake();
    loadRefineUiPrefs();
    loadRefineSupplyOptions();
    updateRefineSupplyVisibility();
    loadMarketPrefs();
    loadHandoffOptions();
    const savedTab = tabs.find(tab => tab.id === imported.activeTab);
    if (savedTab) activateToolTab(savedTab);
    $("settings-status").textContent = "已匯入並套用所有設定。";
    if (catalog) await loadGear(true);
  } catch (error) {
    $("settings-status").textContent = error.message;
  }
};

window.addEventListener("focus", async () => {
  if (busy || !tabId || !catalog || focusCheckInFlight) return;
  focusCheckInFlight = true;
  try {
    const {activeName} = await gameRequest("/api/characters");
    if (activeName && activeName !== activeRole?.name) await loadGear();
  } catch {} finally {
    focusCheckInFlight = false;
  }
});

async function initialize() {
  refresh.disabled = true;
  document.body.classList.toggle("floating", floating);
  $("open-floating").hidden = floating;
  character.textContent = "讀取目前角色中…";
  try {
    if (!chrome.tabs?.query || !chrome.scripting?.executeScript) {
      throw new Error("擴充權限尚未載入，請在 chrome://extensions 重新載入。");
    }
    if (floating && !/^\d+$/.test(floatingTab)) throw new Error("浮動視窗找不到原本的遊戲分頁。");
    const tab = floating ? await chrome.tabs.get(Number(floatingTab)) :
      (await chrome.tabs.query({active: true, currentWindow: true}))[0];
    if (!tab?.url || new URL(tab.url).origin !== host || new URL(tab.url).pathname.startsWith("/info")) {
      throw new Error("請先在 ro-idle.app 進入角色，再從 Chrome 工具列開啟擴充。");
    }
    tabId = tab.id;
    renderKeepAwakeButton();
    syncKeepAwakeTimer(true);
    [catalog, marketSlots, marketTowns, marketWeights, rebindItems] = await Promise.all(
      ["catalog.json", "market-slots.json", "market-towns.json", "market-weights.json", "rebind-items.json"].map(async path => {
        const response = await fetch(path, {signal: AbortSignal.timeout(10000)});
        if (!response.ok) throw new Error(`無法載入擴充資料（${path}），請重新載入擴充。`);
        return response.json();
      }),
    );
    setRefineSupplyDisabled(false);
    await loadGear();
  } catch (error) {
    character.textContent = "無法讀取目前角色";
    status(error.message);
  } finally {
    refresh.disabled = false;
  }
}

await initialize();
