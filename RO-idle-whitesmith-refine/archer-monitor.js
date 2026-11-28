(() => {
  "use strict";
  if (globalThis.roArcherMonitorInstalled) return;
  globalThis.roArcherMonitorInstalled = true;
  let role;
  let observing = false;
  let inFlight = false;
  let pending = false;
  let pendingRefresh = false;
  let lastSignal = "";
  let timer;
  let fallback;
  const fallbackMs = 3 * 60_000;
  const maxBackoffMs = 15 * 60_000;
  let retryTimer;
  let retryAt = 0;
  let readFailures = 0;
  let revisionConflicts = 0;
  let backgroundStream;
  let backgroundSnapshot = null;
  let backgroundSignal = "";
  let lastSnapshotAt = 0;
  let message = "尚未啟用。";
  const observer = new MutationObserver(() => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      inspect();
    }, 350);
  });

  function displayedCharacter() {
    const classic = [...document.querySelectorAll(".xp-title .caption")]
      .map(node => node.textContent.trim().match(/^RO放置仙境 - \[(.+)\] .+ Lv\.(\d+) \/ Job (\d+)$/))
      .find(Boolean);
    if (classic) return {name: classic[1], levels: `${classic[2]}:${classic[3]}`};
    const node = document.querySelector(
      '.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child, b[class*="text-[var(--ink-name"]',
    );
    if (!node) return null;
    const name = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE)
      .map(child => child.textContent).join("").trim();
    const containerText = node.parentElement?.parentElement?.textContent ?? node.parentElement?.textContent ?? "";
    const levels = containerText.match(/Base Lv\.\s*(\d+).*Job Lv\.\s*(\d+)/s)
      ?? node.nextElementSibling?.textContent.match(/(\d+)\s*／\s*(\d+)/);
    return {name, levels: levels ? `${levels[1]}:${levels[2]}` : ""};
  }

  function stop(text) {
    observing = false;
    pending = false;
    pendingRefresh = false;
    observer.disconnect();
    document.removeEventListener("visibilitychange", syncBackgroundStream);
    closeBackgroundStream();
    clearInterval(fallback);
    clearTimeout(retryTimer);
    retryAt = 0;
    readFailures = 0;
    revisionConflicts = 0;
    clearTimeout(timer);
    timer = undefined;
    message = text;
  }

  function closeBackgroundStream() {
    backgroundStream?.close();
    backgroundStream = undefined;
    backgroundSnapshot = null;
    backgroundSignal = "";
    lastSnapshotAt = 0;
  }

  function mergePartialSnapshot(snapshot, kept, previous) {
    if (!snapshot) return null;
    if (!kept?.length) return snapshot;
    if (!previous) return null;
    const merged = {...snapshot};
    for (const key of kept) {
      if (!(key in previous)) return null;
      merged[key] = previous[key];
    }
    return merged;
  }

  function streamHealthy() {
    if (document.hidden) return lastSnapshotAt > 0 && Date.now() - lastSnapshotAt < fallbackMs;
    const classic = document.querySelector(".xp-statusbar-scroll");
    if (classic) return classic.textContent.includes("● 已連線");
    const mobile = document.querySelector('.ui2-mstatus button[aria-label="打開完整狀態"]');
    return Boolean(mobile && !mobile.textContent.includes("○"));
  }

  function syncBackgroundStream() {
    if (!observing || !document.hidden) {
      closeBackgroundStream();
      if (observing) inspect(true);
      return;
    }
    if (backgroundStream) return;
    // Use the game's non-watching stream without taking over its foreground connection.
    const stream = new EventSource(`/api/characters/${role.id}/stream?watch=0`);
    backgroundStream = stream;
    stream.addEventListener("snapshot", event => {
      if (backgroundStream !== stream || !observing) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const snapshot = mergePartialSnapshot(payload?.snapshot, payload?.kept, backgroundSnapshot);
      if (!snapshot) return;
      backgroundSnapshot = snapshot;
      const character = snapshot.character;
      if (!character || !Number.isInteger(character.baseLv) || !Number.isInteger(character.jobLv)) return;
      lastSnapshotAt = Date.now();
      const signal = JSON.stringify([character.job, character.baseLv, character.jobLv, snapshot.activity === "dead"]);
      if (signal === backgroundSignal) return;
      backgroundSignal = signal;
      inspect(true);
    });
    for (const event of ["idle", "superseded"]) {
      stream.addEventListener(event, () => {
        if (backgroundStream === stream) closeBackgroundStream();
      });
    }
    stream.addEventListener("error", () => {
      if (backgroundStream === stream) lastSnapshotAt = 0;
    });
    inspect(true);
  }

  function retryAfterMs(header) {
    if (!header) return 0;
    if (/^\d+$/.test(header)) return Number(header) * 1000;
    return Math.max(0, Date.parse(header) - Date.now()) || 0;
  }

  function isTransientError(error) {
    return error instanceof TypeError ||
      error.name === "TimeoutError" ||
      error.status === 429 ||
      error.status === 409 ||
      error.status >= 500 ||
      error.code === "BUSY_CATCHING_UP";
  }

  function scheduleRetry(delay, statusText) {
    retryAt = Date.now() + delay;
    message = statusText;
    clearTimeout(retryTimer);
    function retry() {
      if (!observing) return;
      const remaining = retryAt - Date.now();
      if (remaining > 0) retryTimer = setTimeout(retry, Math.min(remaining, 2_147_483_647));
      else inspect(true, !streamHealthy());
    }
    retryTimer = setTimeout(retry, Math.min(delay, 2_147_483_647));
  }

  function retryRead(error, actionLabel = "讀不到角色狀態") {
    if ((error.status === 409 || error.code === "BUSY_CATCHING_UP") && revisionConflicts < 3) {
      revisionConflicts++;
      const delay = Math.max(1500 * revisionConflicts, error.retryAfterMs ?? 0);
      scheduleRetry(delay, `角色狀態同步中，約 ${Math.ceil(delay / 1000)} 秒後重試。`);
      return;
    }
    const backoff = Math.min(maxBackoffMs, fallbackMs * 2 ** readFailures++);
    const delay = Math.max(backoff, error.retryAfterMs ?? 0);
    scheduleRetry(delay, `暫時${actionLabel}，約 ${Math.ceil(delay / 60000)} 分鐘後重試。`);
  }

  async function request(path, body) {
    const reply = await fetch(path, {
      signal: AbortSignal.timeout(15000),
      credentials: "same-origin",
      ...(body && {
        method: "POST",
        headers: {"content-type":"application/json","x-ro-client":"1"},
        body: JSON.stringify(body),
      }),
    });
    const data = await reply.json().catch(error => {
      if (reply.ok) throw error;
      return null;
    });
    if (!reply.ok) {
      throw Object.assign(new Error(data?.error?.message ?? data?.message ??
        (typeof data?.error === "string" ? data.error : `HTTP ${reply.status}`)), {
        status: reply.status,
        code: data?.error?.code ?? data?.code ?? null,
        retryAfterMs: retryAfterMs(reply.headers.get("Retry-After")),
      });
    }
    return data;
  }

  function checkedView(view) {
    if (view?.characterId !== role.id || view.name !== role.name ||
        !Number.isInteger(view.commandRevision) || !view.snapshot?.character) {
      throw new Error("無法確認目前角色的狀態。");
    }
    return view;
  }

  async function track(view, confirmedRebirth = false) {
    try {
      const key = globalThis.roArcherTiming.key(role.id);
      const stored = await chrome.storage.local.get(key);
      const rounds = globalThis.roArcherTiming.recordProgress(stored[key] ?? [],
        view.snapshot.character, Date.now(), confirmedRebirth);
      if (rounds) await chrome.storage.local.set({[key]: rounds});
    } catch (error) {
      console.warn("RO 弓箭手計時儲存失敗", error);
    }
  }

  async function run() {
    if (!observing || inFlight || Date.now() < retryAt) return;
    inFlight = true;
    pending = false;
    const refresh = pendingRefresh;
    pendingRefresh = false;
    try {
      const path = `/api/characters/${role.id}`;
      const snapshotPath = refresh ? path : `${path}?deferCatchup=1`;
      let response;
      try {
        response = await request(snapshotPath);
      } catch (error) {
        if (!isTransientError(error)) throw error;
        if (observing) retryRead(error);
        return;
      }
      if (!observing) return;
      clearTimeout(retryTimer);
      retryAt = 0;
      readFailures = 0;
      let view = checkedView(response);
      await track(view);
      while (observing) {
        const shown = displayedCharacter();
        if (shown?.name && shown.name !== role.name) {
          stop("遊戲已切換角色，流程已停止。");
          break;
        }
        if (!shown && !document.hidden) {
          scheduleRetry(3000, "等待遊戲畫面顯示角色狀態…");
          break;
        }
        if (view.snapshot.activity === "dead") {
          message = "角色死亡，等待復活。";
          break;
        }
        const plan = globalThis.roPlanArcher(view.snapshot.character, view.snapshot);
        if (plan.stop) stop(plan.message);
        if (!plan.command) {
          message = plan.message;
          break;
        }
        const command = plan.command;
        const body = {commandId: crypto.randomUUID(), expectedCommandRevision: view.commandRevision, command};
        message = command.type === "learnSkills" ? `送出 ${command.skills.length} 級技能。`
          : command.type === "jobChange" ? "正在轉職…" : "正在轉生…";
        let reply;
        try {
          reply = await request(`${path}/commands`, body);
        } catch (error) {
          if (!isTransientError(error)) throw error;
          if (observing) retryRead(error, "無法送出操作");
          return;
        }
        revisionConflicts = 0;
        const next = checkedView(reply.view);
        if (next.commandRevision === view.commandRevision) throw new Error("伺服器未確認指令結果。");
        if (command.type === "jobChange" && next.snapshot.character.job !== command.job) {
          throw new Error("伺服器未確認轉職結果。");
        }
        if (command.type === "rebirth" && next.snapshot.character.job !== "novice_high") {
          throw new Error("伺服器未確認轉生結果。");
        }
        if (command.type === "learnSkills") {
          const before = view.snapshot.character.skills;
          const expected = new Map();
          for (const id of command.skills) expected.set(id, (expected.get(id) ?? before[id] ?? 0) + 1);
          if ([...expected].some(([id, level]) => next.snapshot.character.skills[id] !== level)) {
            throw new Error("伺服器未確認全部技能等級。");
          }
        }
        await track(next, command.type === "rebirth");
        view = next;
      }
    } catch (error) {
      stop(`流程停止。${error.message} 請確認角色狀態後再啟用。`);
    } finally {
      inFlight = false;
      if (observing && pending && Date.now() >= retryAt) void run();
    }
  }

  function inspect(force = false, refresh = false) {
    if (!observing) return;
    const current = displayedCharacter();
    if (current?.name && current.name !== role.name) {
      stop("遊戲已切換角色，流程已停止。");
      return;
    }
    if (!current || (!force && current.levels === lastSignal)) return;
    lastSignal = current.levels;
    pending = true;
    pendingRefresh ||= refresh;
    void run();
  }

  chrome.runtime.onMessage.addListener((input, sender, respond) => {
    if (sender.id !== chrome.runtime.id || input?.feature !== "archer-growth") return;
    if (input.action === "stop") stop("已停止自動加點。");
    if (input.action === "start" && !observing && !inFlight) {
      if (location.origin !== "https://ro-idle.app" ||
          !Number.isSafeInteger(input.role?.id) || !input.role?.name ||
          displayedCharacter()?.name !== input.role.name) {
        message = "請先進入要練功的遊戲角色。";
      } else {
        role = input.role;
        observing = true;
        observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true});
        document.addEventListener("visibilitychange", syncBackgroundStream);
        fallback = setInterval(() => {
          if (!streamHealthy() && Date.now() >= retryAt) inspect(true, true);
        }, fallbackMs);
        syncBackgroundStream();
      }
    }
    respond({running: observing || inFlight, message});
  });
})();
