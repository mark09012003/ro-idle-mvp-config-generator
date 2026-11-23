importScripts("logs-model.js", "logs-db.js");
importScripts("lib.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create("refresh-live", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("refresh-live", { periodInMinutes: 1 });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create("refresh-live", { periodInMinutes: 1 });

function readPageSnapshot() {
  const localStorageData = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) localStorageData[key] = localStorage.getItem(key);
  }
  const sessionStorageData = {};
  let loginName = "";
  let accountIdHint = "";
  let providerHint = "";
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key || key.startsWith("ro-ext:")) continue;
      sessionStorageData[key] = sessionStorage.getItem(key);
    }
    loginName = sessionStorage.getItem("ro-ext:loginName") || "";
    accountIdHint = sessionStorage.getItem("ro-ext:accountId") || "";
    providerHint = sessionStorage.getItem("ro-ext:provider") || "";
  } catch (error) {
    loginName = "";
  }
  return fetch("/api/auth/me", { credentials: "same-origin" }).then(async (meResponse) => {
    const status = meResponse.status;
    const me = meResponse.ok ? await meResponse.json() : null;
    if (!meResponse.ok) return { localStorageData, me, status };
    const characterResponse = await fetch("/api/characters", { credentials: "same-origin" });
    const characters = characterResponse.ok ? await characterResponse.json() : null;
    let altCharacters = [];
    const primary = characters && Array.isArray(characters.characters) ? characters.characters : [];
    const seed = primary.find((character) => character && character.id != null);
    if (seed) {
      try {
        const partyResponse = await fetch(`/api/characters/${seed.id}/party`, { credentials: "same-origin" });
        if (partyResponse.ok) {
          const party = await partyResponse.json();
          if (party && Array.isArray(party.own)) altCharacters = party.own;
        }
      } catch (error) {
        altCharacters = [];
      }
    }
    try {
    const identity = me && (me.user || me.account || me);
    const liveId = identity && (identity.accountId ?? identity.userId ?? identity.uid ?? identity.id);
    const boundId = sessionStorage.getItem("ro-ext:boundAccountId");
    if (liveId != null && boundId && boundId !== String(liveId)) {
      loginName = ""; sessionStorage.removeItem("ro-ext:loginName");
    }
    if (liveId != null) sessionStorage.setItem("ro-ext:boundAccountId", String(liveId));
  } catch (error) {}
  const loginInput = document.querySelector('input[autocomplete="username"]');
    if (loginInput && loginInput.value.trim()) loginName = loginInput.value.trim();
    const caption = document.querySelector(".xp-title .caption");
    const captionText = caption && caption.textContent ? caption.textContent.trim() : "";
    const playing = captionText.match(/^RO放置仙境 - \[([^\]]+)\]/);
    return {
      localStorageData,
      sessionStorageData,
      me,
      characters,
      altCharacters,
      charactersKnown: Boolean(characters && Array.isArray(characters.characters)),
      loginName: loginName.trim().slice(0, 64),
      accountIdHint: String(accountIdHint || "").trim().slice(0, 24),
      providerHint: String(providerHint || "").trim().slice(0, 16),
      activeCharacterName: playing ? playing[1].trim().slice(0, 24) : "",
      status,
    };
  }).catch(() => ({ localStorageData, status: 0 }));
}

