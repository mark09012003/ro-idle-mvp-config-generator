const { AccountVault } = globalThis;
const preview = new URLSearchParams(location.search).has("preview");

const listEl = document.querySelector("#list");
const listCountEl = document.querySelector("#list-count");
const toastEl = document.querySelector("#toast");


const state = {
  profiles: [],
  teams: [],
  viewTeam: "",
  current: null,
  toast: "",
  confirm: null,
  menuId: null,
  query: "",
  pendingTeam: "",
  awaitingTeam: false,
  scrollToActive: false,
  renamingTeam: false,
};

let awaitTimer = null;

function watchAwaitingAccount() {
  if (awaitTimer || !state.awaitingTeam) return;
  const started = Date.now();
  awaitTimer = setInterval(() => {
    if (!state.awaitingTeam || Date.now() - started > 10 * 60 * 1000) {
      clearInterval(awaitTimer);
      awaitTimer = null;
      return;
    }
    refresh().catch(() => {});
  }, 1500);
}

function guard(work) {
  return () => {
    Promise.resolve(work()).catch((error) => setToast(error.message || String(error)));
  };
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(key, value);
  });
  (children || []).forEach((child) => {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function setToast(message) {
  state.toast = message;
  toastEl.textContent = message;
  toastEl.classList.remove("show");
  if (!message) return;
  void toastEl.offsetWidth;
  toastEl.classList.add("show");
}

async function readPageSnapshot() {
  const localStorageData = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key) continue;
    localStorageData[key] = localStorage.getItem(key);
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
  let me = null;
  let characters = null;
  let status = 0;
  try {
    const meResponse = await fetch("/api/auth/me", { credentials: "same-origin" });
    status = meResponse.status;
    if (meResponse.ok) me = await meResponse.json();
  } catch (error) {
    return { localStorageData, status, error: String(error && error.message ? error.message : error) };
  }
  try {
    const characterResponse = await fetch("/api/characters", { credentials: "same-origin" });
    if (characterResponse.ok) characters = await characterResponse.json();
  } catch (error) {
    return { localStorageData, me, status, error: String(error && error.message ? error.message : error) };
  }
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
}

function writePageStorage() { throw new Error("已停用登入狀態還原"); }
async function enterSavedCharacter() { return {ok:false}; }
async function openCharacterSelect() { return {select:false}; }


function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const finish = (ok) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), 20000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

const memory = {
  profiles: [],
  teams: [],
  viewTeam: "",
  pendingTeam: "",
  awaitingTeam: false,
  scene: "alpha",
};

const previewScenes = {
  alpha: {
    loggedIn: true,
    account: null,
    accountId: 11554,
    characters: [
      { id: 1, name: "睡不飽實", baseLv: 60, jobLv: 50, job: "lord_knight", jobLabel: "lord_knight", running: true },
    ],
    cookies: [{ name: "session", value: "alpha-session", domain: "ro-idle.app", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "lax" }],
    localStorageData: { "ro-idle:display": "{\"fontSize\":14}" },
    activeCharacterName: "睡不飽實",
  },
  beta: {
    loggedIn: true,
    account: null,
    accountId: 11555,
    characters: [{ id: 3, name: "鐵匠波伊", baseLv: 61, job: "blacksmith", jobLabel: "鐵匠", running: false }],
    cookies: [{ name: "session", value: "beta-session", domain: "ro-idle.app", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "lax" }],
    localStorageData: { "ro-idle:display": "{\"fontSize\":16}" },
  },
  signedOut: {
    loggedIn: false,
    account: null,
    accountId: null,
    characters: [],
    cookies: [{ name: "ro_lb2", value: "lb", domain: "ro-idle.app", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "no_restriction" }],
    localStorageData: {},
  },
};

async function snapshotFromScene(scene) {
  const fingerprint = await AccountVault.fingerprintCookies(scene.cookies);
  return {
    loggedIn: scene.loggedIn,
    account: scene.account,
    accountId: scene.accountId,
    characters: scene.characters,
    cookies: scene.cookies,
    localStorageData: scene.localStorageData,
    cookieCount: scene.cookies.length,
    storageCount: Object.keys(scene.localStorageData).length,
    fingerprint,
    tabCount: 1,
    activeCharacterName: scene.activeCharacterName || "",
    error: scene.loggedIn ? "" : "這個分頁目前沒有登入。",
  };
}

const chromeApi = {
  async loadVault() {
    const stored = await chrome.storage.local.get({ profiles: [], teams: [], viewTeam: "", pendingTeam: "", awaitingTeam: false });
    return { profiles: stored.profiles.map(AccountVault.googleAccountOnly), teams: stored.teams, viewTeam: stored.viewTeam, pendingTeam: stored.pendingTeam, awaitingTeam: stored.awaitingTeam };
  },
  async saveVault(vault) {
    await chrome.storage.local.set({
      profiles: vault.profiles.map(AccountVault.googleAccountOnly),
      teams: vault.teams,
      viewTeam: vault.viewTeam,
      pendingTeam: vault.pendingTeam || "",
      awaitingTeam: Boolean(vault.awaitingTeam),
    });
  },
  async readCurrent(targetTab, storeId) {
    const tabs = await chrome.tabs.query({ url: `${AccountVault.SITE}*` });
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = targetTab || activeTabs.find((item) => item.url && item.url.startsWith(AccountVault.SITE)) || tabs[0];
    const cookies = AccountVault.durableCookies((await AccountVault.listSiteCookies()).filter(cookie => storeId == null || cookie.storeId === storeId));
    if (!tab || tab.id == null) {
      return {
        loggedIn: false,
        account: null,
        accountId: null,
        characters: [],
        cookies,
        localStorageData: {},
        cookieCount: cookies.length,
        storageCount: 0,
        fingerprint: await AccountVault.fingerprintCookies(cookies),
        tabCount: tabs.length,
        error: "請先打開 ro-idle.app。",
      };
    }
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageSnapshot });
    const snapshot = injected && injected.result ? injected.result : {};
    const loggedIn = snapshot.status === 200;
    const provider = AccountVault.pickProvider(snapshot.me) || (typeof snapshot.providerHint === "string" ? snapshot.providerHint : "");
    const accountId = AccountVault.pickAccountId(snapshot.me) ?? AccountVault.parseAccountId(snapshot.accountIdHint);
    const loginName = typeof snapshot.loginName === "string" ? snapshot.loginName.trim().slice(0, 64) : "";
    return {
      loggedIn,
      account: AccountVault.pickAccount(snapshot.me) || loginName || (provider === "google" ? "Google 帳號" : null),
      accountId,
      loginName,
      provider,
      characters: AccountVault.pickCharacters(AccountVault.combineCharacters(snapshot.characters, snapshot.altCharacters)),
      charactersKnown: snapshot.charactersKnown === true,
      cookies,
      localStorageData: snapshot.localStorageData || {},
      sessionStorageData: snapshot.sessionStorageData || {},
      cookieCount: cookies.length,
      storageCount: Object.keys(snapshot.localStorageData || {}).length,
      fingerprint: await AccountVault.fingerprintCookies(cookies),
      tabCount: tabs.length,
      activeCharacterName: typeof snapshot.activeCharacterName === "string" ? snapshot.activeCharacterName.trim().slice(0, 24) : "",
      error: snapshot.error || (loggedIn ? "" : "這個分頁目前沒有登入。"),
    };
  },
  async applyProfile(profile) { await fillCredentials(profile); return {}; },
  async openFreshLogin() { await chrome.tabs.create({url:AccountVault.SITE,active:true}); },
};

