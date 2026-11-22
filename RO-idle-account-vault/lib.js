(function (root) {
  const SITE = "https://ro-idle.app/";
  const LB_COOKIE = "ro_lb2";

  function cookieHost(cookie) {
    return String(cookie.domain || "ro-idle.app").replace(/^\./, "");
  }

  function cookieUrl(cookie) {
    const protocol = cookie.secure ? "https" : "http";
    const path = cookie.path || "/";
    return `${protocol}://${cookieHost(cookie)}${path}`;
  }

function isHostOnly(cookie) {
  if (typeof cookie.hostOnly === "boolean") return cookie.hostOnly;
  return !String(cookie.domain || "").startsWith(".");
}

function cookieSetDetails(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.storeId) details.storeId = cookie.storeId;
  if (!isHostOnly(cookie) && cookie.domain) details.domain = cookie.domain;
  if (typeof cookie.expirationDate === "number") details.expirationDate = cookie.expirationDate;
  if (cookie.sameSite === "lax" || cookie.sameSite === "strict" || cookie.sameSite === "no_restriction") {
    details.sameSite = cookie.sameSite;
  }
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  if (String(cookie.name || "").startsWith("__Host-")) {
    details.secure = true;
    details.path = "/";
    details.url = `https://${cookieHost(cookie)}/`;
    delete details.domain;
  }
  return details;
}

  function cookieRemoveDetails(cookie) {
    const details = { url: cookieUrl(cookie), name: cookie.name };
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    return details;
  }

const JOBS = {
  novice: "初學者",
  supernovice: "超級初心者",
  swordman: "劍士",
  mage: "魔法師",
  archer: "弓箭手",
  acolyte: "服事",
  merchant: "商人",
  thief: "盜賊",
  knight: "騎士",
  wizard: "巫師",
  hunter: "獵人",
  priest: "祭司",
  blacksmith: "鐵匠",
  assassin: "刺客",
  crusader: "十字軍",
  sage: "賢者",
  rogue: "流氓",
  alchemist: "鍊金術師",
  monk: "武道家",
  bard: "吟遊詩人",
  dancer: "舞孃",
  novice_high: "初學者",
  swordman_high: "劍士",
  mage_high: "魔法師",
  archer_high: "弓箭手",
  acolyte_high: "服事",
  merchant_high: "商人",
  thief_high: "盜賊",
  lord_knight: "騎士領主",
  assassin_cross: "十字刺客",
  sniper: "神射手",
  high_priest: "神官",
  high_wizard: "超魔導師",
  whitesmith: "神工匠",
  paladin: "聖殿十字軍",
  stalker: "神行太保",
  clown: "搞笑藝人",
  gypsy: "冷豔舞姬",
  champion: "武術宗師",
  professor: "智者",
  creator: "創造者",
};

function jobName(job) {
  if (typeof job !== "string") return "";
  return JOBS[job.trim()] || "";
}

function authBags(me) {
  if (!me || typeof me !== "object") return [];
  return [me, me.user, me.account, me.google, me.profile].filter((bag) => bag && typeof bag === "object");
}

function pickAccount(me) {
  const keys = ["username", "account", "name", "email", "displayName", "googleEmail", "googleName", "nickname"];
  for (const bag of authBags(me)) {
    for (const key of keys) {
      const value = bag[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 64);
    }
  }
  return null;
}

function pickGoogleAccount(me) {
  for (const bag of authBags(me)) {
    for (const key of ["googleEmail", "email"]) {
      if (typeof bag[key] === "string" && bag[key].trim()) return bag[key].trim().slice(0, 64);
    }
  }
  return pickAccount(me);
}

function parseAccountId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]{1,24}$/.test(value.trim())) return value.trim();
  return null;
}

function pickAccountId(me) {
  const keys = ["accountId", "userId", "uid", "id"];
  for (const bag of authBags(me)) {
    for (const key of keys) {
      const id = parseAccountId(bag[key]);
      if (id != null) return id;
    }
  }
  return null;
}

function pickProvider(me) {
  if (!me || typeof me !== "object") return "";
  if (typeof me.provider === "string" && me.provider.trim()) return me.provider.trim().slice(0, 16);
  if (me.googleLinked || me.google) return "google";
  return "";
}

