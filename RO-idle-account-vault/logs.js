
const rowsEl = document.querySelector("#rows");
const statusEl = document.querySelector("#status");
const moreEl = document.querySelector("#more");
const searchEl = document.querySelector("#search");
const kindEl = document.querySelector("#kind");
const scrollEl = document.querySelector("#log-scroll");
const autoScrollEl = document.querySelector("#auto-scroll");
let displayedRows = [];
let selectedCharacterKey = "";
const characterEl = document.querySelector("#log-character");
const recordingEl = document.querySelector("#record-character");
const deleteCharacterEl = document.querySelector("#delete-character-logs");
let characterCatalog = [];
let catalogRevision = "";
let lastCatalogRefresh = 0;

function characterOptionText(character) {
  return (character.character || "舊紀錄（角色無法辨識）") +
    (character.account ? " · " + character.account : "") +
    (!character.hasLogs ? " · 尚無紀錄" : "") +
    (character.mvpArchive?.backfilled ? " · 補存 " + character.mvpArchive.backfilled + " 場" : "");
}

async function refreshCharacterCatalog(register = true) {
  lastCatalogRefresh = Date.now();
  if (register) {
    const stored = await chrome.storage.local.get({profiles: []});
    const characters = stored.profiles.flatMap(profile => (profile.characters || []).map(character => ({
      characterId: String(character.id), character: character.name, account: profile.account || profile.name || "",
    }))).filter(character => character.characterId !== "null" && character.characterId !== "undefined");
    await VaultLogs.registerCharacters(characters);
  }
  characterCatalog = await VaultLogs.charactersWithLogStatus();
  const available = characterCatalog.filter(character => character.key !== "unknown" || character.hasLogs);
  const revision = JSON.stringify(available.map(character => [character.key, characterOptionText(character)]));
  if (revision !== catalogRevision) {
    catalogRevision = revision;
    const options = available.map(character => new Option(characterOptionText(character), character.key));
    characterEl.replaceChildren(...(options.length ? options : [new Option("尚無保存紀錄", "")]));
  }
  characterEl.disabled = !available.length;
  if (!available.some(character => character.key === selectedCharacterKey)) selectedCharacterKey = available[0]?.key || "";
  characterEl.value = selectedCharacterKey;
  const selected = characterCatalog.find(character => character.key === selectedCharacterKey);
  recordingEl.checked = selected?.enabled === true;
  recordingEl.disabled = !selected || selected.key === "unknown";
  deleteCharacterEl.disabled = !selected;
}
let currentCharacterSelectionBusy = false;
async function selectCurrentLogCharacter(reloadView) {
  if (currentCharacterSelectionBusy) return;
  currentCharacterSelectionBusy = true;
  try {
    const tab = await chrome.tabs.getCurrent();
    const response = await chrome.runtime.sendMessage({type: "ro-vault:current-character", windowId: tab?.windowId});
    if (!response?.ok || !response.character) return;
    const current = response.character;
    if (!characterCatalog.some(character => character.key === current.key)) await refreshCharacterCatalog();
    const selected = characterCatalog.find(character => character.key === current.key);
    if (!selected || selectedCharacterKey === selected.key) return;
    selectedCharacterKey = selected.key;
    characterEl.value = selected.key;
    recordingEl.checked = selected.enabled;
    recordingEl.disabled = selected.key === "unknown";
    selectedMvpBattleId = "";
    revealedLogIds.clear();
    if (reloadView) {await load(true);await refreshCaptureStatus();}
  } catch (error) {
    statusEl.textContent = "目前角色辨識失敗：" + error.message;
  } finally {currentCharacterSelectionBusy = false;}
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  await characterSettingsReady;
  await selectCurrentLogCharacter(true);
  refreshLiveMvp(true);
});
window.addEventListener("focus", async () => {
  await characterSettingsReady;
  await selectCurrentLogCharacter(true);
});