async function buildPreviewProfiles() {
  const alphaPrint = await AccountVault.fingerprintCookies(previewScenes.alpha.cookies);
  const cast = [
    ["睡不飽實", "lord_knight", "lord_knight"],
    ["吃不飽實", "rogue", "流氓"],
    ["賺不飽實", "rogue", "流氓"],
    ["喝不飽實", "rogue", "流氓"],
    ["ㄚㄚㄚㄚㄚ武僧", "acolyte", "服事"],
  ];
  const squads = ["主隊", "練功隊", "倉庫隊"];
  return Array.from({ length: 24 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const [name, job, jobLabel] = cast[index % cast.length];
    const accountId = index === 0 ? 11554 : index === 1 ? 11555 : 12000 + index;
    return {
      id: `preview-${number}`,
      name: `Lizzard${number}`,
      account: `Lizzard${number}`,
      accountId,
      characters: index === 4 ? [] : index === 2 ? [
        { id: 201, name, baseLv: 42, jobLv: 18, job, jobLabel, running: true },
        { id: 202, name: "賺不飽貳", baseLv: 30, jobLv: 24, job: "thief", jobLabel: "盜賊", running: true },
        { id: 203, name: "賺不飽參", baseLv: 12, jobLv: 8, job: "novice", jobLabel: "初學者", running: false },
        { id: 204, name: "賺不飽肆", baseLv: 55, jobLv: 40, job: "assassin", jobLabel: "刺客", running: false },
        { id: 205, name: "賺不飽伍", baseLv: 7, jobLv: 3, job: "novice", jobLabel: "初學者", running: false },
      ] : [{ id: index + 1, name, baseLv: 40 + (index % 21), jobLv: 10 + (index % 40), job, jobLabel, running: index % 5 === 0 }],
      cookies: index === 0
        ? previewScenes.alpha.cookies
        : [{ name: "session", value: `session-${number}`, domain: "ro-idle.app", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "lax" }],
      localStorageData: {},
      fingerprint: index === 0 ? alphaPrint : `fp-${number}`,
      team: squads[Math.floor(index / 8)],
      jobLabel: jobLabel,
      pinned: index === 2 || index === 11,
      createdAt: Date.now() - index * 1000,
      updatedAt: Date.now() - index * 1000,
    };
  });
}

const previewApi = {
  async loadVault() {
    if (!memory.profiles.length) {
      memory.profiles = await buildPreviewProfiles();
      memory.teams = ["主隊", "練功隊", "倉庫隊"];
      memory.viewTeam = "主隊";
    }
    return { profiles: memory.profiles, teams: memory.teams, viewTeam: memory.viewTeam, pendingTeam: memory.pendingTeam || "", awaitingTeam: Boolean(memory.awaitingTeam) };
  },
  async saveVault(vault) {
    memory.profiles = vault.profiles;
    memory.teams = vault.teams;
    memory.viewTeam = vault.viewTeam;
    memory.pendingTeam = vault.pendingTeam || "";
    memory.awaitingTeam = Boolean(vault.awaitingTeam);
  },
  async readCurrent() {
    return snapshotFromScene(previewScenes[memory.scene]);
  },
  async applyProfile(profile, chosenCharacter) {
    const match = Object.entries(previewScenes).find(([, scene]) => scene.accountId != null && scene.accountId === profile.accountId);
    if (match) {
      memory.scene = match[0];
      previewScenes[match[0]].activeCharacterName = chosenCharacter ? (chosenCharacter.name || "") : "";
    } else {
      memory.scene = "custom";
      previewScenes.custom = {
        loggedIn: true,
        account: profile.account,
        accountId: profile.accountId,
        characters: profile.characters,
        cookies: profile.cookies,
        localStorageData: profile.localStorageData || {},
        activeCharacterName: chosenCharacter ? (chosenCharacter.name || "") : "",
      };
    }
    if (chosenCharacter) return { tabCount: 1, entered: chosenCharacter.name || "", select: false };
    return { tabCount: 1, entered: "", select: true };
  },
  async openFreshLogin() {
    memory.scene = "signedOut";
  },
};

const api = preview ? previewApi : chromeApi;

function activeProfile() {
  if (!state.current) return null;
  return AccountVault.findLoginProfile(state.profiles, state.current);
}

function characterJobLabel(character) {
  const key = character && typeof character.job === "string" ? character.job.trim() : "";
  const named = key ? AccountVault.jobName(key) : "";
  if (named) return named;
  const stored = cleanLabel(character && character.jobLabel, 16);
  const storedNamed = stored ? AccountVault.jobName(stored) : "";
  if (storedNamed) return storedNamed;
  if (stored && stored !== key) return stored;
  return stored;
}

function labelFromCharacters(characters) {
  const list = Array.isArray(characters) ? characters : [];
  const chosen = list.find((character) => character && character.running) || list[0];
  if (!chosen) return { name: "", jobLabel: "" };
  return {
    name: cleanLabel(chosen.name, 24),
    jobLabel: cleanLabel(characterJobLabel(chosen), 16),
  };
}

function shownAccount(profile) {
  const account = cleanLabel(profile && profile.account, 24);
  if (account && !account.startsWith("編號")) return account;
  const name = cleanLabel(profile && profile.name, 24);
  const characterNames = (profile && profile.characters || []).map((character) => cleanLabel(character && character.name, 24));
  if (name && name !== "未命名帳號" && name !== "帳號未記錄" && !name.startsWith("編號") && !characterNames.includes(name)) return name;
  return "";
}

function shownLabel(profile) {
  return cleanLabel(profile && profile.label, 24);
}

function mentionName(profile) {
  return shownLabel(profile) || cleanLabel(profile && profile.account, 24) || "這個帳號";
}

function playingCharacterName() {
  return cleanLabel(state.current && state.current.activeCharacterName, 24);
}

function shownJob(profile) {
  return labelFromCharacters(profile.characters).jobLabel || cleanLabel(characterJobLabel({ job: "", jobLabel: profile && profile.jobLabel }), 16);
}

function characterCaption(character) {
  const name = (character && character.name) || "未命名";
  const job = characterJobLabel(character);
  const level = character && character.baseLv != null ? `Lv.${character.baseLv}` : "";
  const jobLevel = character && character.jobLv != null ? `Job ${character.jobLv}` : "";
  const stats = [job, level].filter(Boolean).join(" ");
  const tail = [stats, jobLevel].filter(Boolean).join(" / ");
  return tail ? `[${name}] ${tail}` : `[${name}]`;
}

function shownDetail(profile) {
  if (AccountVault.isGoogleAccount(profile)) return "Google · 手動登入";
  const list = Array.isArray(profile.characters) ? profile.characters : [];
  const running = list.filter((character) => character && character.running).length;
  return `${list.length} 隻角色 · ${running} 隻掛機中`;
}