async function refreshSavedLogin() {
  if (await AccountVault.switchLocked()) return;
  const site = AccountVault.SITE;
  const tabs = await chrome.tabs.query({ url: `${site}*` });
  if (!tabs.length) return;
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = activeTabs.find((item) => item.url && item.url.startsWith(site)) || tabs[0];
  if (!tab || tab.id == null) return;
  let snapshot;
  try {
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageSnapshot });
    snapshot = injected && injected.result;
  } catch (error) {
    return;
  }
  if (!snapshot || snapshot.status !== 200) return;
  const charactersKnown = snapshot.charactersKnown === true;
  const loginName = typeof snapshot.loginName === "string" ? snapshot.loginName.trim().slice(0, 64) : "";
  const characters = charactersKnown
    ? AccountVault.pickCharacters(AccountVault.combineCharacters(snapshot.characters, snapshot.altCharacters))
    : null;
  if (!charactersKnown && !loginName) return;
  const provider = AccountVault.pickProvider(snapshot.me) || snapshot.providerHint || "";
  const google = AccountVault.isGoogleAccount({provider});
  const cookies = google ? [] : AccountVault.durableCookies(await AccountVault.listSiteCookies());
  const fingerprint = google ? "" : await AccountVault.fingerprintCookies(cookies);
  const accountId = AccountVault.pickAccountId(snapshot.me) ?? AccountVault.parseAccountId(snapshot.accountIdHint);
  const stored = await chrome.storage.local.get({ profiles: [] });
  const profiles = Array.isArray(stored.profiles) ? stored.profiles : [];
  const account = (google ? AccountVault.pickGoogleAccount(snapshot.me) : AccountVault.pickAccount(snapshot.me)) || loginName || (google ? "Google 帳號" : "");
  const match = AccountVault.findLoginProfile(profiles, {
    fingerprint,
    accountId,
    provider,
    loginName,
    account,
    characters: characters || [],
  });
  const index = match ? profiles.indexOf(match) : -1;
  if (index < 0) return;
  const current = profiles[index];
  if (AccountVault.isGoogleAccount(current)) {
    const updated = AccountVault.updateGoogleCharacters(current, {accountId, characters, charactersKnown});
    if (updated === current || await AccountVault.switchLocked()) return;
    profiles[index] = updated;
    await chrome.storage.local.set({profiles});
    return;
  }
  if (current.accountId != null && accountId != null && String(current.accountId) !== String(accountId)) return;
  const nextCharacters = charactersKnown ? characters : (current.characters || []);
  const chosen = nextCharacters.find((character) => character && character.running) || nextCharacters[0];
  const nextAccount = current.account || account || "";
  const keptName = typeof current.name === "string" && !current.name.startsWith("編號") ? current.name : "";
  const nextProvider = provider || current.provider || "";
  const name = nextAccount || keptName || current.name || (nextProvider === "google" ? "Google 帳號" : "");
  const jobLabel = (chosen && (AccountVault.jobName(chosen.job) || chosen.jobLabel)) || current.jobLabel || "";
  const localStorageData = AccountVault.keepAccountStorage(current.localStorageData, snapshot.localStorageData, nextCharacters);
  const sessionStorageData = snapshot.sessionStorageData || current.sessionStorageData || {};
  const nextFingerprint = fingerprint || current.fingerprint;
  const nextCookies = cookies.length ? cookies : current.cookies;
  if (JSON.stringify(current.characters || []) === JSON.stringify(nextCharacters)
    && current.name === name
    && (current.account || "") === nextAccount
    && (current.provider || "") === nextProvider
    && (current.jobLabel || "") === jobLabel
    && current.fingerprint === nextFingerprint
    && JSON.stringify(current.cookies || []) === JSON.stringify(nextCookies || [])
    && JSON.stringify(current.localStorageData || {}) === JSON.stringify(localStorageData)
    && JSON.stringify(current.sessionStorageData || {}) === JSON.stringify(sessionStorageData)) return;
  if (await AccountVault.switchLocked()) return;
  profiles[index] = {
    ...current,
    name,
    account: nextAccount || current.account || null,
    provider: nextProvider,
    jobLabel,
    characters: nextCharacters,
    localStorageData,
    sessionStorageData,
    cookies: nextCookies,
    fingerprint: nextFingerprint,
    accountId: accountId != null ? accountId : current.accountId,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ profiles });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh-live") refreshSavedLogin().catch(() => {});
});

refreshSavedLogin().catch(() => {});

const logViewerPorts = new Map();
let logViewerPreparedUntil = 0;
let logViewerPresence = false;
let logViewerPrepareTimer;

function logViewerShouldKeepGameVisible() {
  return Date.now() < logViewerPreparedUntil || [...logViewerPorts.values()].some(Boolean);
}

async function publishLogViewerPresence(force = false) {
  const enabled = logViewerShouldKeepGameVisible();
  if (!force && enabled === logViewerPresence) return;
  logViewerPresence = enabled;
  const tabs = await chrome.tabs.query({url: AccountVault.SITE + "*"});
  await Promise.all(tabs.filter(tab => tab.id != null).map(tab =>
    chrome.tabs.sendMessage(tab.id, {type: "ro-vault:background-presence", enabled}).catch(() => {})
  ));
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "ro-vault-log-viewer" || port.sender?.id !== chrome.runtime.id) return;
  logViewerPorts.set(port, false);
  port.onMessage.addListener(message => {
    if (message?.type !== "visibility") return;
    logViewerPorts.set(port, message.visible === true);
    publishLogViewerPresence().catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    logViewerPorts.delete(port);
    publishLogViewerPresence().catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "ro-vault:background-presence-status") {
    reply({enabled: logViewerShouldKeepGameVisible()});
    return;
  }
  if (message?.type !== "ro-vault:prepare-log-viewer") return;
  logViewerPreparedUntil = Date.now() + 5000;
  clearTimeout(logViewerPrepareTimer);
  logViewerPrepareTimer = setTimeout(() => publishLogViewerPresence().catch(() => {}), 5100);
  publishLogViewerPresence().then(() => reply({ok: true}), error => reply({ok: false, error: error.message}));
  return true;
});