const characterSettingsReady = (async () => {
  await refreshCharacterCatalog();
  await selectCurrentLogCharacter(false);
})().catch(error => {statusEl.textContent = error.message;});
characterEl.onchange = () => {
  selectedCharacterKey = characterEl.value;
  recordingEl.disabled = !selectedCharacterKey || selectedCharacterKey === "unknown";
  recordingEl.checked = characterCatalog.find(character => character.key === selectedCharacterKey)?.enabled === true;
  selectedMvpBattleId = "";revealedLogIds.clear();renderLiveMvp();refreshLiveMvp(true);load(true);refreshCaptureStatus();
};
recordingEl.onchange = async () => {
  recordingEl.disabled = true;
  try {
    await VaultLogs.setRecording(selectedCharacterKey, recordingEl.checked);
    await refreshCharacterCatalog();
    await refreshCaptureStatus();
  } catch(error) {statusEl.textContent = error.message;}
  finally {recordingEl.disabled = !selectedCharacterKey || selectedCharacterKey === "unknown";}
};
deleteCharacterEl.onclick = async () => {
  const selected = characterCatalog.find(character => character.key === selectedCharacterKey);
  if (!selected || !confirm("刪除「" + (selected.character || "未辨識角色") + "」的所有已保存紀錄？刪除後會關閉此角色記錄。")) return;
  deleteCharacterEl.disabled = true;
  try {
    await VaultLogs.deleteCharacter(selectedCharacterKey);
    refreshStorageUsage(true);
    selectedMvpBattleId = "";revealedLogIds.clear();
    await refreshCharacterCatalog();await load(true);await refreshCaptureStatus();
  } catch(error) {statusEl.textContent = "刪除失敗：" + error.message;}
  finally {deleteCharacterEl.disabled = !selectedCharacterKey;}
};

const recordingManager = document.querySelector("#recording-manager");
document.querySelector("#open-recording-manager").onclick = async () => {
  const list = document.querySelector("#recording-role-list");
  list.textContent = "讀取角色中…";
  recordingManager.showModal();
  try {
    await refreshCharacterCatalog();
    const roles = characterCatalog.filter(character => character.key !== "unknown");
    list.replaceChildren(...roles.map(character => {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = character.enabled;
      checkbox.onchange = async () => {
        checkbox.disabled = true;
        try {
          await VaultLogs.setRecording(character.key, checkbox.checked);
          if (character.key === selectedCharacterKey) recordingEl.checked = checkbox.checked;
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          statusEl.textContent = error.message;
        } finally {checkbox.disabled = false;}
      };
      label.append(checkbox, document.createTextNode(characterOptionText(character)));
      return label;
    }));
    if (!roles.length) list.textContent = "尚未找到角色，請先開啟遊戲並選角。";
  } catch (error) {list.textContent = "角色讀取失敗：" + error.message;}
};

const reloadExtensionEl = document.querySelector("#reload-extension");
reloadExtensionEl.onclick = () => chrome.runtime.reload();
const recordLimitEl = document.querySelector("#record-limit");
VaultLogs.stats().then(stats => {recordLimitEl.value = String(stats.limit);}).catch(error => {statusEl.textContent = error.message;});
recordLimitEl.onchange = async () => {
  if (!selectedCharacterKey) return;
  recordLimitEl.disabled = true;
  try {
    await VaultLogs.setLimit(Number(recordLimitEl.value), selectedCharacterKey);
    refreshStorageUsage(true);
    await load(true);
    await refreshCaptureStatus();
  } catch (error) {
    statusEl.textContent = "上限設定失敗：" + error.message;
    const stats = await VaultLogs.stats(selectedCharacterKey).catch(() => null);
    if (stats) recordLimitEl.value = String(stats.limit);
  } finally {recordLimitEl.disabled = false;}
};
const mvpLimitEl = document.querySelector("#mvp-record-limit");
mvpLimitEl.onchange = async () => {
  const key = selectedCharacterKey;
  if (!key) return;
  mvpLimitEl.disabled = true;
  try {
    await VaultLogs.setMvpArchiveLimit(Number(mvpLimitEl.value), key);
    if (key === selectedCharacterKey) await refreshMvpArchive(key);
    refreshStorageUsage(true);
  } catch (error) {
    statusEl.textContent = "王戰上限設定失敗：" + error.message;
  } finally {mvpLimitEl.disabled = false;}
};
document.querySelector("#settings-toggle").onclick = event => {
  const settings = document.querySelector("#display-settings");
  settings.hidden = !settings.hidden;
  event.target.setAttribute("aria-expanded", String(!settings.hidden));
};
document.querySelector("#font-size").onchange = event => {
  document.documentElement.style.setProperty("--log-font-size", event.target.value + "px");
};
autoScrollEl.onchange = () => {
  if (autoScrollEl.checked) {scrollEl.scrollTop = scrollEl.scrollHeight;load(true);}
};
scrollEl.addEventListener("scroll", () => {
  if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > 32) autoScrollEl.checked = false;
});
document.querySelector("#search-form").onsubmit = event => {event.preventDefault();load(true);};

let selectedCategory = "all";
let mvpBattles = [];
const revealedLogIds = new Set();
let playbackTimer;
let selectedMvpBattleId = "";
let focusedMvpDetail = null;
let mvpHistoryScrollTop = 0;
const playbackEl = document.querySelector("#line-playback");
const playbackSpeedEl = document.querySelector("#playback-speed");