function cleanLabel(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function orderedTeams() {
  const names = [];
  state.teams.forEach((team) => {
    const name = cleanLabel(team, 16);
    if (name && !names.includes(name)) names.push(name);
  });
  state.profiles.forEach((profile) => {
    const name = cleanLabel(profile.team, 16);
    if (name && !names.includes(name)) names.push(name);
  });
  return names;
}

function profileHaystack(profile) {
  const characters = (profile.characters || [])
    .map((character) => `${character.name || ""} ${character.jobLabel || ""} ${character.job || ""}`)
    .join(" ");
  return `${shownLabel(profile)} ${shownJob(profile)} ${profile.team || ""} ${profile.account || ""} ${profile.accountId ?? ""} ${characters}`.toLowerCase();
}

function compareProfiles(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  const left = shownLabel(a) || String(a.account || "");
  const right = shownLabel(b) || String(b.account || "");
  return left.localeCompare(right, "zh-Hant", { numeric: true, sensitivity: "base" });
}

function visibleProfiles() {
  const query = state.query.trim().toLowerCase();
  return state.profiles
    .filter((profile) => !state.viewTeam || profile.team === state.viewTeam)
    .filter((profile) => !query || profileHaystack(profile).includes(query))
    .sort(compareProfiles);
}

let teamTabKey = "";

function renderTeamTabs() {
  const teams = orderedTeams();
  if (state.viewTeam && !teams.includes(state.viewTeam)) state.viewTeam = "";
  const key = `${state.viewTeam}\n${teams.join("\n")}`;
  const bar = document.querySelector("#team-tabs");
  if (key === teamTabKey && bar.childElementCount) return;
  teamTabKey = key;
  const allTab = el("button", {
    class: state.viewTeam ? "tab" : "tab on",
    type: "button",
    role: "tab",
    onClick: () => selectTeam(""),
  }, ["全部"]);
  const tabs = [allTab];
  teams.forEach((team) => {
    const on = state.viewTeam === team;
    const button = el("button", {
      class: on ? "tab on" : "tab",
      type: "button",
      role: "tab",
      title: "拖動可調整順序",
      onClick: () => {
        if (suppressTeamClick) {
          suppressTeamClick = false;
          return;
        }
        selectTeam(team);
      },
    }, [team]);
    if (!on) {
      bindTeamDrag(button);
      tabs.push(button);
      return;
    }
    const wrap = el("div", { class: "tab-wrap" }, [
      button,
      el("span", { class: "tab-tools" }, [
        el("button", {
          class: "tab-rename",
          type: "button",
          title: "改名",
          draggable: "false",
          onDragStart: (event) => event.preventDefault(),
          onClick: () => openTeamRename(),
        }, ["改"]),
        el("button", {
          class: "tab-x",
          type: "button",
          title: "移除這隊",
          draggable: "false",
          onDragStart: (event) => event.preventDefault(),
          onClick: () => askRemoveTeam(team),
        }, ["×"]),
      ]),
    ]);
    bindTeamDrag(wrap, team);
    tabs.push(wrap);
  });
  const addTab = el("button", {
    class: "tab add",
    type: "button",
    title: "建立隊伍",
    onClick: () => {
      const form = document.querySelector("#team-form");
      form.hidden = false;
      document.querySelector("#team-name").focus();
    },
  }, ["＋"]);
  tabs.push(addTab);
  bar.replaceChildren(...tabs);
  bindTeamEdge(allTab, "after");
  bindTeamEdge(addTab, "before");
  renderTeamConfirm();
  renderTeamRename();
}

let teamDragName = "";
let teamDragMoved = false;
let suppressTeamClick = false;

function teamTabNodes() {
  return [...document.querySelectorAll("#team-tabs [data-team]")];
}

function bindTeamDrag(node, team) {
  const name = team || node.textContent.trim();
  node.dataset.team = name;
  node.draggable = true;
  node.addEventListener("dragstart", onTeamDragStart);
  node.addEventListener("dragover", onTeamDragOver);
  node.addEventListener("drop", onTeamDrop);
  node.addEventListener("dragend", onTeamDragEnd);
}

function bindTeamEdge(node, place) {
  node.addEventListener("dragover", (event) => {
    if (!teamDragName) return;
    event.preventDefault();
    const dragged = teamTabNodes().find((item) => item.dataset.team === teamDragName);
    if (!dragged) return;
    if (place === "after" && node.nextSibling !== dragged) {
      node.after(dragged);
      teamDragMoved = true;
    }
    if (place === "before" && dragged.nextSibling !== node) {
      node.before(dragged);
      teamDragMoved = true;
    }
  });
  node.addEventListener("drop", onTeamDrop);
}

function onTeamDragStart(event) {
  const team = event.currentTarget.dataset.team;
  if (!team) {
    event.preventDefault();
    return;
  }
  teamDragName = team;
  teamDragMoved = false;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", team);
  event.currentTarget.classList.add("dragging");
}

function onTeamDragOver(event) {
  if (!teamDragName) return;
  event.preventDefault();
  const target = event.currentTarget;
  const dragged = teamTabNodes().find((item) => item.dataset.team === teamDragName);
  if (!dragged || dragged === target) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientX < rect.left + rect.width / 2;
  const reference = before ? target : target.nextSibling;
  if (reference === dragged) return;
  target.parentElement.insertBefore(dragged, reference);
  teamDragMoved = true;
}

function onTeamDrop(event) {
  event.preventDefault();
}

function onTeamDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  const moved = teamDragMoved;
  teamDragName = "";
  teamDragMoved = false;
  if (!moved) return;
  suppressTeamClick = true;
  const names = teamTabNodes().map((item) => item.dataset.team);
  persist({ teams: names }).catch((error) => setToast(error.message || String(error)));
}

function renderTeamConfirm() {
  const box = document.querySelector("#team-confirm");
  const removing = state.confirm && state.confirm.type === "remove-team" ? state.confirm.team : "";
  box.replaceChildren();
  if (!removing) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const count = state.profiles.filter((profile) => profile.team === removing).length;
  box.append(el("p", null, [count
    ? `移除「${removing}」？這 ${count} 個帳號會留在清單，改到「全部」。`
    : `移除「${removing}」？這隊目前沒有帳號。`]));
  box.append(el("div", { class: "card-actions" }, [
    el("button", { class: "btn tiny danger", type: "button", onClick: guard(() => removeTeam(removing)) }, ["移除隊伍"]),
    el("button", { class: "btn tiny", type: "button", onClick: () => { state.confirm = null; renderTeamConfirm(); } }, ["取消"]),
  ]));
}

function openTeamRename() {
  if (!state.viewTeam) return;
  state.renamingTeam = true;
  document.querySelector("#team-form").hidden = true;
  renderTeamRename();
  const input = document.querySelector("#team-rename-name");
  input.focus();
  input.select();
}

function renderTeamRename() {
  const form = document.querySelector("#team-rename");
  const input = document.querySelector("#team-rename-name");
  if (!form || !input) return;
  if (!state.viewTeam || !state.renamingTeam) {
    form.hidden = true;
    return;
  }
  form.hidden = false;
  if (document.activeElement !== input) input.value = state.viewTeam;
}

async function renameTeam(name) {
  const from = state.viewTeam;
  const next = cleanLabel(name, 16);
  if (!from) return;
  if (!next) {
    setToast("請輸入隊伍名稱。");
    return;
  }
  if (next === from) return;
  if (orderedTeams().includes(next)) {
    setToast(`「${next}」已經有了。`);
    return;
  }
  const teams = orderedTeams().map((team) => (team === from ? next : team));
  const profiles = state.profiles.map((profile) => (profile.team === from ? { ...profile, team: next } : profile));
  state.renamingTeam = false;
  await persist({
    teams,
    profiles,
    viewTeam: next,
  }, `已把隊伍改成「${next}」。`);
}

function selectTeam(team) {
  if (team === state.viewTeam && !(state.confirm && state.confirm.type === "remove-team")) return;
  state.renamingTeam = false;
  state.confirm = state.confirm && state.confirm.type === "remove-team" ? null : state.confirm;
  persist({ viewTeam: team }).catch((error) => setToast(error.message || String(error)));
}

function askRemoveTeam(team) {
  state.confirm = { type: "remove-team", team };
  renderTeamConfirm();
}

async function removeTeam(team) {
  const teams = orderedTeams().filter((name) => name !== team);
  const profiles = state.profiles.map((profile) => (profile.team === team ? { ...profile, team: "" } : profile));
  state.confirm = null;
  await persist({
    teams,
    profiles,
    viewTeam: state.viewTeam === team ? "" : state.viewTeam,
  }, `已移除「${team}」。帳號改到「全部」。`);
}

function characterViewKey(profile) {
  const playing = activeProfile() && activeProfile().id === profile.id ? playingCharacterName() : "";
  return (profile.characters || []).map((character) => {
    const inUse = Boolean(playing) && cleanLabel(character && character.name, 24) === playing;
    return `${characterCaption(character)}\n${character && character.running ? 1 : 0}\n${inUse ? 1 : 0}`;
  }).join("\n");
}