const activityAlarm = "random-pointer-activity";
const backgroundPresenceEnabled = false;

async function schedulePointerActivity() {
  if (!backgroundPresenceEnabled) {
    await chrome.alarms.clear(activityAlarm);
    return;
  }
  const { pointerActivityEnabled = true } = await chrome.storage.local.get("pointerActivityEnabled");
  if (!pointerActivityEnabled) {
    await chrome.alarms.clear(activityAlarm);
    return;
  }
  await chrome.alarms.create(activityAlarm, { delayInMinutes: 0.5 + Math.random() * 0.5 });
}

async function dispatchPointerActivity() {
  if (!backgroundPresenceEnabled) return;
  const { pointerActivityEnabled = true } = await chrome.storage.local.get("pointerActivityEnabled");
  if (!pointerActivityEnabled) return;
  if (await AccountVault.switchLocked()) return;
  const tabs = await chrome.tabs.query({ url: AccountVault.SITE + "*" });
  await Promise.all(tabs.filter(tab => tab.id != null && tab.status === "complete").map(async tab => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          if (document.querySelector('input[type="password"]')) return;
          const x = 1 + Math.floor(Math.random() * Math.max(1, innerWidth - 2));
          const y = 1 + Math.floor(Math.random() * Math.max(1, innerHeight - 2));
          window.dispatchEvent(new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            pointerId: 1,
            isPrimary: true,
            buttons: 0,
            clientX: x,
            clientY: y,
            screenX: window.screenX + x,
            screenY: window.screenY + y
          }));
        }
      });
    } catch (error) {
      // A closing or navigating tab can be retried at the next interval.
    }
  }));
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== activityAlarm) return;
  dispatchPointerActivity().finally(schedulePointerActivity).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pointerActivityEnabled) schedulePointerActivity().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => schedulePointerActivity().catch(() => {}));
chrome.runtime.onStartup.addListener(() => schedulePointerActivity().catch(() => {}));
chrome.alarms.get(activityAlarm).then(alarm => {
  if (!backgroundPresenceEnabled || !alarm || alarm.scheduledTime - Date.now() > 60000) return schedulePointerActivity();
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "ro-vault:save-logs") return;
  if (!sender.tab || !sender.url?.startsWith(AccountVault.SITE) || !Array.isArray(message.rows) || message.rows.length > 100) return;
  const rows = message.rows.filter(row => row && typeof row.id === "string" && row.id.length < 300 && typeof row.text === "string" && row.text.length <= 2000000 && Number.isFinite(row.receivedAt));
  chrome.storage.local.get({profiles: []}).then(stored => {
    for (const row of rows) {
      const matches = stored.profiles.flatMap(profile => (profile.characters || []).map(character => ({character, profile}))).filter(item =>
        row.characterId ? String(item.character.id) === String(row.characterId) : row.character && item.character.name === row.character);
      if (matches.length === 1) {
        row.characterId = String(matches[0].character.id);
        row.character = matches[0].character.name;
        row.account = matches[0].profile.account || row.account || "";
      }
    }
    return VaultLogs.save(rows);
  }).then(saved => reply({ok: true, saved})).catch(error => reply({ok: false, error: error.message}));
  return true;
});


async function activateBattleLogCapture(tabId) {
  const target = {tabId};
  await chrome.scripting.executeScript({target, files: ["logs-model.js", "logs-capture.js"]});
  await chrome.scripting.executeScript({target, files: ["logs-stream.js"], world: "MAIN"});
}

async function battleLogStatus() {
  const tabs = await chrome.tabs.query({url: AccountVault.SITE + "*"});
  const captures = await Promise.all(tabs.filter(tab => tab.id != null).map(async tab => {
    try {
      let status;
      try {status = await chrome.tabs.sendMessage(tab.id, {type: "ro-vault:capture-status"});} catch {}
      if (status?.recorderVersion !== "1.9.5") await activateBattleLogCapture(tab.id);
      const result = await chrome.tabs.sendMessage(tab.id, {type: "ro-vault:capture-status"});
      return {tabId: tab.id, ...result};
    } catch (error) {return {tabId: tab.id, error: error.message};}
  }));
  return {captures, recorderVersion: "1.9.5"};
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "ro-vault:log-status" || sender.id !== chrome.runtime.id) return;
  battleLogStatus().then(status => reply({ok: true, ...status})).catch(error => reply({ok: false, error: error.message}));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url?.startsWith(AccountVault.SITE)) activateBattleLogCapture(tabId).catch(() => {});
});