function startLinePlayback() {
  clearInterval(playbackTimer);
  const pending = [...rowsEl.querySelectorAll(".saved-log")].filter(line => !revealedLogIds.has(line.dataset.recordId));
  for (const line of pending) line.hidden = playbackEl.checked;
  for (const section of rowsEl.querySelectorAll(".mvp-battle")) {
    section.hidden = !section.querySelector(".saved-log:not([hidden])");
  }
  function reveal(line) {
    line.hidden = false;
    revealedLogIds.add(line.dataset.recordId);
    const section = line.closest(".mvp-battle");
    if (section) section.hidden = false;
    if (autoScrollEl.checked) scrollEl.scrollTop = scrollEl.scrollHeight;
  }
  if (!playbackEl.checked) {
    pending.forEach(reveal);
    return;
  }
  if (!pending.length) return;
  let index = 0;
  playbackTimer = setInterval(() => {
    if (index >= pending.length) {clearInterval(playbackTimer);return;}
    reveal(pending[index++]);
  }, Number(playbackSpeedEl.value));
}
playbackEl.onchange = startLinePlayback;
playbackSpeedEl.onchange = startLinePlayback;

const mvpDetailEntries = new Map();
const logEventLabelsReady = fetch("log-event-labels.json")
  .then(response => response.ok ? response.json() : {})
  .catch(() => {});

function fitMvpDetail(detail, reveal = false) {
  const pane = detail.closest("#mvp-archive");
  const rows = detail.querySelector(".mvp-detail-rows");
  if (!detail.open || !pane?.open || !rows?.childElementCount || !pane.clientHeight) return;
  const bottom = pane.getBoundingClientRect().top + pane.clientTop + pane.clientHeight -
    parseFloat(getComputedStyle(pane).paddingBottom);
  const box = rows.getBoundingClientRect();
  const minimum = 64;
  let height = bottom - box.top;
  if (reveal && height < minimum) {
    pane.scrollTop += minimum - height;
    height = bottom - rows.getBoundingClientRect().top;
  }
  rows.style.height = Math.max(minimum, Math.floor(height)) + "px";
}

const mvpHistoryPane = document.querySelector("#mvp-archive");
if (typeof ResizeObserver === "function") {
  const mvpSizeObserver = new ResizeObserver(() => {
    for (const detail of mvpHistoryPane.querySelectorAll(".mvp-detail[open]")) fitMvpDetail(detail);
  });
  mvpSizeObserver.observe(mvpHistoryPane);
}
mvpHistoryPane.addEventListener("toggle", () => {
  if (mvpHistoryPane.open) {
    for (const detail of mvpHistoryPane.querySelectorAll(".mvp-detail[open]")) fitMvpDetail(detail);
  }
});

function createMvpDetail(battle, characterKey, title) {
  const detail = document.createElement("details");
  detail.className = "mvp-detail";
  const summary = document.createElement("summary");
  summary.className = "mvp-entry";
  summary.textContent = title;
  const toolbar = document.createElement("div");
  toolbar.className = "mvp-detail-toolbar";
  const mode = document.createElement("select");
  mode.setAttribute("aria-label", "MVP 紀錄顯示範圍");
  mode.append(new Option("只看這隻 MVP", "related"), new Option("同時間全部紀錄", "all"));
  const state = document.createElement("p");
  state.className = "mvp-detail-status";
  state.setAttribute("role", "status");
  const rows = document.createElement("div");
  rows.className = "mvp-detail-rows";
  rows.tabIndex = 0;
  rows.setAttribute("role", "region");
  rows.setAttribute("aria-label", "此場 MVP 戰鬥明細");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn";
  more.textContent = "顯示更多";
  more.hidden = true;
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "btn";
  jump.textContent = "跳到結算";
  toolbar.append(mode, jump, more);
  detail.append(summary, toolbar, state, rows);

  let loaded = false;
  let revision = 0;
  let limit = 150;
  let fromEnd = false;
  async function loadDetails(reveal = false) {
    const request = ++revision;
    state.textContent = "讀取中…";
    more.hidden = true;
    try {
      const [data, names, labels] = await Promise.all([
        VaultLogs.readMvpDetails(characterKey, battle, mode.value === "related", limit, fromEnd),
        monsterNamesReady, logEventLabelsReady,
      ]);
      if (request !== revision) return;
      const entries = data.rows.map(row => {
        const line = document.createElement("div");
        line.className = "saved-log";
        line.dataset.category = CombatLogs.category(row);
        if (row.tone) line.dataset.tone = row.tone;
        const time = document.createElement("time");
        time.className = "log-time";
        time.textContent = new Date(CombatLogs.eventTime(row)).toLocaleTimeString("zh-TW", {timeZone:"Asia/Taipei", hour12:false});
        const message = document.createElement("pre");
        message.textContent = CombatLogs.describeArchivedEvent(row, names, labels ?? {}, battle).replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, "");
        line.append(time, message);
        return line;
      });
      rows.replaceChildren(...entries);
      state.textContent = entries.length
        ? `顯示${fromEnd && data.more ? "最後" : ""} ${entries.length}／${data.total ?? entries.length} 筆`
        : "這個範圍沒有可顯示的紀錄。";
      more.hidden = !data.more;
      loaded = true;
      fitMvpDetail(detail, reveal);
      if (fromEnd) rows.scrollTop = rows.scrollHeight;
    } catch (error) {
      if (request === revision) state.textContent = "詳細紀錄讀取失敗：" + error.message;
    }
  }
  detail.ontoggle = () => {
    const pane = detail.closest("#mvp-archive");
    if (!detail.open) {
      if (focusedMvpDetail === detail) {
        focusedMvpDetail = null;
        rows.style.height = "";
        requestAnimationFrame(() => {if (pane) pane.scrollTop = mvpHistoryScrollTop;});
      }
      return;
    }
    if (focusedMvpDetail !== detail) {
      mvpHistoryScrollTop = pane?.scrollTop ?? 0;
      focusedMvpDetail = detail;
    }
    for (const other of detail.parentElement?.querySelectorAll(":scope > .mvp-detail[open]") ?? []) {
      if (other !== detail) other.open = false;
    }
    if (pane) pane.scrollTop = 0;
    if (loaded) fitMvpDetail(detail, true);
    else loadDetails(true);
  };
  mode.onchange = () => {limit = 150;loadDetails();};
  more.onclick = () => {limit += 150;loadDetails();};
  jump.onclick = () => {
    fromEnd = !fromEnd;
    limit = 150;
    jump.textContent = fromEnd ? "回到開頭" : "跳到結算";
    rows.scrollTop = 0;
    loadDetails();
  };
  return detail;
}

