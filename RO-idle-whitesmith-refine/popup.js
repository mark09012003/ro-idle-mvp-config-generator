import {destinationConfig, handoffItems, matchMoved, profileName, rebindPlan, sameBindings, sourceHandoffConfig} from "./handoff.mjs";
import {itemFingerprint, remapRules, ruleReferences, suitableItem} from "./rebind.mjs";
import {diffPurchasedItems, isOverHalfWeight, marketPlan, planAutoDeposit, verifyDeposited, wouldExceedMaxWeight} from "./market.mjs";
import {associateWithdrawnEquipment, batchPlan, equipmentLocation, guardedCommand, matchesEquipment, nextRefineCommand, planNextRefineWave, refineOutcome, restoreEquipment, skillLevel, equipmentPlan} from "./refine.mjs";

const $ = id => document.getElementById(id);
const host = "https://ro-idle.app";
const floatingTab = new URL(location.href).searchParams.get("gameTab");
const floating = floatingTab !== null;
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
const marketAutoStore = $("market-auto-store");
const results = $("results");
const status = message => { $("status").textContent = message; };
let catalog, marketSlots, marketTowns, rebindItems, tabId, view, storage, activeRole;
let marketPreview;
let rebindPreview;
const marketAutoStoreKey = "market-auto-store-v1";
const rebindKey = "equipment-rebind-reference";
const handoffKey = "archer-equipment-handoff-v1";
let loadVersion = 0;
let plans = [];
let busy = false;
let cancelled = false;
let needsRefresh = false;

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
      await chrome.windows.create({url: url.href, type: "popup", width: 410, height: 690, focused: true});
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
    const [reply] = await Promise.race([request, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("讀取遊戲逾時，請確認網路後重試。")), 20000);
    })]);
    if (!reply?.result?.data) throw new Error(reply?.result?.error ?? "遊戲未傳回完整結果。");
    if (path === "/api/characters") return {...reply.result.data, activeName: reply.result.name};
    return reply.result.data;
  } finally {
    clearTimeout(timeout);
  }
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
  const storageNote = !withdrawals.length ? []
    : batch.waves > 1
      ? [`依目前負重與背包格數自動分批從倉庫領取 ${withdrawals.join("及")}（預計至少 ${batch.waves} 批，單次倉庫費 ${batch.fee} Zeny${stored ? "；完成的倉庫裝備在負重超過 50% 或空間不足時自動存回倉庫" : ""}）。`]
      : [`從倉庫取出 ${withdrawals.join("及")}，倉庫費 ${batch.fee} Zeny。`];
  return [
    `${chosen.length} 件裝備，最多 ${batch.steps} 次精練，${mode.value === "weapon" ? `${batch.steps * 5} SP` : `精練費 ${batch.zeny} Zeny`}`,
    materials.join("、"),
    ...storageNote,
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
    summary.textContent = planSummary(chosen, batchPlan(view, storage, chosen, storageMaterials.checked, catalog));
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
  let returnedToStorage = 0;
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
    const batch = batchPlan(view, storage, chosen, storageMaterials.checked, catalog);
    const items = chosen.map(plan =>
      `${plan.source === "storage" ? "倉庫" : "背包"} · ${plan.name} +${plan.from} → +${plan.target}`);
    const equipNote = chosen.some(plan => plan.needsEquip) ? "\n將暫時更換防具，請保持擴充視窗開啟，直到原裝備還原。" : "";
    if (!window.confirm(`確定由 ${roleName} 執行批次精練？\n${planSummary(chosen, batch)}${equipNote}\n\n${items.join("\n")}`)) return;
    started = true;
    results.hidden = true;
    stop.disabled = false;

    const send = async (current, command) => {
      const reply = await gameRequest(`/api/characters/${id}/commands`, guardedCommand(current, command));
      return checkView(reply.view, id);
    };

    const finishedStorageUids = new Set();
    const depositFinishedStorage = async reason => {
      while (finishedStorageUids.size) {
        const entries = [...finishedStorageUids].map(uid => [uid, 1]);
        const deposit = planAutoDeposit(view.snapshot, storage, entries);
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
        storage = Array.isArray(reply.storage?.items) ? reply.storage : await getStorage();
        for (const {uid} of deposit.items) finishedStorageUids.delete(uid);
        returnedToStorage += deposit.totalQty;
      }
    };

    let remaining = chosen.map(plan => ({...plan, originSource: plan.source}));
    let waveIndex = 0;

    while (!cancelled && remaining.length) {
      const needsStorageNow = remaining.some(plan => plan.source === "storage") || storageMaterials.checked;
      if (needsStorageNow && finishedStorageUids.size && isOverHalfWeight(view.snapshot)) {
        await depositFinishedStorage("負重超過 50%");
      }

      let wave = planNextRefineWave(view, storage, remaining, storageMaterials.checked, catalog);
      if (!wave.wavePlans.length && finishedStorageUids.size) {
        await depositFinishedStorage("騰出負重與背包空間");
        wave = planNextRefineWave(view, storage, remaining, storageMaterials.checked, catalog);
      }
      if (!wave.wavePlans.length) {
        throw new Error(wave.blockedReason ?? "目前負重或背包空間不足以領取下一批倉庫物品。");
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
        storage = Array.isArray(reply.storage?.items) ? reply.storage : await getStorage();
      } else {
        wavePlans = wavePlans.map(plan => ({...plan, uid: plan.uid ?? plan.item.uid}));
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
              broken = true;
              break;
            }
            stepsThisWave += plan.method === "safe" ? plan.target - level : 1;
            if (nextLevel === plan.target) {
              success++;
              if (plan.originSource === "storage") finishedStorageUids.add(plan.uid);
            }
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
    refresh.disabled = storageMaterials.disabled = storageWeapons.disabled = autoEquip.disabled = false;
    stop.disabled = true;
    mode.disabled = needsRefresh;
    target.disabled = needsRefresh;
    if (started) {
      results.hidden = false;
      results.textContent = `成功 ${success} 件 · 失敗 ${failure} 件 · 未完成 ${chosen.length - success - failure - uncertain} 件${uncertain ? ` · 結果待確認 ${uncertain} 件` : ""}${returnedToStorage ? ` · 已自動存回倉庫 ${returnedToStorage} 件` : ""}`;
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
  return {...marketPlan(response, marketSlots, {id: role.id, mapId, zeny}, criteria), current};
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
  const autoStore = marketAutoStore.checked;
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
      storeNote = ` 負重超過 50% 自動存倉（每次倉庫費 ${fee} Zeny${alreadyHeavy ? "；目前負重已超過 50%，將逐筆存倉" : ""}）。`;
    }
    const localStatus = plan.count
      ? `目前城鎮預計購買 ${plan.count} 件，合計 ${plan.total.toLocaleString()} Zeny。${storeNote}`
      : plan.localMatches ? "目前 Zeny 不足。" : "目前城鎮沒有符合條件的裝備。";
    $("market-status").textContent = localStatus +
      (plan.remote.length ? `其他城鎮有 ${plan.remote.length} 筆符合商品。` : "");
    $("market-remote-list").replaceChildren(...plan.remote.map(line =>
      marketRow(line, criteria.holes, line.item.qty, marketTowns[line.mapId] ?? line.mapId)));
    $("market-other").hidden = !plan.remote.length;
    if (!plan.count) return;
    marketPreview = {criteria, plan, autoStore};
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
        const deposit = planAutoDeposit(currentView.snapshot, storageBox, pendingDeposit.entries());
        if (!deposit.items.length) break;
        $("market-status").textContent = `已購買 ${bought}／${fresh.count} 件，${reason}，正在自動存倉（${deposit.totalQty} 件）…`;
        const beforeInventory = currentView.snapshot.inventory;
        const reply = await gameRequest(
          `/api/characters/${role.id}/commands`,
          guardedCommand(currentView, {type: "storageDeposit", items: deposit.items}),
        );
        const next = checkView(reply.view, role.id);
        verifyDeposited(beforeInventory, next.snapshot.inventory, deposit.items);
        currentView = next;
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

    for (const {vendorId, item, qty, unitWeight} of fresh.orders) {
      if (autoStore && pendingDeposit.size) {
        if (isOverHalfWeight(currentView.snapshot)) {
          await flushAutoDeposit("負重超過 50%");
        } else if (wouldExceedMaxWeight(currentView.snapshot, unitWeight, qty)) {
          await flushAutoDeposit("即將超過負重上限");
        }
      }
      if (autoStore && currentView.snapshot.character.zeny < item.price * qty) {
        throw new Error("扣除倉庫費後 Zeny 不足，無法繼續購買。");
      }
      $("market-status").textContent = `正在購買（${bought}／${fresh.count} 件）…`;
      submitted = true;
      const reply = await gameRequest(`/api/characters/${role.id}/vending/buy`, {
        vendorId, orders: [{cartUid: item.cartUid, qty, price: item.price}],
      });
      const {result} = reply;
      if (result?.paid !== item.price * qty) throw new Error("未能確認這筆購買金額。");
      bought += qty;
      paid += result.paid;
      if (autoStore) {
        const nextView = reply.view?.characterId === role.id && Array.isArray(reply.view?.snapshot?.inventory)
          ? checkView(reply.view, role.id)
          : checkView(await gameRequest(`/api/characters/${role.id}?deferCatchup=1`), role.id);
        const added = diffPurchasedItems(currentView.snapshot.inventory, nextView.snapshot.inventory, item.itemId, qty);
        for (const entry of added) {
          pendingDeposit.set(entry.uid, (pendingDeposit.get(entry.uid) ?? 0) + entry.qty);
        }
        currentView = nextView;
        if (isOverHalfWeight(currentView.snapshot) && pendingDeposit.size) {
          await flushAutoDeposit("負重超過 50%");
        }
      }
    }
    const storedSummary = stored
      ? `；已自動存倉 ${stored} 件（${depositRuns} 次，倉庫費 ${storageFees.toLocaleString()} Zeny）`
      : "";
    $("market-status").textContent = `已購買 ${bought} 件，共花費 ${paid.toLocaleString()} Zeny${storedSummary}。`;
  } catch (error) {
    const storedNote = stored
      ? `（已自動存倉 ${stored} 件，倉庫費 ${storageFees.toLocaleString()} Zeny）`
      : "";
    $("market-status").textContent = `購買停止。已確認 ${bought} 件、${paid.toLocaleString()} Zeny${storedNote}。${error.message}${submitted ? " 請先確認背包與倉庫再重試。" : ""}`;
  } finally {
    clearMarketPreview();
    lockMarket(false);
    if (submitted) await loadGear(true);
  }
}