function combineCharacters(payload, alts) {
  const primary = payload && Array.isArray(payload.characters) ? payload.characters : [];
  const extra = Array.isArray(alts) ? alts : [];
  const seen = new Set();
  const list = [];
  [...primary, ...extra].forEach((character) => {
    if (!character || character.id == null) return;
    const id = String(character.id);
    if (seen.has(id)) return;
    seen.add(id);
    list.push(character);
  });
  return { characters: list };
}

function pickCharacters(payload) {
  const list = payload && Array.isArray(payload.characters) ? payload.characters : [];
  return list.map((character) => {
    const jobKey = [character && character.job, character && character.jobName].find((value) => typeof value === "string" && value.trim());
    const level = character && (typeof character.baseLv === "number" ? character.baseLv : character.baseLevel);
    const jobLevel = character && (typeof character.jobLv === "number" ? character.jobLv : character.jobLevel);
    const job = jobKey ? jobKey.trim() : null;
    return {
      id: character && character.id != null ? character.id : null,
      name: character && typeof character.name === "string" && character.name.trim() ? character.name.trim().slice(0, 24) : "未命名",
      baseLv: typeof level === "number" ? level : null,
      jobLv: typeof jobLevel === "number" ? jobLevel : null,
      job,
      jobLabel: job ? (JOBS[job] || job) : null,
      running: Boolean(character && character.running),
    };
  });
}

  function volatileCookie(cookie) {
    const name = cookie && cookie.name ? String(cookie.name) : "";
    return name === "ro_google" || name.startsWith("ro_lb");
  }

  function durableCookies(cookies) {
    return (cookies || []).filter((cookie) => cookie && !volatileCookie(cookie));
  }

  async function listSiteCookies() {
    const domain = "ro-idle.app";
    const plain = await chrome.cookies.getAll({ domain });
    const partitioned = await chrome.cookies.getAll({
      domain,
      partitionKey: { topLevelSite: "https://ro-idle.app" },
    }).catch(() => []);
    const seen = new Set();
    const merged = [];
    [...plain, ...partitioned].forEach((cookie) => {
      if (!cookie || !cookie.name) return;
      const key = [
        cookie.name,
        cookie.domain,
        cookie.path,
        cookie.storeId || "",
        cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : "",
      ].join("\n");
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(cookie);
    });
    return merged;
  }

  async function setSwitchLock(locked) {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.session) return;
    if (locked) await chrome.storage.session.set({ switchLockUntil: Date.now() + 60000 });
    else await chrome.storage.session.remove("switchLockUntil");
  }

  async function switchLocked() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.session) return false;
    const stored = await chrome.storage.session.get({ switchLockUntil: 0 });
    return typeof stored.switchLockUntil === "number" && stored.switchLockUntil > Date.now();
  }

  async function fingerprintCookies(cookies) {
    const source = durableCookies(cookies)
      .map((cookie) => `${cookie.name}=${cookie.path || "/"}\n${cookie.value}`)
      .sort()
      .join("\n");
    const encoded = new TextEncoder().encode(source);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

function characterIds(characters) {
  return new Set((characters || []).map((character) => (character && character.id != null ? String(character.id) : "")).filter(Boolean));
}

function sameAccountId(left, right) {
  if (left == null || right == null || left === "" || right === "") return false;
  return String(left) === String(right);
}

function idsDiffer(profile, login) {
  if (!profile || !login) return false;
  if (profile.accountId == null || profile.accountId === "" || login.accountId == null || login.accountId === "") return false;
  return String(profile.accountId) !== String(login.accountId);
}

function characterSubset(profile, login) {
  const live = characterIds(login && login.characters);
  const saved = characterIds(profile && profile.characters);
  if (!live.size || !saved.size) return false;
  for (const id of live) {
    if (!saved.has(id)) return false;
  }
  return true;
}

function isGoogleAccount(profile) {
  return String(profile?.provider ?? "").trim().toLowerCase() === "google";
}

function googleAccountOnly(profile) {
  if (!isGoogleAccount(profile)) return profile;
  const {id, name, account, accountId, label, team, pinned, createdAt, updatedAt} = profile;
  const characters = pickCharacters({characters: profile.characters});
  return {id, name, account, accountId, label, team, pinned, createdAt, updatedAt, provider: "google", characters};
}

function updateGoogleCharacters(profile, {accountId, characters, charactersKnown}) {
  if (!isGoogleAccount(profile) || !charactersKnown || idsDiffer(profile, {accountId})) return profile;
  const next = googleAccountOnly({...profile, accountId: accountId ?? profile.accountId, characters});
  if (sameAccountId(next.accountId, profile.accountId) === false && next.accountId != null ||
      JSON.stringify(next.characters) !== JSON.stringify(profile.characters ?? [])) {
    return {...next, updatedAt: Date.now()};
  }
  return profile;
}

function findLoginProfile(profiles, login) {
  if (!login) return null;
  const list = (Array.isArray(profiles) ? profiles : []).filter(profile =>
    !login.provider || isGoogleAccount(profile) === isGoogleAccount(login));
  if (login.accountId != null && login.accountId !== "") {
    const byId = list.filter((profile) => sameAccountId(profile.accountId, login.accountId));
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return null;
  }
  if (login.fingerprint) {
    const byFingerprint = list.filter((profile) => profile.fingerprint && profile.fingerprint === login.fingerprint && !idsDiffer(profile, login));
    if (byFingerprint.length === 1) return byFingerprint[0];
    if (byFingerprint.length > 1) return null;
  }
  const account = typeof login.account === "string" ? login.account.trim() : "";
  if (account && account !== "Google 帳號") {
    const byAccount = list.filter((profile) => typeof profile.account === "string" && profile.account === account && !idsDiffer(profile, login));
    if (byAccount.length === 1) return byAccount[0];
  }
  const loginName = typeof login.loginName === "string" ? login.loginName.trim() : "";
  if (loginName) {
    const byLoginName = list.filter(profile => profile.account === loginName && !idsDiffer(profile, login));
    if (byLoginName.length === 1) return byLoginName[0];
  }
  const byCharacters = list.filter((profile) => characterSubset(profile, login) && !idsDiffer(profile, login));
  if (byCharacters.length === 1) return byCharacters[0];
  return null;
}

function profileMatchesLogin(profile, login) {
  if (!profile || !login || idsDiffer(profile, login)) return false;
  if (sameAccountId(profile.accountId, login.accountId)) return true;
  if (profile.fingerprint && login.fingerprint && profile.fingerprint === login.fingerprint) return true;
  return false;
}

function storageCharacterId(key) {
  if (key.startsWith("ro-idle:lastSeen:")) return key.slice("ro-idle:lastSeen:".length);
  if (key.startsWith("ro-idle:statsBase:")) return key.slice("ro-idle:statsBase:".length);
  return "";
}

function keepAccountStorage(existingStorage, liveStorage, characters) {
  const ids = new Set((characters || []).map((character) => (character && character.id != null ? String(character.id) : "")).filter(Boolean));
  const existing = existingStorage || {};
  const live = liveStorage || {};
  const liveIds = new Set();
  Object.keys(live).forEach((key) => {
    const id = storageCharacterId(key);
    if (id) liveIds.add(id);
  });
  const matchesAccount = !liveIds.size || [...liveIds].some((id) => ids.has(id));
  if (!matchesAccount) return { ...existing };
  const next = {};
  Object.entries(existing).forEach(([key, value]) => {
    const id = storageCharacterId(key);
    if (id && ids.has(id)) next[key] = value;
  });
  Object.entries(live).forEach(([key, value]) => {
    const id = storageCharacterId(key);
    if (!id || ids.has(id)) next[key] = value;
  });
  return next;
}

function describeCharacters(characters) {
  if (!characters || !characters.length) return "還沒有角色";
  return characters
    .map((character) => {
      const job = character.jobLabel ? ` ${character.jobLabel}` : "";
      const level = character.baseLv != null ? ` Lv.${character.baseLv}` : "";
      const running = character.running ? "・掛機中" : "";
      return `${character.name}${job}${level}${running}`;
    })
    .join("、");
}

  root.AccountVault = {
    SITE,
    LB_COOKIE,
    cookieUrl,
    isHostOnly,
    cookieSetDetails,
    cookieRemoveDetails,
    pickAccount,
    pickAccountId,
    parseAccountId,
    pickProvider,
    isGoogleAccount,
    googleAccountOnly,
    updateGoogleCharacters,
    pickGoogleAccount,
    jobName,
    combineCharacters,
    pickCharacters,
    profileMatchesLogin,
    findLoginProfile,
    fingerprintCookies,
    volatileCookie,
    durableCookies,
    listSiteCookies,
    setSwitchLock,
    switchLocked,
    keepAccountStorage,
    describeCharacters,
  };
})(globalThis);