function renderMvpArchive() {
  const list = document.querySelector("#mvp-archive-list");
  const revision = JSON.stringify([selectedMvpBattleId, mvpLimitEl.value, mvpBattles.map(battle => [battle.id, battle.monsterName, battle.result, battle.startedAt, battle.endedAt, battle.character])]);
  if (list.dataset.revision === revision) return;
  list.dataset.revision = revision;
  const history = document.querySelector("#mvp-archive");
  const previousScroll = history.scrollTop;
  list.replaceChildren();
  document.querySelector("#mvp-archive-summary").textContent = "已保存 MVP 戰鬥（" + mvpBattles.length + "／" + mvpLimitEl.value + " 場）";
  const kept = new Set();
  for (const battle of mvpBattles.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))) {
    const when = battle.startedAt ? new Date(battle.startedAt).toLocaleString("zh-TW", {timeZone: "Asia/Taipei", hour12: false}) : "日期未記錄";
    const title = [when, battle.character || battle.characterId, battle.monsterName || (battle.monsterId ? "怪物 #" + battle.monsterId : "MVP 訊息"), battle.result || "", battle.backfilled ? "舊紀錄補存" : ""].filter(Boolean).join(" · ");
    const key = JSON.stringify([selectedCharacterKey, battle.id, battle.startedAt, battle.endedAt, title]);
    if (!mvpDetailEntries.has(key)) mvpDetailEntries.set(key, createMvpDetail(battle, selectedCharacterKey, title));
    const detail = mvpDetailEntries.get(key);
    kept.add(key);
    list.append(detail);
  }
  for (const key of mvpDetailEntries.keys()) if (!kept.has(key)) mvpDetailEntries.delete(key);
  if (!mvpBattles.length) {
    const empty = document.createElement("p");
    empty.textContent = "目前保存的紀錄中尚未辨識到 MVP 戰鬥。";
    list.append(empty);
  }
  history.scrollTop = previousScroll;
}

const mvpOnlyEl = document.querySelector("#mvp-only");
const categoriesEl = document.querySelector("#categories");
for (const [value, label] of Object.entries(CombatLogs.categories)) {
  const button = document.createElement("button");
  button.className = "btn tiny";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-pressed", String(value === selectedCategory));
  button.onclick = () => {
    selectedCategory = value;
    for (const sibling of categoriesEl.children) sibling.setAttribute("aria-pressed", String(sibling === button));
    load(true);
  };
  categoriesEl.append(button);
}
mvpOnlyEl.onchange = () => load(true);

const logCatalogReady = fetch("ro-catalog.json")
  .then(response => response.ok ? response.json() : [])
  .catch(() => []);
const monsterNamesReady = logCatalogReady
  .then(maps => new Map(maps.flatMap(map => map.monsters.map(monster => [Number(monster.id), monster.name]))));