function renderProfileRow(profile) {
  const row = el("article", { class: "row" });
  row.dataset.profileId = profile.id;
  row.dataset.chars = characterViewKey(profile);
  const head = el("header", { class: "row-head" });
  const title = el("span", { class: "row-name" }, [el("span", { class: "row-title" }, [shownLabel(profile)])]);
  head.append(el("button", {
    class: profile.pinned ? "icon-btn on" : "icon-btn",
    type: "button",
    title: profile.pinned ? "取消釘選" : "釘選到最上面",
    "data-pin": "1",
    onClick: guard(() => togglePin(profile)),
  }, [profile.pinned ? "★" : "☆"]));
  head.append(el("div", { class: "row-main" }, [title]));
  head.append(el("span", { class: "row-count" }, [shownDetail(profile)]));
  const actions = el("div", { class: "row-actions" });
  if (!AccountVault.isGoogleAccount(profile)) actions.append(el("button", {
    class: "btn tiny switch",
    type: "button",
    title: "清除遊戲 Cookie，回到登入頁並填入已保存帳密",
    onClick: () => requestSwitch(profile),
  }, ["切換"]));
actions.append(el("button", {
    class: "icon-btn",
    type: "button",
    title: "更多",
    onClick: () => toggleMenu(profile),
  }, ["⋯"]));
  head.append(actions);
  row.append(head);
  if ((profile.characters || []).length) row.append(renderCharacterList(profile));
  if (state.menuId === profile.id || (state.confirm && state.confirm.id === profile.id)) {
    const menu = el("div", { class: "row-menu" });
    if (state.confirm && state.confirm.id === profile.id) menu.append(renderConfirm(profile));
    else {
      const labelInput = el("input", {
        type: "text",
        maxlength: "24",
        value: profile.label || "",
        placeholder: "可留空",
      });
      const teamSelect = el("select", {}, [
        el("option", { value: "" }, ["未分隊"]),
        ...orderedTeams().map((team) => el("option", { value: team }, [team])),
      ]);
      teamSelect.value = profile.team || "";
      menu.append(el("div", { class: "menu-fields" }, [
        el("label", { class: "field" }, ["顯示名稱", labelInput]),
        el("label", { class: "field" }, ["隊伍", teamSelect]),
      ]));
      if (AccountVault.isGoogleAccount(profile)) {
        const identifier = el("input", {type: "text", value: profile.account || "", maxlength: "64", autocomplete: "off"});
        const key = "credentials:" + profile.id;
        menu.append(el("div", {class: "menu-fields"}, [
          el("label", {class: "field"}, ["Google 帳號或備註名稱", identifier]),
        ]));
        menu.append(el("div", {class: "card-actions"}, [
          el("button", {class: "btn tiny primary", type: "button", onClick: guard(() => saveProfileEdits(profile, {
            label: labelInput.value, team: teamSelect.value, account: identifier.value, key,
          }))}, ["保存"]),
        ]));
      } else {
      const draft = credentialDrafts[profile.id];
      const loginAccount = el("input", {type:"text", value:draft ? draft.account : (profile.account || ""), autocomplete:"off"});
      const loginPassword = el("input", {type:"password", placeholder:"輸入或修改密碼", autocomplete:"new-password", value:draft ? draft.password : ""});
      const keepDraft = () => {
        credentialDrafts[profile.id] = { account: loginAccount.value, password: loginPassword.value };
      };
      loginAccount.addEventListener("input", keepDraft);
      loginPassword.addEventListener("input", keepDraft);
      const credentialFields = el("div", {class:"menu-fields"}, [
        el("label", {class:"field"}, ["登入帳號", loginAccount]),
        el("label", {class:"field"}, ["登入密碼", loginPassword]),
      ]);
      menu.append(credentialFields);
      const key="credentials:"+profile.id;
      if (!draft && globalThis.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(key).then(stored=>{
          if(!credentialFields.isConnected || !stored[key])return;
          if(document.activeElement!==loginAccount && loginAccount.value===(profile.account || "")) loginAccount.value=stored[key].account || "";
          if(document.activeElement!==loginPassword && !loginPassword.value) loginPassword.value=stored[key].password || "";
          keepDraft();
        }).catch(error=>setToast(error.message));
      }
      menu.append(el("div", {class:"card-actions"}, [
        el("button", {class:"btn tiny primary", type:"button", onClick:guard(() => saveProfileEdits(profile, {
          label: labelInput.value,
          team: teamSelect.value,
          account: loginAccount.value,
          password: loginPassword.value,
          key,
        }))}, ["保存"]),
      ]));
      }
      menu.append(el("div", { class: "card-actions" }, [
        el("button", { class: "btn tiny danger", type: "button", onClick: () => askDelete(profile) }, ["刪除"]),
      ]));
    }
    row.append(menu);
  }
  return row;
}

function renderCharacterList(profile) {
  const playing = activeProfile() && activeProfile().id === profile.id ? playingCharacterName() : "";
  const list = el("div", { class: "char-list" });
  (profile.characters || []).forEach((character) => {
    const inUse = Boolean(playing) && cleanLabel(character && character.name, 24) === playing;
    const row = el("div", { class: inUse ? "char-row in-use" : "char-row" });
    const enter = el("button", {
      class: "char-enter",
      type: "button",
      title: "請在遊戲中自行選角",
      onClick: () => requestEnter(profile, character),
    }, character.running ? [
      el("span", { class: "idle-dot", title: "掛機中" }),
    ] : []);
    const name = el("span", { class: "char-name" }, [
      el("span", { class: "char-caption" }, [characterCaption(character)]),
    ]);
    if (inUse) name.append(el("span", { class: "badge using" }, ["使用中"]));
    enter.append(name);
    row.append(enter);
    if (character.name) {
      row.append(el("button", {
        class: "btn tiny copy",
        type: "button",
        title: "複製角色名稱",
        onClick: guard(() => copyText(character.name)),
      }, ["複製"]));
    }
    list.append(row);
  });
  return list;
}

const newAccountDraft = {account:"", password:"", google:false};
const credentialDrafts = {};
function renderAddAccount(team) {
  if(!(state.confirm && state.confirm.type === "new-account" && state.confirm.team === team)) {
    return el("button", {class:"btn add-team",type:"button",onClick:()=>requestFreshLogin(team)}, ["加入新帳號"]);
  }
  const form=el("form", {class:"row-menu new-account-form"});
  const account=el("input", {type:"text",required:"",autocomplete:"username",value:newAccountDraft.account,
    onInput:event=>{newAccountDraft.account=event.target.value;}});
  const password=el("input", {type:"password",required:"",autocomplete:"new-password",value:newAccountDraft.password,
    onInput:event=>{newAccountDraft.password=event.target.value;}});
  const google = el("input", {type: "checkbox"});
  google.checked = newAccountDraft.google;
  const accountText = document.createTextNode("登入帳號");
  const passwordField = el("label", {class: "field"}, ["登入密碼", password]);
  const note = el("p", {class: "new-account-note"});
  const submit = el("button", {class: "btn tiny primary", type: "submit"});
  function updateMode() {
    newAccountDraft.google = google.checked;
    accountText.data = google.checked ? "Google 帳號或備註名稱" : "登入帳號";
    passwordField.hidden = google.checked;
    password.disabled = google.checked;
    password.required = !google.checked;
    if (google.checked) {password.value = "";newAccountDraft.password = "";}
    note.textContent = google.checked ? "只保存帳號資訊，請在遊戲內手動使用 Google 登入。" : "帳密保存於本機（未加密）。填入後會點擊登入，請自行選角。";
    submit.textContent = google.checked ? "記住 Google 帳號" : "保存並填入登入頁";
  }
  google.addEventListener("change", updateMode);
  form.append(el("label", {class: "google-account-toggle"}, [google, "Google 登入（只記住帳號）"]));
  form.append(el("div", {class: "menu-fields"}, [
    el("label", {class: "field"}, [accountText, account]), passwordField,
  ]), note);
  updateMode();
  form.append(el("div", {class:"card-actions"}, [submit,
    el("button", {class:"btn tiny",type:"button",onClick:()=>{newAccountDraft.account="";newAccountDraft.password="";newAccountDraft.google=false;state.confirm=null;renderList();}}, ["取消"]),
  ]));
  form.addEventListener("submit",event=>{
    event.preventDefault();if(submit.disabled)return;submit.disabled=true;
    (google.checked ? rememberGoogleAccount(team,account.value) : addAccountAndFill(team,account.value,password.value)).catch(error=>setToast(error.message||String(error))).finally(()=>{submit.disabled=false;});
  });
  return form;
}

async function rememberGoogleAccount(team, identifier, current = null) {
  const account = cleanLabel(identifier, 64);
  if (!account) throw new Error("請填 Google 帳號或可辨識的備註名稱。");
  const existing = AccountVault.findLoginProfile(state.profiles, {
    provider: "google", account, accountId: current?.accountId,
  });
  const now = Date.now();
  const profile = AccountVault.googleAccountOnly({
    ...existing, id: existing?.id ?? crypto.randomUUID(), name: account, account,
    provider: "google", accountId: current?.accountId ?? existing?.accountId,
    team: existing?.team ?? team, createdAt: existing?.createdAt ?? now, updatedAt: now,
  });
  state.confirm = null;
  newAccountDraft.account = "";newAccountDraft.password = "";newAccountDraft.google = false;
  await persist({profiles: existing ? state.profiles.map(item => item.id === existing.id ? profile : item)
    : [profile, ...state.profiles]}, "已記住 Google 帳號。登入請在遊戲內手動操作。");
}

async function addAccountAndFill(team,account,password) {
  account=account.trim();
  if(!account||!password)throw new Error("請填寫帳號與密碼。");
  const existing=state.profiles.find(item=>item.account===account && !AccountVault.isGoogleAccount(item));
  const now=Date.now();
  const profile=existing || {id:crypto.randomUUID(),name:account,account,team,characters:[],cookies:[],localStorageData:{},sessionStorageData:{},fingerprint:"",provider:"",label:"",jobLabel:"",pinned:false,createdAt:now,updatedAt:now};
  await chrome.storage.local.set({["credentials:"+profile.id]:{account,password}});
  state.confirm=null;newAccountDraft.account="";newAccountDraft.password="";
  await persist({profiles:existing?state.profiles:[profile,...state.profiles],pendingTeam:"",awaitingTeam:false,viewTeam:team});
  await fillCredentials(profile);
}

