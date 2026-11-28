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
  let backgroundStream;
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
    const node = document.querySelector('.ui2-avatar + div > b:first-child, .ui2-mstatus button[aria-label="打開完整狀態"] > b:first-child');
    if (!node) return null;
    const name = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE)
      .map(child => child.textContent).join("").trim();
    const levels = node.parentElement.textContent.match(/Base Lv\.\s*(\d+).*Job Lv\.\s*(\d+)/s)
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
    clearTimeout(timer);
    timer = undefined;
    message = text;
  }

  function closeBackgroundStream() {
    backgroundStream?.close();
    backgroundStream = undefined;
    backgroundSignal = "";
    lastSnapshotAt = 0;
  }

  function streamHealthy() {
    if (document.hidden) return lastSnapshotAt > 0 && Date.now() - lastSnapshotAt < fallbackMs;
    const classic = document.querySelector(".xp-statusbar-scroll");
    if (classic) return classic.textContent.includes("● 已連線");
    const mobile = document.querySelector('.ui2-mstatus button[aria-label="打開完整狀態"]');
    return Boolean(mobile && !mobile.textContent.includes("○ 連線中"));
  }

  function syncBackgroundStream() {
    if (!observing || !document.hidden) {
      closeBackgroundStream();
      if (observing) inspect(true);
      return;
    }
    if (backgroundStream) return;
    // Use the game's non-watching stream without taking over its foreground connection.
    const stream = new EventSource(`/api/characters/${role.id}/stream?partial=1&watch=0`);
    backgroundStream = stream;
    stream.addEventListener("snapshot", event => {
      if (backgroundStream !== stream || !observing) return;
      let snapshot;
      try {
        ({snapshot} = JSON.parse(event.data));
      } catch {
        return;
      }
      const character = snapshot?.character;
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

  function retryRead(error) {
    const backoff = Math.min(maxBackoffMs, fallbackMs * 2 ** readFailures++);
    const delay = Math.max(backoff, error.retryAfterMs ?? 0);
    retryAt = Date.now() + delay;
    message = `暫時讀不到角色狀態，約 ${Math.ceil(delay / 60000)} 分鐘後重試。`;
    clearTimeout(retryTimer);
    function retry() {
      if (!observing) return;
      const remaining = retryAt - Date.now();
      if (remaining > 0) retryTimer = setTimeout(retry, Math.min(remaining, 2_147_483_647));
      else inspect(true, !streamHealthy());
    }
    retryTimer = setTimeout(retry, Math.min(delay, 2_147_483_647));
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
        status:reply.status, retryAfterMs:retryAfterMs(reply.headers.get("Retry-After")),
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
        if (!(error instanceof TypeError) && error.name !== "TimeoutError" &&
            error.status !== 429 && !(error.status >= 500)) throw error;
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
        if (displayedCharacter()?.name !== role.name) {
          stop("找不到原本的遊戲角色，流程已停止。");
          break;
        }
        if (view.snapshot.activity === "dead") {
          message = "角色死亡，等待復活。";
          break;
        }
        const plan = globalThis.roPlanArcher(view.snapshot.character);
        if (plan.stop) stop(plan.message);
        if (!plan.command) {
          message = plan.message;
          break;
        }
        const command = plan.command;
        const body = {commandId: crypto.randomUUID(), expectedCommandRevision: view.commandRevision, command};
        message = command.type === "learnSkills" ? `送出 ${command.skills.length} 級技能。`
          : command.type === "jobChange" ? "正在轉職…" : "正在轉生…";
        const reply = await request(`${path}/commands`, body);
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
      if (observing && pending) void run();
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