let liveMvpContext = null;
let liveMvpRequest = 0;
let lastMvpStatusCheck = 0;
const mvpDate = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
function renderLiveMvp() {
  const mapLabel = document.querySelector("#live-mvp-map");
  const target = document.querySelector("#live-mvp-target");
  const list = document.querySelector("#live-mvp-list");
  const state = liveMvpContext?.key === selectedCharacterKey ? liveMvpContext.state : null;
  if (!state) {
    mapLabel.textContent = "開啟目前角色的遊戲分頁後，可查看地圖與重生狀態。";
    target.hidden = true;
    list.replaceChildren();
    return;
  }
  const {map, maps, snapshot} = state;
  mapLabel.textContent = "目前地圖 · " + (map?.name ?? snapshot.mapId);
  const monsters = map?.monsters.filter(monster => monster.kind === "mvp") ?? [];
  const configured = snapshot.whitelist.length ? snapshot.whitelist : snapshot.priority;
  const hunted = monsters.filter(monster => configured.some(id => Number(id) === Number(monster.id)));
  target.textContent = "設定狩獵的 MVP · " + (hunted.map(monster => monster.name).join("、") || "未指定");
  target.hidden = false;
  const now = Date.now();
  const entries = monsters.map(monster => {
    const gameKill = snapshot.lastKills.find(record => record.name === monster.name);
    const reportedAt = typeof gameKill?.at === "number" ? gameKill.at : Date.parse(gameKill?.at);
    const singleMap = maps.filter(candidate => candidate.monsters.some(entry => entry.id === monster.id)).length === 1;
    const local = singleMap && mvpCharacterKey === selectedCharacterKey ? mvpBattles.filter(battle =>
      (Number(battle.monsterId) === Number(monster.id) || battle.monsterName === monster.name) &&
      ["取得 MVP 獎勵", "隊伍獲勝"].includes(battle.result))
        .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0] : null;
    const lastKill = Number.isFinite(reportedAt) ? reportedAt : local?.endedAt;
    const status = CombatLogs.mvpRespawn(monster.respawn, lastKill, now, {
      encountered: Number(snapshot.target?.id) === Number(monster.id) || snapshot.target?.name === monster.name,
      unavailable: Boolean(gameKill),
      noCooldown: !gameKill && !Number.isFinite(lastKill),
    });
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = monster.name + " · " + status.label;
    const detail = document.createElement("span");
    const kill = Number.isFinite(lastKill)
      ? "上次擊倒 " + mvpDate.format(lastKill) + (gameKill?.by ? "（" + gameKill.by + "）" : gameKill ? "（遊戲）" : "（本機紀錄）")
      : "上次擊倒未記錄";
    detail.textContent = kill + (status.start == null ? "" : " · 預估重生 " + mvpDate.format(status.start) +
      (status.end === status.start ? "" : "～" + mvpDate.format(status.end)));
    row.append(title, detail);
    return row;
  });
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.textContent = map ? "這張地圖的圖鑑沒有列出 MVP。" : "此地圖未收錄於內建圖鑑。";
    entries.push(empty);
  }
  list.replaceChildren(...entries);
}

async function refreshLiveMvp(force = false) {
  const key = selectedCharacterKey;
  if (!key || (!force && Date.now() - lastMvpStatusCheck < 20000)) return;
  lastMvpStatusCheck = Date.now();
  const request = ++liveMvpRequest;
  try {
    const tab = await chrome.tabs.getCurrent();
    const [response, maps] = await Promise.all([
      chrome.runtime.sendMessage({type: "ro-vault:mvp-status", characterKey: key, windowId: tab?.windowId}),
      logCatalogReady,
    ]);
    if (request !== liveMvpRequest || key !== selectedCharacterKey) return;
    const snapshot = response?.ok ? response.state : null;
    const map = maps.find(item => item.id === snapshot?.mapId);
    liveMvpContext = {key, state: snapshot ? {snapshot, map, maps} : null};
  } catch {
    if (request !== liveMvpRequest || key !== selectedCharacterKey) return;
    liveMvpContext = null;
  }
  renderLiveMvp();
}