function renderTeamBlock(team, profiles) {
  const block = el("section", { class: "team-block" });
  if (!state.viewTeam) block.append(el("h3", { class: "team-label" }, [team]));
  if (!profiles.length) {
    block.append(el("p", { class: "empty" }, [
      state.query.trim() ? `沒有符合「${state.query.trim()}」的帳號。` : "這一隊還沒有帳號。",
    ]));
  } else {
    profiles.forEach((profile) => block.append(renderProfileRow(profile)));
  }
  block.append(renderAddAccount(team));
  return block;
}

let listStructure = "";

function listStructureKey() {
  const shown = visibleProfiles();
  const teams = state.viewTeam ? [state.viewTeam] : orderedTeams();
  const blocks = [];
  teams.forEach((team) => {
    const ids = shown.filter((profile) => profile.team === team).map((profile) => profile.id);
    if (!state.viewTeam && state.query.trim() && !ids.length) return;
    blocks.push(`${team}:${ids.join(",")}`);
  });
  const loose = state.viewTeam ? [] : shown.filter((profile) => !cleanLabel(profile.team, 16)).map((profile) => profile.id);
  const confirm = state.confirm ? `${state.confirm.type}:${state.confirm.id || ""}:${state.confirm.team || ""}` : "";
  return JSON.stringify({ blocks, loose, menu: state.menuId || "", confirm, view: state.viewTeam, query: state.query });
}

function expectedIds() {
  const shown = visibleProfiles();
  const teams = state.viewTeam ? [state.viewTeam] : orderedTeams();
  const ids = [];
  teams.forEach((team) => {
    const teamIds = shown.filter((profile) => profile.team === team).map((profile) => profile.id);
    if (!state.viewTeam && state.query.trim() && !teamIds.length) return;
    ids.push(...teamIds);
  });
  if (!state.viewTeam) ids.push(...shown.filter((profile) => !cleanLabel(profile.team, 16)).map((profile) => profile.id));
  return ids;
}

function patchProfileRow(row, profile) {
  const title = row.querySelector(".row-title");
  const titleText = shownLabel(profile);
  if (title && title.textContent !== titleText) title.textContent = titleText;
  const count = row.querySelector(".row-count");
  const detail = shownDetail(profile);
  if (count && count.textContent !== detail) count.textContent = detail;
  const pin = row.querySelector("[data-pin]");
  if (pin) {
    const mark = profile.pinned ? "★" : "☆";
    if (pin.textContent !== mark) {
      pin.textContent = mark;
      pin.classList.toggle("on", Boolean(profile.pinned));
      pin.title = profile.pinned ? "取消釘選" : "釘選到最上面";
    }
  }
  const key = characterViewKey(profile);
  if (row.dataset.chars === key) return;
  row.dataset.chars = key;
  const existing = row.querySelector(".char-list");
  const next = (profile.characters || []).length ? renderCharacterList(profile) : null;
  if (existing && next) existing.replaceWith(next);
  else if (existing) existing.remove();
  else if (next) {
    const menu = row.querySelector(".row-menu");
    if (menu) menu.before(next);
    else row.append(next);
  }
}

function renderList() {
  const scrollTop = listEl.scrollTop;
  const structure = listStructureKey();
  const ids = expectedIds();
  const currentIds = [...listEl.querySelectorAll("[data-profile-id]")].map((node) => node.dataset.profileId);
  const sameShape = structure === listStructure && ids.length === currentIds.length && ids.every((id, index) => id === currentIds[index]);
  const shown = visibleProfiles();
  const teams = state.viewTeam ? [state.viewTeam] : orderedTeams();
  const pool = state.viewTeam
    ? state.profiles.filter((profile) => profile.team === state.viewTeam).length
    : state.profiles.length;
  listCountEl.textContent = !pool && !state.viewTeam
    ? ""
    : (shown.length === pool && !state.query.trim() ? `${pool} 個` : `${shown.length} / ${pool}`);
  if (sameShape && listEl.childElementCount) {
    ids.forEach((id) => {
      const profile = state.profiles.find((item) => item.id === id);
      const row = listEl.querySelector(`[data-profile-id="${CSS.escape(id)}"]`);
      if (profile && row) patchProfileRow(row, profile);
    });
    return;
  }
  listStructure = structure;
  listEl.replaceChildren();
  if (!teams.length) {
    listEl.append(el("p", { class: "empty" }, ["先建立隊伍，加入新帳號會直接放進那一隊。"]));
  } else {
    teams.forEach((team) => {
      const profiles = shown.filter((profile) => profile.team === team);
      if (!state.viewTeam && state.query.trim() && !profiles.length) return;
      listEl.append(renderTeamBlock(team, profiles));
    });
    if (!listEl.childElementCount) {
      listEl.append(el("p", { class: "empty" }, [`沒有符合「${state.query.trim()}」的帳號。`]));
    }
  }
  if (!state.viewTeam) {
    const loose = shown.filter((profile) => !cleanLabel(profile.team, 16));
    if (loose.length) {
      const block = el("section", { class: "team-block" });
      block.append(el("h3", { class: "team-label" }, ["未分隊"]));
      loose.forEach((profile) => block.append(renderProfileRow(profile)));
      listEl.append(block);
    }
  }
  if (state.scrollToActive) {
    const activeRow = listEl.querySelector("[data-active='true']");
    if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
    state.scrollToActive = false;
  } else {
    listEl.scrollTop = scrollTop;
  }
}

function renderConfirm(profile) {
  const deleting = state.confirm.type === "delete";
  const character = characterById(profile, state.confirm.characterId);
  const target = character && character.name ? character.name : profile.name;
  const box = el("div", { class: "confirm" });
  box.append(el("p", null, [deleting
    ? `從清單刪除「${profile.name}」？遊戲帳號不會被刪掉。`
    : `切換到「${target}」？這個瀏覽器的所有遊戲分頁都會變成這個帳號。`]));
  const actions = el("div", { class: "card-actions" });
  if (!deleting && state.current && state.current.loggedIn && !activeProfile()) {
    actions.append(el("button", { class: "btn", type: "button", onClick: guard(() => saveThenSwitch(profile)) }, ["先存再切換"]));
  }
  actions.append(el("button", {
    class: deleting ? "btn danger" : "btn primary",
    type: "button",
    onClick: guard(() => (deleting ? removeProfile(profile) : switchTo(profile, character))),
  }, [deleting ? "確定刪除" : "直接切換"]));
  actions.append(el("button", { class: "btn", type: "button", onClick: () => { state.confirm = null; renderList(); } }, ["取消"]));
  box.append(actions);
  return box;
}

function renderLiveIdentity() {
  const accountEl=document.querySelector("#live-account-name");
  const characterEl=document.querySelector("#live-character-name");
  if(!accountEl || !characterEl)return;
  const current=state.current;
  let account="讀取中…", character="讀取中…";
  if(current){
    if(current.tabCount===0){account="未開啟遊戲";character="—";}
    else if(!current.loggedIn){
      account=current.error && /讀取失敗|Failed|fetch|permission/i.test(current.error)?"無法讀取":"未登入";character="—";
    }else{
      const profile=activeProfile();
      account=(profile && profile.account) || current.account || current.loginName || (current.accountId!=null?"帳號 ID："+current.accountId:"已登入（帳號無法辨識）");
      character=current.activeCharacterName || "尚未選角或無法辨識";
    }
  }
  accountEl.textContent=account;accountEl.title=account;
  characterEl.textContent=character;characterEl.title=character;
  const remember = document.querySelector("#remember-current-google");
  remember.hidden = !(current?.loggedIn && AccountVault.isGoogleAccount(current) &&
    ((current.account && current.account !== "Google 帳號") || current.accountId != null) && !activeProfile());
}

function render() {
  renderLiveIdentity();
  renderTeamTabs();
  renderList();
}

let refreshLock = Promise.resolve();
let playingHold = "";
let playingHoldTimer = 0;
let playingWatchTimer = 0;