try {
  const savedAutoStore = localStorage.getItem(marketAutoStoreKey);
  marketAutoStore.checked = savedAutoStore === null ? true : savedAutoStore === "true";
} catch {
  marketAutoStore.checked = true;
}
marketAutoStore.onchange = () => {
  try { localStorage.setItem(marketAutoStoreKey, String(marketAutoStore.checked)); } catch {}
};
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
  const box = await getStorage();
  const fee = handoffFee(current, box);
  if (record && (record.account !== account || record.source !== current.characterId || record.stage !== "preparing")) {
    throw new Error("目前已有一筆裝備交接。");
  }
  if (!record) {
    const config = sourceHandoffConfig(current.snapshot);
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

async function receiveHandoff(current, account, record) {
  if (!record || record.account !== account || record.source === current.characterId ||
      !(record.stage === "stored" || (record.stage === "received" && record.target === current.characterId))) {
    throw new Error("找不到這個角色可領取的交接裝備。");
  }
  if (!record.config.equipRules?.length) {
    throw new Error("這筆舊交接缺少原角色的換裝規則，請用「跨角色換裝重綁」補套用。");
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
  await saveAndApplyHandoff(current, config);
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
  if (!$("panel-growth").hidden) void archerMonitor("status");
}, 1500);

const timingDate = new Intl.DateTimeFormat("zh-TW", {dateStyle:"short", timeStyle:"medium"});
let timingRenderKey = "";

function timingDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours} 小時 ${minutes} 分 ${seconds % 60} 秒`;
}

async function renderArcherTiming() {
  const id = activeRole?.id;
  const target = $("archer-timing");
  if (!id) {
    timingRenderKey = "";
    target.textContent = "請先進入遊戲角色。";
    return;
  }
  const key = `archer-timing-v1:${id}`;
  try {
    const data = await chrome.storage.local.get(key);
    if (activeRole?.id !== id) return;
    const rounds = data[key] ?? [];
    const signature = JSON.stringify([id, rounds]);
    if (signature === timingRenderKey) return;
    timingRenderKey = signature;
    if (!rounds.length) {
      target.textContent = "尚無紀錄。啟用自動加點後開始計時。";
      return;
    }
    target.replaceChildren(...[...rounds].reverse().map((round, index) => {
      const block = document.createElement("details");
      block.open = index === 0;
      const summary = document.createElement("summary");
      const title = round.cycle ? `第 ${round.cycle} 轉` : "轉生前";
      const duration = round.end ? timingDuration(round.end - round.start) : index === 0 ? "計時未結算" : "結束時間未記錄";
      summary.textContent = `${title} · ${round.partial ? "部分紀錄 · " : ""}${duration}`;
      const events = document.createElement("ol");
      for (const event of round.events) {
        const row = document.createElement("li");
        row.textContent = `${timingDate.format(event.at)} · ${event.label}（+${timingDuration(event.at - round.start)}）`;
        events.append(row);
      }
      block.append(summary, events);
      return block;
    }));
  } catch {
    timingRenderKey = "";
    target.textContent = "無法讀取本機計時紀錄。";
  }
}

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
  if (focus) active.focus();
  if (active.id === "tab-growth") {
    void archerMonitor("status");
    void renderArcherTiming();
  }
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
refresh.onclick = () => catalog ? loadGear(true) : initialize();
storageMaterials.onchange = storageWeapons.onchange = () => loadGear(true);
target.onchange = autoEquip.onchange = () => renderEquipment(true);
start.onclick = runBatch;
stop.onclick = () => { cancelled = true; stop.disabled = true; };

async function initialize() {
  refresh.disabled = true;
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
    document.body.classList.toggle("floating", floating);
    $("open-floating").hidden = floating;
    [catalog, marketSlots, marketTowns, rebindItems] = await Promise.all(
      ["catalog.json", "market-slots.json", "market-towns.json", "rebind-items.json"].map(async path => {
        const response = await fetch(path, {signal: AbortSignal.timeout(10000)});
        if (!response.ok) throw new Error(`無法載入擴充資料（${path}），請重新載入擴充。`);
        return response.json();
      }),
    );
    storageMaterials.disabled = storageWeapons.disabled = false;
    await loadGear();
  } catch (error) {
    character.textContent = "無法讀取目前角色";
    status(error.message);
  } finally {
    refresh.disabled = false;
  }
}

await initialize();