let mvpCharacterKey = "";
let mvpReadVersion = 0;
async function refreshMvpArchive(characterKey) {
  const requestVersion = ++mvpReadVersion;
  const apply = (battles, refreshFilteredRows) => {
    if (selectedCharacterKey !== characterKey || requestVersion !== mvpReadVersion) return;
    mvpCharacterKey = characterKey;
    mvpBattles = battles;
    renderMvpArchive();
    renderLiveMvp();
    if (refreshFilteredRows && (mvpOnlyEl.checked || selectedMvpBattleId)) {
      if (!loading) load(true, false, false);
    }
    else renderLogRows(displayedRows);
  };
  try {
    const monsterNames = await monsterNamesReady;
    apply(await VaultLogs.indexedMvpBattles(characterKey, monsterNames), true);
    await VaultLogs.refreshMvpIndex(characterKey);
    const [battles, archive] = await Promise.all([
      VaultLogs.indexedMvpBattles(characterKey, monsterNames), VaultLogs.mvpArchiveStatus(characterKey),
    ]);
    if (selectedCharacterKey === characterKey && requestVersion === mvpReadVersion) {
      mvpLimitEl.value = String(archive?.limit ?? 20);
      const character = characterCatalog.find(item => item.key === characterKey);
      const option = [...characterEl.options].find(item => item.value === characterKey);
      if (character && option) {
        character.mvpArchive = archive;
        option.textContent = characterOptionText(character);
      }
    }
    apply(battles, true);
  } catch (error) {
    if (selectedCharacterKey === characterKey && requestVersion === mvpReadVersion) {
      document.querySelector("#mvp-archive-summary").textContent = "MVP 索引讀取失敗：" + error.message;
    }
  }
}
let offset = 0;
let exhausted = false;
let loading = false;
let pendingReset = false;
let pendingAnimateNew = true;
function matches(row) {
  const query = searchEl.value.trim().toLocaleLowerCase();
  return row.characterKey === selectedCharacterKey && (!selectedMvpBattleId || CombatLogs.battle(row, mvpBattles)?.id === selectedMvpBattleId) &&
    (selectedCategory === "all" || CombatLogs.category(row) === selectedCategory) &&
    (!mvpOnlyEl.checked || CombatLogs.battle(row, mvpBattles)) &&
    (!kindEl.value || row.kind === kindEl.value) &&
    (!query || [row.account, row.character, row.characterId, row.text].join(" ").toLocaleLowerCase().includes(query));
}
function reconcileLogChildren(parent, wanted) {
  const keep = new Set(wanted);
  for (const node of [...parent.children]) if (!keep.has(node)) node.remove();
  let next = parent.firstElementChild;
  for (const node of wanted) {
    if (node === next) next = next.nextElementSibling;
    else parent.insertBefore(node, next);
  }
}

function renderLogRows(rows) {
  const articles = new Map([...rowsEl.querySelectorAll(".saved-log")].map(node => [node.dataset.recordId, node]));
  const sections = new Map([...rowsEl.querySelectorAll(".mvp-battle")].map(node => [node.dataset.renderKey, node]));
  const dividers = new Map([...rowsEl.querySelectorAll(".day-divider")].map(node => [node.dataset.day, node]));
  const wanted = [];
  const sectionRows = new Map();
  let previousDay = "";
  let activeSection = null;
  for (const row of rows.slice().reverse()) {
    const eventAt = CombatLogs.eventTime(row);
    const receivedAt = Number.isFinite(row.receivedAt) ? row.receivedAt : eventAt;
    const day = CombatLogs.dayKey(receivedAt);
    if (day !== previousDay) {
      const divider = dividers.get(day) || document.createElement("div");
      divider.className = "day-divider";divider.dataset.day = day;
      divider.textContent = day + "（接收日期・台北時間）";
      wanted.push(divider);previousDay = day;activeSection = null;
    }
    let article = articles.get(row.id);
    if (!article) {
      article = document.createElement("article");
      article.className = "saved-log";article.dataset.recordId = row.id;
      article.dataset.category = CombatLogs.category(row);
      if (row.tone) article.dataset.tone = row.tone;
      article.title = ["原始事件時間 " + new Date(eventAt).toLocaleString("zh-TW"), "接收時間 " + new Date(receivedAt).toLocaleString("zh-TW"), row.text, row.account, row.character || row.characterId, CombatLogs.categories[CombatLogs.category(row)]].filter(Boolean).join(" · ");
      const caption = document.createElement("time");caption.className = "log-time";
      caption.dateTime = new Date(receivedAt).toISOString();
      caption.textContent = "[" + new Date(receivedAt).toLocaleTimeString("zh-TW", {hour12: false, timeZone: "Asia/Taipei"}) + "]";
      const text = document.createElement("pre");
      text.textContent = (row.text || "").replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, "");
      if (row.kind === "事件 JSON") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");summary.textContent = row.event || "事件 JSON";
        details.append(summary, text);article.append(caption, details);
      } else article.append(caption, text);
    }
    const battle = CombatLogs.battle(row, mvpBattles);
    if (battle) {
      if (!activeSection || activeSection.dataset.battleId !== battle.id) {
        const key = day + ":" + battle.id + ":" + row.id;
        activeSection = sections.get(key) || document.createElement("section");
        activeSection.className = "mvp-battle";
        activeSection.dataset.battleId = battle.id;activeSection.dataset.renderKey = key;
        if (!activeSection.firstElementChild) {
          const heading = document.createElement("h2");
          heading.textContent = battle.notice && (!battle.textContext || battle.startedAt === battle.endedAt) ? "MVP 訊息" : "MVP 戰鬥" + (battle.monsterName ? " · " + battle.monsterName : battle.monsterId != null ? " · 怪物 #" + battle.monsterId : "");
          activeSection.append(heading);
        }
        sectionRows.set(activeSection, [activeSection.firstElementChild]);
        wanted.push(activeSection);
      }
      sectionRows.get(activeSection).push(article);
    } else {wanted.push(article);activeSection = null;}
  }
  for (const [section, children] of sectionRows) reconcileLogChildren(section, children);
  reconcileLogChildren(rowsEl, wanted);
}