function holdPlaying(name) {
  const next = cleanLabel(name, 24);
  if (!next) return;
  playingHold = next;
  clearTimeout(playingHoldTimer);
  clearInterval(playingWatchTimer);
  if (state.current) {
    state.current.activeCharacterName = next;
    render();
  }
  playingWatchTimer = setInterval(() => {
    if (!playingHold) {
      clearInterval(playingWatchTimer);
      return;
    }
    refresh().catch(() => {});
  }, 1500);
  playingHoldTimer = setTimeout(() => {
    playingHold = "";
    clearInterval(playingWatchTimer);
    refresh().catch(() => {});
  }, 20000);
}

function notePlayingFromLive(liveName) {
  const live = cleanLabel(liveName, 24);
  if (!playingHold) return live;
  if (live === playingHold) {
    playingHold = "";
    clearTimeout(playingHoldTimer);
    clearInterval(playingWatchTimer);
    return live;
  }
  return playingHold;
}

function clearPlayingHold() {
  playingHold = "";
  clearTimeout(playingHoldTimer);
  clearInterval(playingWatchTimer);
}

async function refresh() {
  const run = refreshLock.then(() => refreshBody());
  refreshLock = run.catch(() => {});
  return run;
}

async function refreshBody() {
  if (await AccountVault.switchLocked()) return;
  const vault = await api.loadVault();
  state.profiles = vault.profiles;
  state.teams = Array.isArray(vault.teams) ? vault.teams : [];
  state.viewTeam = cleanLabel(vault.viewTeam, 16);
  state.pendingTeam = cleanLabel(vault.pendingTeam, 16);
  state.awaitingTeam = Boolean(vault.awaitingTeam);
  try {
    state.current = await api.readCurrent();
    if (state.current && playingHold) state.current.activeCharacterName = notePlayingFromLive(state.current.activeCharacterName);
  } catch (error) {
    state.current = {
      loggedIn: false,
      account: null,
      accountId: null,
      characters: [],
      cookies: [],
      localStorageData: {},
      cookieCount: 0,
      storageCount: 0,
      fingerprint: "",
      tabCount: 0,
      error: `讀取失敗：${error.message || error}`,
    };
  }
  if (await AccountVault.switchLocked()) return;
  if(state.current && state.current.loggedIn && !state.current.charactersKnown) setToast("已登入，但角色 JSON 尚未讀取成功，稍後會重試。");
  else if(state.current && state.current.loggedIn && !activeProfile()) setToast("已讀到登入資料，但尚未找到對應帳號，清單暫未更新。");
  const captured = await captureAwaitingAccount();
  if (!captured) {
    const updated = await rememberLiveCharacters();
    if (!updated) render();
  }
  if (state.awaitingTeam) watchAwaitingAccount();
}

async function captureAwaitingAccount() {
  if (await AccountVault.switchLocked()) return false;
  if (!state.awaitingTeam || !state.current || !state.current.loggedIn || !state.current.charactersKnown) return false;
  const existing = activeProfile();
  if (existing) {
    await persist({ pendingTeam: "", awaitingTeam: false }, `「${mentionName(existing)}」已經在清單裡。`);
    return true;
  }
  const profile = profileFromCurrent(null);
  await persist({
    profiles: [profile, ...state.profiles],
    pendingTeam: "",
    awaitingTeam: false,
  }, `已把「${profile.name}」放進${profile.team ? `「${profile.team}」` : "清單"}。`);
  return true;
}

async function rememberLiveCharacters() {
  if (await AccountVault.switchLocked()) return false;
  const active = activeProfile();
  if (!active || !state.current || !state.current.loggedIn) return false;
  if (active.accountId != null && state.current.accountId != null && String(active.accountId) !== String(state.current.accountId)) return false;
  if (AccountVault.isGoogleAccount(active)) return false;
  const known = state.current.charactersKnown === true;
  const characters = known ? (state.current.characters || []) : (active.characters || []);
  const account = active.account || cleanLabel(state.current.account, 64) || "";
  const label = labelFromCharacters(characters);
  const keptName = cleanLabel(active.name, 64);
  const provider = state.current.provider || active.provider || "";
  const name = account || (keptName && !keptName.startsWith("編號") ? keptName : "") || (provider === "google" ? "Google 帳號" : "帳號未記錄");
  const jobLabel = label.jobLabel || active.jobLabel || "";
  const localStorageData = AccountVault.keepAccountStorage(active.localStorageData, state.current.localStorageData, characters);
  const sessionStorageData = state.current.sessionStorageData || active.sessionStorageData || {};
  const fingerprint = state.current.fingerprint || active.fingerprint;
  const cookies = state.current.cookies && state.current.cookies.length ? state.current.cookies : active.cookies;
  const same = JSON.stringify(active.characters || []) === JSON.stringify(characters)
    && active.name === name
    && (active.account || "") === account
    && (active.provider || "") === provider
    && (active.jobLabel || "") === jobLabel
    && active.fingerprint === fingerprint
    && JSON.stringify(active.cookies || []) === JSON.stringify(cookies || [])
    && JSON.stringify(active.localStorageData || {}) === JSON.stringify(localStorageData)
    && JSON.stringify(active.sessionStorageData || {}) === JSON.stringify(sessionStorageData);
  if (same) return false;
  if (await AccountVault.switchLocked()) return false;
  const profiles = state.profiles.map((item) => (item.id === active.id ? {
    ...item,
    name,
    account: account || item.account || null,
    provider,
    jobLabel,
    characters,
    localStorageData,
    sessionStorageData,
    cookies,
    fingerprint,
    accountId: state.current.accountId != null ? state.current.accountId : item.accountId,
    updatedAt: Date.now(),
  } : item));
  await persist({ profiles });
  return true;
}

function profileFromCurrent(existing) {
  const now = Date.now();
  const label = labelFromCharacters(state.current.characters);
  const provider = state.current.provider || (existing && existing.provider) || "";
  const account = cleanLabel(state.current.account, 64) || (existing && existing.account) || "";
  const keptName = cleanLabel(existing && existing.name, 64);
  const name = account || (keptName && !keptName.startsWith("編號") && keptName !== label.name ? keptName : "") || (provider === "google" ? "Google 帳號" : "帳號未記錄");
  return AccountVault.googleAccountOnly({
    id: existing ? existing.id : crypto.randomUUID(),
    name,
    jobLabel: label.jobLabel || (existing && existing.jobLabel) || "",
    pinned: existing ? Boolean(existing.pinned) : false,
    team: existing ? cleanLabel(existing.team, 16) : (state.awaitingTeam ? state.pendingTeam : state.viewTeam),
    account: account || null,
    provider,
    label: existing && typeof existing.label === "string" ? existing.label : "",
    accountId: state.current.accountId != null ? state.current.accountId : (existing && existing.accountId),
    characters: state.current.characters,
    cookies: state.current.cookies,
    localStorageData: AccountVault.keepAccountStorage(existing && existing.localStorageData, state.current.localStorageData, state.current.characters),
    sessionStorageData: state.current.sessionStorageData || (existing && existing.sessionStorageData) || {},
    fingerprint: state.current.fingerprint,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  });
}

async function persist(patch, message) {
  const next = {
    profiles: "profiles" in patch ? patch.profiles : state.profiles,
    teams: "teams" in patch ? patch.teams : state.teams,
    viewTeam: "viewTeam" in patch ? patch.viewTeam : state.viewTeam,
    pendingTeam: "pendingTeam" in patch ? patch.pendingTeam : state.pendingTeam,
    awaitingTeam: "awaitingTeam" in patch ? patch.awaitingTeam : state.awaitingTeam,
  };
  await api.saveVault(next);
  state.profiles = next.profiles;
  state.teams = next.teams;
  state.viewTeam = next.viewTeam;
  state.pendingTeam = next.pendingTeam;
  state.awaitingTeam = next.awaitingTeam;
  if (message) setToast(message);
  render();
}

async function beginFreshLogin(team) {
  const chosen = cleanLabel(team, 16);
  state.confirm = null;
  await persist({ pendingTeam: chosen, awaitingTeam: true, viewTeam: chosen || state.viewTeam });
  await api.openFreshLogin();
  await refresh();
  setToast(chosen
    ? `已開啟遊戲；若仍登入中，請自行登出。手動登入後會自動放進「${chosen}」。`
    : "已另開登入頁。登入後會自動加入清單。沒有呼叫登出。");
}

