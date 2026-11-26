import {destinationConfig, handoffItems, matchMoved, profileName} from "./handoff.mjs";
import {itemFingerprint, remapRules, ruleReferences, suitableItem} from "./rebind.mjs";
import {marketPlan} from "./market.mjs";
import {associateWithdrawnEquipment, batchPlan, equipmentLocation, guardedCommand, matchesEquipment, nextRefineCommand, refineOutcome, restoreEquipment, skillLevel, equipmentPlan} from "./refine.mjs";

const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const character = $("character");
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
const storageMaterials = $("storage-materials");
const storageWeapons = $("storage-weapons");
const results = $("results");
const status = message => { $("status").textContent = message; };
let catalog, marketSlots, marketTowns, rebindItems, tabId, view, storage, activeRole;
let marketPreview;
let rebindPreview;
const rebindKey = "equipment-rebind-reference";
const handoffKey = "archer-equipment-handoff-v1";
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
    `${chosen.length} 件裝備，最多 ${batch.steps} 次精練，${mode.value === "weapon" ? `${batch.steps * 5} SP` : `精練費 ${batch.zeny} Zeny`}`,
    materials.join("、"),
    ...(withdrawals.length ? [`從倉庫取出 ${withdrawals.join("及")}，倉庫費 ${batch.fee} Zeny。`] : []),
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
    if (!preserve) mode.value = canUseSkill ? "weapon" : "weapon-npc";
    if (mode.value === "weapon" && !canUseSkill) mode.value = "weapon-npc";
    mode.disabled = $("market-fields").disabled = false;
    needsRefresh = false;
    updateMode(preserve);
    $("rebind-capture").disabled = $("rebind-preview").disabled = false;
    updateHandoff();
    void archerMonitor("status");
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
  mode.disabled = refresh.disabled = gear.disabled = start.disabled = target.disabled = storageMaterials.disabled = storageWeapons.disabled = autoEquip.disabled = true;
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
    const equipNote = chosen.some(plan => plan.needsEquip) ? "\n將暫時更換防具，請保持擴充視窗開啟，直到原裝備還原。" : "";
    if (!window.confirm(`確定由 ${roleName} 執行批次精練？\n${planSummary(chosen, batch)}${equipNote}\n\n${items.join("\n")}`)) return;
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

    const send = async (current, command) => {
      const reply = await gameRequest(`/api/characters/${id}/commands`, guardedCommand(current, command));
      return checkView(reply.view, id);
    };
    for (const plan of chosen) {
      if (cancelled) break;
      const original = plan.needsEquip ? {...view.snapshot.equipment} : null;
      let equipConfirmed = false;
      try {
        if (original) {
          status(`正在穿戴 ${plan.name}…`);
          view = await send(view, {type: "equip", uid: plan.uid});
          equipConfirmed = Object.values(view.snapshot.equipment).includes(plan.uid);
          if (!equipConfirmed) throw new Error("未確認穿戴成功，請檢查裝備欄。");
        }
        let level = plan.from;
        while (!cancelled && level < plan.target) {
          const nextLevel = plan.method === "safe" ? plan.target : level + 1;
          status(`精練 ${plan.name} +${level} → +${nextLevel}…`);
          const payload = nextRefineCommand(view, catalog, plan, plan.uid, level);
          awaitingRefine = true;
          const reply = await gameRequest(`/api/characters/${id}/commands`, payload);
          const next = checkView(reply.view, id);
          view = next;
          const outcome = refineOutcome(next, plan, level);
          awaitingRefine = false;
          if (outcome === "failure") {
            failure++;
            break;
          }
          if (nextLevel === plan.target) success++;
          level = nextLevel;
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
    }
    status(cancelled ? "批次已停止。" : "批次已結束。");
  } catch (error) {
    if (awaitingRefine) uncertain++;
    needsRefresh = true;
    status(`批次停止。${error.message} 請更新物品並確認裝備欄。`);
  } finally {
    busy = $("market-fields").disabled = false;
    refresh.disabled = storageMaterials.disabled = storageWeapons.disabled = autoEquip.disabled = false;
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
  return marketPlan(response, marketSlots, {id: role.id, mapId, zeny}, criteria);
}

function lockMarket(locked) {
  busy = locked;
  $("market-fields").disabled = locked;
  mode.disabled = target.disabled = gear.disabled = refresh.disabled =
    storageMaterials.disabled = storageWeapons.disabled = autoEquip.disabled = locked;
  if (locked) start.disabled = true;
  else if (view) updateMode(true);
}

function marketRow({seller, item}, holes, qty, town) {
  const row = document.createElement("li");
  const refine = item.refine ? `+${item.refine} ` : "";
  const flags = [item.unidentified && "未鑑定", item.broken && "損壞", item.cards?.some(Boolean) && "已插卡"].filter(Boolean);
  const state = flags.length ? `（${flags.join("、")}）` : "";
  row.textContent = `${refine}${item.name}［${holes} 洞］${state} · ${item.price.toLocaleString()} Zeny ×${qty} · ${seller}` +
    (town ? ` · ${town}` : "");
  return row;
}

async function previewMarket() {
  if (busy || !activeRole) return;
  const criteria = {
    keyword: $("market-name").value.trim(),
    holes: $("market-holes").value === "" ? NaN : Number($("market-holes").value),
    ceiling: Number($("market-price").value),
    quantity: Number($("market-qty").value),
  };
  clearMarketPreview();
  if (!criteria.keyword || !Number.isInteger(criteria.holes) ||
      !Number.isSafeInteger(criteria.ceiling) || criteria.ceiling < 1 ||
      !Number.isInteger(criteria.quantity) || criteria.quantity < 1 || criteria.quantity > 100) {
    $("market-status").textContent = "請填寫裝備名稱、指定洞數、單價上限與購買件數（1～100）。";
    return;
  }
  lockMarket(true);
  try {
    const plan = await searchMarket(activeRole, criteria);
    const localStatus = plan.count
      ? `目前城鎮預計購買 ${plan.count} 件，合計 ${plan.total.toLocaleString()} Zeny。`
      : plan.localMatches ? "目前 Zeny 不足。" : "目前城鎮沒有符合條件的裝備。";
    $("market-status").textContent = localStatus +
      (plan.remote.length ? `其他城鎮有 ${plan.remote.length} 筆符合商品。` : "");
    $("market-remote-list").replaceChildren(...plan.remote.map(line =>
      marketRow(line, criteria.holes, line.item.qty, marketTowns[line.mapId] ?? line.mapId)));
    $("market-other").hidden = !plan.remote.length;
    if (!plan.count) return;
    marketPreview = {criteria, plan};
    $("market-preview").replaceChildren(...plan.orders.map(line =>
      marketRow(line, criteria.holes, line.qty)));
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
  const {criteria, plan} = marketPreview;
  const role = activeRole;
  lockMarket(true);
  let bought = 0;
  let paid = 0;
  let submitted = false;
  try {
    const fresh = await searchMarket(role, criteria);
    if (JSON.stringify(fresh.orders) !== JSON.stringify(plan.orders)) {
      throw new Error("攤位商品、價格或可購買數量已變動，請重新搜尋。");
    }
    for (const {vendorId, item, qty} of fresh.orders) {
      submitted = true;
      const {result} = await gameRequest(`/api/characters/${role.id}/vending/buy`, {
        vendorId, orders: [{cartUid: item.cartUid, qty, price: item.price}],
      });
      if (result?.paid !== item.price * qty) throw new Error("未能確認這筆購買金額。");
      bought += qty;
      paid += result.paid;
    }
    $("market-status").textContent = `已購買 ${bought} 件，共花費 ${paid.toLocaleString()} Zeny。`;
  } catch (error) {
    $("market-status").textContent = `購買停止。已確認 ${bought} 件、${paid.toLocaleString()} Zeny。${error.message}${submitted ? " 請先確認背包再重試。" : ""}`;
  } finally {
    clearMarketPreview();
    lockMarket(false);
    if (submitted) await loadGear(true);
  }
}

$("market-fields").oninput = () => {
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
    const rules = current.snapshot.config.equipRules ?? [];
    const refs = ruleReferences(rules);
    const items = current.snapshot.inventory.filter(item => refs.has(item.uid));
    if (!items.length) throw new Error("原角色背包裡找不到換裝規則綁定的裝備。");
    const previous = savedReference();
    if (previous && !window.confirm(`將原本的 ${previous.name} 裝備對照替換成 ${activeRole.name}？`)) return;
    localStorage.setItem(rebindKey, JSON.stringify({id: activeRole.id, name: activeRole.name, rules, items}));
    clearRebind();
    rebindStatus(`已記錄 ${activeRole.name} 的 ${items.length} 件裝備。`);
  } catch (error) { rebindStatus(error.message); }
}

async function previewRebind() {
  if (!activeRole || busy) return;
  clearRebind();
  try {
    const current = await rebindView();
    const rules = current.snapshot.config.equipRules ?? [];
    const refs = ruleReferences(rules);
    if (!refs.size) throw new Error("目前角色沒有自動換裝規則。請先匯入原配置。");
    const backup = savedReference();
    const useBackup = backup && backup.id !== current.characterId &&
      JSON.stringify(backup.rules) === JSON.stringify(rules);
    const previous = new Map(useBackup ? backup.items.map(item => [item.uid, item]) : []);
    const rows = [];
    for (const [uid, slots] of refs) {
      const original = previous.get(uid);
      const eligible = current.snapshot.inventory.filter(item => suitableItem(item, slots, rebindItems));
      const matches = original ? eligible.filter(item => itemFingerprint(item) === itemFingerprint(original)) : [];
      const field = document.createElement("select");
      field.add(new Option("保留原設定", ""));
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
    rebindPreview = {current, rows};
    $("rebind-apply").disabled = false;
    rebindStatus(useBackup ? `已使用 ${backup.name} 的對照，請核對預選項目。` : "未使用原角色對照，請逐項選擇替換裝備。");
  } catch (error) { rebindStatus(error.message); }
}

async function applyRebind() {
  if (!activeRole || !rebindPreview || busy) return;
  const {current, rows} = rebindPreview;
  const mapping = new Map(rows.filter(({field}) => field.value).map(({uid, field}) => [uid, Number(field.value)]));
  if (!mapping.size) { rebindStatus("請先選擇要重綁的裝備。"); return; }
  const changed = [...mapping].filter(([old, next]) => old !== next).length;
  if (!changed) { rebindStatus("選取的裝備 UID 與原設定相同。"); return; }
  const mappingCount = changed;
  if (!window.confirm(`確定重綁 ${activeRole.name} 的 ${mappingCount} 個裝備 UID？`)) return;
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
    const config = fresh.snapshot.config;
    const equipRules = remapRules(config.equipRules, mapping, fresh.snapshot.inventory);
    const reply = await gameRequest(`/api/characters/${fresh.characterId}/commands`,
      guardedCommand(fresh, {type:"updateConfig", config:{...config, equipRules}}));
    const next = checkView(reply.view, fresh.characterId);
    const bindings = rules => rules?.map(({weapon, shield, ammo, gear}) => [weapon, shield, ammo, gear ?? []]);
    if (JSON.stringify(bindings(next.snapshot.config?.equipRules)) !== JSON.stringify(bindings(equipRules))) {
      throw new Error("伺服器未確認換裝規則，請先檢查遊戲設定。");
    }
    rebindStatus(`已重綁 ${mappingCount} 個裝備 UID。`);
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
  const box = await getStorage();
  const fee = handoffFee(current, box);
  if (record && (record.account !== account || record.source !== current.characterId || record.stage !== "preparing")) {
    throw new Error("目前已有一筆裝備交接。");
  }
  if (!record) {
    const config = current.snapshot.profiles?.find(profile => profile.name === profileName)?.config;
    if (!config) throw new Error(`原角色找不到已儲存的「${profileName}」配置。`);
    const items = handoffItems(current.snapshot, config, rebindItems);
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
  const reply = await handoffCommand(current, {type:"storageDeposit", items:record.items.map(({uid}) => ({uid,qty:1}))});
  const deposited = matchMoved(before.items, (reply.storage ?? await getStorage()).items, record.items, "sid");
  record.sids = deposited.map(item => item.sid);
  saveHandoff(record, "stored");
}

async function receiveHandoff(current, account, record) {
  if (!record || record.account !== account || record.source === current.characterId ||
      !(record.stage === "stored" || (record.stage === "received" && record.target === current.characterId))) {
    throw new Error("找不到這個角色可領取的交接裝備。");
  }
  const sameName = current.snapshot.profiles?.some(profile => profile.name === profileName);
  const box = record.stage === "stored" ? await getStorage() : null;
  const fee = box ? handoffFee(current, box) : 0;
  const note = sameName ? "會覆蓋目前角色的同名配置。" : "";
  if (!window.confirm(`領取交接裝備並套用「${profileName}」？倉庫費 ${fee} Zeny。${note}`)) return;
  if (box) {
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
    const reply = await handoffCommand(current, {type:"storageWithdraw", items});
    current = reply.view;
    record.newUids = matchMoved(before, current.snapshot.inventory, record.items, "uid").map(item => item.uid);
    saveHandoff(record, "received");
  }
  if (record.items.some((item, index) => !current.snapshot.inventory.some(candidate =>
      candidate.uid === record.newUids[index] && itemFingerprint(candidate) === itemFingerprint(item)))) {
    throw new Error("領出的裝備已變更，請檢查背包。");
  }
  const config = destinationConfig(record, current.snapshot);
  const saved = await handoffCommand(current, {type:"profileSave", name:profileName, config});
  if (!saved.view.snapshot.profiles?.some(profile => profile.name === profileName)) throw new Error("未確認配置已儲存。");
  const applied = await handoffCommand(saved.view, {type:"profileApply", name:profileName});
  if (applied.view.snapshot.activeProfile !== profileName) {
    throw new Error("未確認配置已套用，請檢查遊戲目前配置。");
  }
  localStorage.removeItem(handoffKey);
  handoffStatus(`已領裝、重綁並套用「${profileName}」。`);
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
        target: {tabId}, files: ["archer-tree.js", "archer-plan.js", "archer-monitor.js"],
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
  if (!$("panel-growth").hidden) void archerMonitor("status");
}, 1500);

const tabs = [...$("tool-tabs").querySelectorAll('[role="tab"]')];

function activateToolTab(active, focus = false) {
  for (const tab of tabs) {
    const selected = tab === active;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !selected;
  }
  if (focus) active.focus();
  if (active.id === "tab-growth") void archerMonitor("status");
}

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
query.oninput = locationFilter.onchange = applyEquipmentFilters;
mode.onchange = () => updateMode(false);
refresh.onclick = storageMaterials.onchange = storageWeapons.onchange = () => loadGear(true);
target.onchange = autoEquip.onchange = () => renderEquipment(true);
start.onclick = runBatch;
stop.onclick = () => { cancelled = true; stop.disabled = true; };

try {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.url || new URL(tab.url).origin !== host || new URL(tab.url).pathname.startsWith("/info")) {
    throw new Error("請先開啟並登入 ro-idle.app 遊戲，再點這個擴充功能。");
  }
  tabId = tab.id;
  [catalog, marketSlots, marketTowns, rebindItems] = await Promise.all(["catalog.json", "market-slots.json", "market-towns.json", "rebind-items.json"]
    .map(path => fetch(path).then(response => response.json())));
  refresh.disabled = storageMaterials.disabled = storageWeapons.disabled = false;
  await loadGear();
} catch (error) {
  status(error.message);
}