async function load(reset = false, animateNew = false, refreshArchive = true) {
  await characterSettingsReady;
  if (loading) {
    if (reset) {
      pendingAnimateNew = pendingReset ? pendingAnimateNew && animateNew : animateNew;
      pendingReset = true;
    }
    return;
  }
  loading = true;
  moreEl.disabled = true;
  const previousTop = scrollEl.scrollTop;
  const previousHeight = scrollEl.scrollHeight;
  if (reset) {offset = 0; exhausted = false;}
  const skip = offset;
  try {
    if (!selectedCharacterKey) {
      displayedRows = [];
      mvpBattles = [];
      mvpCharacterKey = "";
      renderMvpArchive();
      renderLiveMvp();
      renderLogRows(displayedRows);
      statusEl.textContent = "請選擇角色";
      moreEl.hidden = true;
      return;
    }
    const key = selectedCharacterKey;
    const db = await VaultLogs.openCharacter(key);
    if (key !== selectedCharacterKey) {db.close();return;}
    if (mvpCharacterKey !== key) mvpBattles = [];
    const rows = await new Promise((resolve, reject) => {
      const transaction = db.transaction("logs", "readonly");
      const selected = mvpBattles.find(battle => battle.id === selectedMvpBattleId);
      const indexName = selected ? "characterEventAt" : "characterReceivedAt";
      const range = IDBKeyRange.bound([selectedCharacterKey, selected?.startedAt ?? 0],
        [selectedCharacterKey, selected ? (selected.endedAt ?? selected.startedAt) : Number.MAX_SAFE_INTEGER]);
      const request = transaction.objectStore("logs").index(indexName).openCursor(range, "prev");
      const found = [];
      let matched = 0;
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {exhausted = true; resolve(found); return;}
        if (matches(cursor.value) && ++matched > skip) found.push(cursor.value);
        if (found.length >= 200) {resolve(found); return;}
        cursor.continue();
      };
    });
    db.close();
    if (key !== selectedCharacterKey) return;
    offset += rows.length;
    displayedRows = reset ? rows : displayedRows.concat(rows);
    if (!animateNew) for (const row of displayedRows) revealedLogIds.add(row.id);
    renderLogRows(displayedRows);
    statusEl.textContent = offset ? "目前顯示 " + offset + " 筆" : "目前篩選沒有紀錄";
    if (autoScrollEl.checked) scrollEl.scrollTop = scrollEl.scrollHeight;
    else scrollEl.scrollTop = reset ? previousTop : previousTop + scrollEl.scrollHeight - previousHeight;
    moreEl.hidden = exhausted;
    startLinePlayback();
    if (refreshArchive && (reset || skip === 0)) refreshMvpArchive(selectedCharacterKey);
  } catch (error) {statusEl.textContent = "讀取失敗：" + error.message;}
  finally {
    loading = false; moreEl.disabled = false;
    if (pendingReset) {
      const animate = pendingAnimateNew;
      pendingReset = false;pendingAnimateNew = true;
      load(true, animate);
    }
  }
}
document.querySelector("#refresh").onclick = () => load(true);
document.querySelector("#latest").onclick = () => {
  selectedMvpBattleId = "";selectedCategory = "all";
  for (const category of categoriesEl.children) category.setAttribute("aria-pressed", String(category.textContent === "全部"));
  mvpOnlyEl.checked = false;searchEl.value = "";kindEl.value = "遊戲文字";
  document.querySelector("#latest").textContent = "回到最新";
  autoScrollEl.checked = true;load(true);
};
moreEl.onclick = () => load();
searchEl.onchange = () => load(true);
kindEl.onchange = () => load(true);
document.querySelector("#export").onclick = async event => {
  event.target.disabled = true;
  try {
    const key = selectedCharacterKey;
    if (!key) return;
    const db = await VaultLogs.openCharacter(key, true);
    const chunks = await new Promise((resolve, reject) => {
      const parts = [];
      const request = db.transaction("logs").objectStore("logs").index("eventAt").openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {resolve(parts);return;}
        if (cursor.value.characterKey === key) parts.push(JSON.stringify(cursor.value) + "\n");
        cursor.continue();
      };
    });
    db.close();
    const url = URL.createObjectURL(new Blob(chunks, {type: "application/x-ndjson;charset=utf-8"}));
    const anchor = document.createElement("a");anchor.href = url;
    anchor.download = "RO-LOG-" + (characterCatalog.find(character => character.key === key)?.character || "角色") + "-" + CombatLogs.dayKey(Date.now()) + ".jsonl";
    anchor.click();setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch(error) {statusEl.textContent = "匯出失敗：" + error.message;}
  finally {event.target.disabled = false;}
};
load(true);