chrome.tabs.query({url: AccountVault.SITE + "*"}).then(tabs =>
  Promise.all(tabs.filter(tab => tab.id != null && tab.status === "complete").map(tab => activateBattleLogCapture(tab.id).catch(() => {})))
).catch(() => {});


async function currentGameCharacter(message, sender) {
  const windowId = sender.tab?.windowId ?? message.windowId;
  if (!Number.isInteger(windowId)) return null;
  const tabs = await chrome.tabs.query({windowId, url: AccountVault.SITE + "*"});
  const games = tabs.filter(tab => tab.id != null && !new URL(tab.url).pathname.startsWith("/info"));
  const key = "last-game-tab:" + windowId;
  const remembered = await chrome.storage.session.get(key);
  const tab = games.find(tab => tab.id === remembered[key]) || games.find(tab => tab.active) || games.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (!tab) return null;
  const [injected] = await chrome.scripting.executeScript({
    target: {tabId: tab.id},
    func: () => {
      const caption = document.querySelector(".xp-title .caption")?.textContent || "";
      const match = caption.match(/^RO放置仙境 - \[([^\]]+)\]/);
      return match ? match[1].trim() : null;
    }
  });
  const character = injected?.result;
  if (!character) return null;
  const stored = await chrome.storage.local.get({profiles: []});
  const matches = stored.profiles.flatMap(profile => (profile.characters || []).map(item => ({item, profile}))).filter(match => match.item.name === character);
  if (matches.length === 1) return {key: "id:" + matches[0].item.id, character, tabId: tab.id};
  const catalog = await VaultLogs.characters();
  const known = catalog.filter(item => item.character === character);
  return known.length === 1 ? {key: known[0].key, character, tabId: tab.id} : null;
}

chrome.tabs.onActivated.addListener(async info => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url?.startsWith(AccountVault.SITE) && !new URL(tab.url).pathname.startsWith("/info")) {
      await chrome.storage.session.set({["last-game-tab:" + info.windowId]: info.tabId});
    }
  } catch (error) {}
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "ro-vault:current-character" || sender.id !== chrome.runtime.id) return;
  currentGameCharacter(message, sender).then(character => reply({ok: true, character}))
    .catch(error => reply({ok: false, error: error.message}));
  return true;
});

async function currentMvpStatus(message, sender) {
  const character = await currentGameCharacter(message, sender);
  if (!character || character.key !== message.characterKey || !/^id:[a-z0-9_-]{1,100}$/i.test(character.key)) return null;
  const [injected] = await chrome.scripting.executeScript({
    target: {tabId: character.tabId},
    args: [character.key.slice(3), character.character],
    func: async (id, name) => {
      const caption = document.querySelector(".xp-title .caption")?.textContent || "";
      if (caption.match(/^RO放置仙境 - \[([^\]]+)\]/)?.[1].trim() !== name) return null;
      const response = await fetch("/api/characters/" + encodeURIComponent(id) + "?deferCatchup=1", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok) return null;
      const {snapshot} = await response.json();
      if (!snapshot || typeof snapshot.mapId !== "string") return null;
      const config = snapshot.config ?? {};
      return {
        mapId: snapshot.mapId,
        target: snapshot.target ? {name: snapshot.target.name, id: snapshot.target.monsterId} : null,
        whitelist: Array.isArray(config.targets?.whitelist) ? config.targets.whitelist : [],
        priority: (Array.isArray(config.monsterRules) ? config.monsterRules : [])
          .filter(rule => rule.action === "priority" && rule.escape !== "sight").map(rule => rule.monsterId),
        lastKills: (Array.isArray(snapshot.mvpLastKill) ? snapshot.mvpLastKill : [])
          .filter(record => !record.noMvp)
          .map(record => ({name: record.name, by: record.by, at: record.at})),
      };
    },
  });
  return injected?.result ?? null;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "ro-vault:mvp-status" || sender.id !== chrome.runtime.id) return;
  currentMvpStatus(message, sender).then(state => reply({ok: true, state}))
    .catch(() => reply({ok: false}));
  return true;
});