async function saveThenFreshLogin() {
  if (!state.current || !state.current.loggedIn) {
    setToast("目前沒有可保存的登入。");
    return;
  }
  const team = cleanLabel(state.confirm && state.confirm.team, 16);
  state.pendingTeam = team;
  state.awaitingTeam = true;
  if (team) state.viewTeam = team;
  const profile = profileFromCurrent(null);
  await persist({ profiles: [profile, ...state.profiles], pendingTeam: team, awaitingTeam: true, viewTeam: state.viewTeam });
  await beginFreshLogin(team);
}

function requestFreshLogin(team) {
  const chosen=cleanLabel(team,16);
  if(!chosen){setToast("請先建立隊伍。");return;}
  state.confirm={type:"new-account",team:chosen};renderList();
}

function toggleMenu(profile) {
  state.menuId = state.menuId === profile.id ? null : profile.id;
  if (state.confirm && state.confirm.id !== profile.id) state.confirm = null;
  renderList();
}

async function togglePin(profile) {
  const profiles = state.profiles.map((item) => (item.id === profile.id ? { ...item, pinned: !item.pinned } : item));
  await persist({ profiles }, profile.pinned ? `已取消釘選「${profile.name}」。` : `已把「${profile.name}」釘在最上面。`);
}

function askDelete(profile) {
  state.menuId = profile.id;
  state.confirm = { type: "delete", id: profile.id };
  renderList();
}

async function copyText(name) {
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = name;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.focus();
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    area.remove();
    return copied;
  };
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    copied = await Promise.race([
      navigator.clipboard.writeText(name).then(() => true).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
  }
  if (!copied) copied = fallback();
  setToast(copied ? `已複製「${name}」。` : "沒能複製角色名稱。");
}

function characterById(profile, id) {
  if (!profile || id == null) return null;
  return (profile.characters || []).find((character) => character && String(character.id) === String(id)) || null;
}

function requestSwitch(profile) { switchTo(profile).catch(error=>setToast(error.message)); }
function requestEnter() { setToast("請在遊戲頁面自行點擊換角色及選擇角色。"); }
async function openSelectOnPage() { setToast("請在遊戲頁面自行選擇角色。"); }
async function enterOnPage() { setToast("請在遊戲頁面自行選擇角色。"); }


async function removeProfile(profile) {
  state.confirm = null;
  await chrome.storage.local.remove("credentials:" + profile.id);
  const profiles = state.profiles.filter((item) => item.id !== profile.id);
  await persist({ profiles }, `已從清單移除「${profile.name}」。`);
}

async function switchTo(profile) { state.confirm=null; await fillCredentials(profile); }

async function fillCredentials(profile, edit = false) {
  if (AccountVault.isGoogleAccount(profile)) {
    setToast("Google 帳號僅供記憶，請在遊戲內手動登入。");
    return;
  }
  if (credentialBusy) return;
  credentialBusy = true;
  try { await fillStoredCredentials(profile, edit); }
  finally { credentialBusy = false; }
}
let credentialBusy = false;
async function fillStoredCredentials(profile, edit) {
  const tabs = await chrome.tabs.query({currentWindow: true});
  const active = tabs.find(tab => tab.active);
  const gameTabs = tabs.filter(tab => tab.url?.startsWith(AccountVault.SITE) && new URL(tab.url).pathname !== "/info");
  let tab = gameTabs.find(tab => tab.active) || gameTabs[0];
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(item => item.tabIds.includes((tab || active)?.id));
  if (!store) throw new Error("找不到目前視窗的 Cookie 儲存區。");
  if (tab && !edit) {
    const current = await chromeApi.readCurrent(tab, store.id);
    const matched = current.loggedIn && AccountVault.findLoginProfile(state.profiles, current);
    if (matched && matched.id === profile.id) {
      setToast("目前已登入這個帳號。");
      return;
    }
  }

  const key = "credentials:" + profile.id;
  const stored = await chrome.storage.local.get(key);
  const saved = stored[key];
  if(!saved || edit){
    state.menuId=profile.id;renderList();
    setToast("請在帳號下方保存帳密，再按切換。帳密儲存在本機，未加密。");
    return;
  }
  const credentials={...saved};
  if(!credentials)return;
  await chrome.storage.local.set({[key]: {account: credentials.account, password: credentials.password}});
  await AccountVault.setSwitchLock(true);
  try {
    const query={domain:"ro-idle.app",storeId:store.id};
    const plain=await chrome.cookies.getAll(query);
    const partitioned=await chrome.cookies.getAll({...query,partitionKey:{topLevelSite:"https://ro-idle.app"}});
    const seen=new Set();
    for(const cookie of [...plain,...partitioned]){
      const identity=JSON.stringify([cookie.name,cookie.domain,cookie.path,cookie.storeId,cookie.partitionKey]);
      if(seen.has(identity))continue;seen.add(identity);
      const removed=await chrome.cookies.remove(AccountVault.cookieRemoveDetails(cookie));
      if(!removed)throw new Error("有遊戲 Cookie 無法清除，已停止切換，請重試。");
    }
    if (!tab) tab = await chrome.tabs.create({url: AccountVault.SITE, active: true});
    else {
      const beforeNav = await chrome.tabs.get(tab.id);
    const home = AccountVault.SITE.replace(/\/$/, "");
    const here = beforeNav.url ? beforeNav.url.split(/[?#]/)[0].replace(/\/$/, "") : "";
      if (here === home) {
        await chrome.tabs.update(tab.id, {active: true});
        await chrome.tabs.reload(tab.id);
      } else await chrome.tabs.update(tab.id, {url: AccountVault.SITE, active: true});
    }
    const deadline=Date.now()+20000;
    let stable=0;
    let filled = false;
    while(Date.now()<deadline){
      const current=await chrome.tabs.get(tab.id);
      if(current.status !== "complete" || current.pendingUrl || !current.url || current.url === "about:blank"){stable=0;await new Promise(r=>setTimeout(r,300));continue;}
      if(!current.url.startsWith(AccountVault.SITE)) throw new Error("遊戲分頁已離開原網站，停止填入。");
      let result;
      try {
        const [injected]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:(values,commit)=>{
          const account=document.querySelector('input[autocomplete="username"]');
          const password=document.querySelector('input[type="password"]');
          if(!account||!password)return "waiting";
          const active=document.activeElement;
          if((active===account&&account.value&&account.value!==values.account)||(active===password&&password.value&&password.value!==values.password))return "user";
          if(!commit)return "ready";
          sessionStorage.setItem("ro-ext:loginName",values.account);
          sessionStorage.removeItem("ro-ext:accountId");
          sessionStorage.removeItem("ro-ext:boundAccountId");
          sessionStorage.removeItem("ro-ext:provider");
          const focused=document.activeElement;
          const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
          for(const [input,value] of [[account,values.account],[password,values.password]]){
            const tracker=input._valueTracker;
            if(tracker)tracker.setValue(input.value);
            setter.call(input,value);
            input.dispatchEvent(new Event("input",{bubbles:true}));
            if(focused===input){
              input.focus();
              const end=input.value.length;
              if(input.setSelectionRange)input.setSelectionRange(end,end);
            }
          }
          return "filled";
        },args:[credentials,stable>=1]});
        result=injected&&injected.result;
      } catch(error) {
        stable=0;
        await chrome.tabs.get(tab.id);
      }
      if(result==="waiting")stable=0;
      if(result==="user"){
        setToast("偵測到你正在輸入，已停止自動填入。");
        return;
      }
      if(result==="ready"){
        stable+=1;
        if(stable<2){await new Promise(r=>setTimeout(r,250));continue;}
      }
      if(result==="filled"){
        filled = true;
        await new Promise(r=>setTimeout(r,150));
        const [clicked]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:(values)=>{
          const account=document.querySelector('input[autocomplete="username"]');
          const password=document.querySelector('input[type="password"]');
          if(!account || !password || account.value !== values.account || password.value !== values.password) return false;
          const scope=password.closest("form") || document;
          const candidates=[...scope.querySelectorAll('button, input[type="submit"]')].filter(node=>
            /^(登入|登錄|Log in|Login|Sign in)$/i.test((node.textContent || node.value || "").trim()) &&
            !node.disabled && node.getAttribute("aria-disabled")!=="true" && node.getClientRects().length>0);
          if(candidates.length!==1)return false;
          candidates[0].click();return true;
        },args:[credentials]});
        if(clicked?.result){
          setToast("已點擊登入。請確認登入結果並自行選擇角色。");
          return;
        }
      }
      await new Promise(r=>setTimeout(r,350));
    }
    if (filled) {
      setToast("已填好帳密，請自行點擊登入。");
      return;
    }
    throw new Error("已清除遊戲 Cookie，但尚未找到登入欄位。請確認頁面已載入；若仍維持登入，網站可能另存有其他驗證資料。");
  } finally {credentials.password="";await AccountVault.setSwitchLock(false);watchLoginSync();}
}