let lastStorageUsageCheck = 0;
function formatStorageBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0);
  return new Intl.NumberFormat("zh-TW", {maximumFractionDigits: index ? 1 : 0})
    .format(bytes / 1024 ** index) + " " + units[index];
}

async function refreshStorageUsage(force = false) {
  if (!force && Date.now() - lastStorageUsageCheck < 15000) return;
  lastStorageUsageCheck = Date.now();
  const element = document.querySelector("#storage-usage");
  try {
    const estimate = await navigator.storage?.estimate?.();
    const usage = estimate?.usage;
    element.textContent = Number.isFinite(usage) && usage >= 0
      ? "本機占用（估算） " + formatStorageBytes(usage)
      : "瀏覽器未提供占用容量";
  } catch {
    element.textContent = "目前無法取得占用容量";
  }
}

let lastArchiveCount = -1;
async function refreshCaptureStatus() {
  refreshStorageUsage();
  const element = document.querySelector("#capture-status");
  try {
    await characterSettingsReady;
    if (Date.now() - lastCatalogRefresh >= 15000) {
      const previous = selectedCharacterKey;
      await refreshCharacterCatalog(false);
      if (previous !== selectedCharacterKey) {revealedLogIds.clear();load(true);}
    }
    const requestedCharacterKey = selectedCharacterKey;
    refreshLiveMvp();
    const local = await VaultLogs.stats(requestedCharacterKey);
    let status;
    try {
      status = await chrome.runtime.sendMessage({type: "ro-vault:log-status"});
      if (!status?.ok) throw new Error(status?.error || "無法連接紀錄服務");
    } catch (error) {
      reloadExtensionEl.hidden = false;
      element.textContent = "本機已保存 " + local.count + " 筆。背景紀錄服務未回應：" + error.message + "。請確認已重新載入 1.9.4 版擴充。";
      return;
    }
    if (requestedCharacterKey !== selectedCharacterKey) return;
    const errors = status.captures.filter(capture => capture.error);
    const outdated = status.recorderVersion !== "1.9.4" || errors.some(capture => /version.*less than|VersionError|版本/i.test(capture.error));
    reloadExtensionEl.hidden = !outdated;
    const saved = local.lastSavedAt ? "，最後保存 " + new Date(local.lastSavedAt).toLocaleString("zh-TW") : "";
    const selected = characterCatalog.find(character => character.key === selectedCharacterKey);
    if (!recordLimitEl.disabled && requestedCharacterKey) recordLimitEl.value = String(local.limit);
    element.textContent = (selected?.character || "請選角色") + " · " + (recordingEl.checked ? "記錄中" : "未開啟記錄") + " · 此角色 " + local.count.toLocaleString() + " / " + local.limit.toLocaleString() + " 筆" + saved +
      (status.captures.length ? "，監看 " + status.captures.length + " 個遊戲分頁" : "，請開啟遊戲分頁") +
      (outdated ? "。背景程式仍是舊版，請按「重新載入擴充」後重開紀錄頁。" : "") +
      (errors.length ? "。保存錯誤：" + errors.map(capture => capture.error).join(" / ") : "");
    const revision = selectedCharacterKey + ":" + local.count + ":" + local.lastSavedAt;
    if (lastArchiveCount !== revision) {
      if (offset <= 200 && autoScrollEl.checked) {
        document.querySelector("#latest").textContent = "回到最新";
        load(true, true);
      } else document.querySelector("#latest").textContent = "回到最新（有新訊息）";
    }
    lastArchiveCount = revision;
  } catch (error) {element.textContent = "保存狀態讀取失敗：" + error.message;}
}
refreshCaptureStatus();
let statusRefreshBusy = false;
setInterval(async () => {
  if (document.visibilityState === "hidden" || statusRefreshBusy) return;
  statusRefreshBusy = true;
  try {await refreshCaptureStatus();} finally {statusRefreshBusy = false;}
}, 3000);