let loginSyncTimer = null;
function watchLoginSync() {
  clearInterval(loginSyncTimer);
  const deadline = Date.now() + 120000;
  let busy = false;
  loginSyncTimer = setInterval(async () => {
    if (Date.now() > deadline) {clearInterval(loginSyncTimer);loginSyncTimer=null;return;}
    if (busy || document.visibilityState === "hidden") return;
    busy = true;
    try {await refresh();} catch(error) {setToast("角色資料更新失敗："+(error.message||error));}
    finally {busy=false;}
  }, 2000);
}

async function openInfoPage() {
  const url = "https://ro-idle.app/info";
  if (preview || !globalThis.chrome || !chrome.tabs) {
    setToast("請在擴充功能側邊欄打開官方網站。");
    return;
  }
  const here = await chrome.tabs.query({ url: `${url}*`, currentWindow: true });
  const elsewhere = here.length ? [] : await chrome.tabs.query({ url: `${url}*` });
  const tab = here[0] || elsewhere[0];
  if (tab && tab.id != null) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null && chrome.windows) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    setToast("已切到官方網站。");
    return;
  }
  await chrome.tabs.create({ url, active: true });
  setToast("已打開官方網站。");
}

async function openGamePage() {
  if (preview || !globalThis.chrome || !chrome.tabs) {
    setToast("請在擴充功能側邊欄打開遊戲。");
    return;
  }
  const here = await chrome.tabs.query({ url: `${AccountVault.SITE}*`, currentWindow: true });
  const elsewhere = here.length ? [] : await chrome.tabs.query({ url: `${AccountVault.SITE}*` });
  const tab = here[0] || elsewhere[0];
  if (tab && tab.id != null) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null && chrome.windows) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    setToast("已切到遊戲分頁。");
    return;
  }
  await chrome.tabs.create({ url: AccountVault.SITE, active: true });
  setToast("已打開遊戲。");
}

async function saveThenSwitch(profile) {
  if (!state.current || !state.current.loggedIn) {
    setToast("目前沒有可保存的登入。");
    return;
  }
  const character = state.confirm && characterById(profile, state.confirm.characterId);
  const saved = profileFromCurrent(null);
  state.profiles = [saved, ...state.profiles];
  await api.saveVault({ profiles: state.profiles, teams: state.teams, viewTeam: state.viewTeam, pendingTeam: state.pendingTeam, awaitingTeam: state.awaitingTeam });
  await switchTo(profile, character);
  setToast(`已先保存「${saved.name}」，並切換到「${profile.name}」。`);
}

async function saveProfileEdits(profile, fields) {
  const account = String(fields.account || "").trim();
  if (AccountVault.isGoogleAccount(profile)) {
    if (!account) throw new Error("請填 Google 帳號或備註名稱。");
    const profiles = state.profiles.map(item => item.id === profile.id ? AccountVault.googleAccountOnly({
      ...item, account, name: account, label: cleanLabel(fields.label, 24),
      team: cleanLabel(fields.team, 16), updatedAt: Date.now(),
    }) : item);
    state.menuId = null;
    await persist({profiles}, "已更新 Google 帳號資訊。");
    return;
  }
  const password = String(fields.password || "");
  if (!account || !password) {
    setToast("請填寫登入帳號與密碼。");
    return;
  }
  const label = cleanLabel(fields.label, 24);
  const team = cleanLabel(fields.team, 16);
  const profiles = state.profiles.map((item) => (item.id === profile.id ? {
    ...item,
    label,
    team,
    account,
    name: account,
    updatedAt: Date.now(),
  } : item));
  await chrome.storage.local.set({ [fields.key]: { account, password } });
  delete credentialDrafts[profile.id];
  state.menuId = null;
  state.confirm = null;
  await persist({ profiles }, "已保存。");
}

async function setLabel(profile, value) {
  const label = cleanLabel(value, 24);
  if ((profile.label || "") === label) return;
  const profiles = state.profiles.map((item) => (item.id === profile.id ? { ...item, label } : item));
  await persist({ profiles }, label ? `已把顯示名稱改成「${label}」。` : "已清掉顯示名稱。");
}

async function assignTeam(profile, team) {
  const name = cleanLabel(team, 16);
  const profiles = state.profiles.map((item) => (item.id === profile.id ? { ...item, team: name } : item));
  await persist({ profiles }, name ? `已把「${mentionName(profile)}」分到「${name}」。` : `已把「${mentionName(profile)}」移出隊伍。`);
}

async function createTeam(name) {
  const team = cleanLabel(name, 16);
  if (!team) return;
  if (orderedTeams().includes(team)) {
    await persist({ viewTeam: team });
    return;
  }
  await persist({ teams: [...orderedTeams(), team], viewTeam: team }, `已建立「${team}」。`);
}

document.querySelector("#remember-current-google").addEventListener("click", guard(async () => {
  const current = state.current;
  if (!current?.loggedIn || !AccountVault.isGoogleAccount(current)) return;
  const account = current.account && current.account !== "Google 帳號"
    ? current.account : current.accountId != null ? "Google 帳號 #" + current.accountId : "";
  await rememberGoogleAccount(state.viewTeam, account, current);
}));

document.querySelector("#open-game").addEventListener("click", () => {
  openGamePage().catch((error) => setToast(error.message || String(error)));
});
document.querySelector("#open-info").addEventListener("click", () => {
  openInfoPage().catch((error) => setToast(error.message || String(error)));
});
document.querySelector("#team-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#team-name");
  createTeam(input.value).then(() => {
    input.value = "";
    document.querySelector("#team-form").hidden = true;
  }).catch((error) => setToast(error.message || String(error)));
});
document.querySelector("#team-rename").addEventListener("submit", (event) => {
  event.preventDefault();
  renameTeam(document.querySelector("#team-rename-name").value).catch((error) => setToast(error.message || String(error)));
});
document.querySelector("#cancel-rename").addEventListener("click", () => {
  state.renamingTeam = false;
  renderTeamRename();
});
document.querySelector("#cancel-team").addEventListener("click", () => {
  document.querySelector("#team-form").hidden = true;
  document.querySelector("#team-name").value = "";
});

if (!preview && globalThis.chrome && chrome.tabs) {
  let identityRefreshTimer;
  chrome.runtime.onMessage.addListener((message,sender)=>{
    if(message && message.type==="ro-vault:identity-changed" && sender.tab && sender.url && sender.url.startsWith(AccountVault.SITE)){
      clearTimeout(identityRefreshTimer);
      identityRefreshTimer=setTimeout(()=>refresh().catch(error=>setToast(error.message)),250);
    }
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "complete" && tab.url && tab.url.startsWith(AccountVault.SITE)) refresh().catch(() => {});
  });
  chrome.tabs.onActivated.addListener(() => {
    refresh().catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh().catch(() => {});
  });
  setInterval(() => {
    refresh().catch(() => {});
  }, 60000);
}


refresh().catch((error) => setToast(error.message || String(error)));


const pointerActivityInput = document.querySelector("#pointer-activity");
if (pointerActivityInput && !pointerActivityInput.closest("[hidden]") && !preview) {
  chrome.storage.local.get({ pointerActivityEnabled: true }).then(stored => {
    pointerActivityInput.checked = stored.pointerActivityEnabled;
  }).catch(error => setToast(error.message));
  pointerActivityInput.addEventListener("change", async () => {
    try {
      await chrome.storage.local.set({ pointerActivityEnabled: pointerActivityInput.checked });
    } catch (error) {
      pointerActivityInput.checked = !pointerActivityInput.checked;
      setToast(error.message);
    }
  });
}

document.querySelector("#open-config-generator").addEventListener("click", guard(async () => {
  await chrome.tabs.create({url: chrome.runtime.getURL("config-generator.html")});
}));

document.querySelector("#open-logs").addEventListener("click", guard(async () => {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  const tab = tabs[0];
  if (tab?.url?.startsWith(AccountVault.SITE) && !new URL(tab.url).pathname.startsWith("/info")) {
    await chrome.storage.session.set({["last-game-tab:" + tab.windowId]: tab.id});
  }
  await chrome.tabs.create({url: chrome.runtime.getURL("logs.html")});
}));
