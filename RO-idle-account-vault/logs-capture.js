(() => {
  const previous = globalThis.__roVaultLogCaptureController;
  if (previous?.version === "1.9.4" && previous.valid()) return;
  previous?.stop();
  const runtime = chrome.runtime;
  const queue = [];
  let stopped = false;
  let flushing = false;
  let retryTimer;
  let lastSavedAt = 0;
  let lastError = "";
  const intervals = [];

  function valid() {
    if (stopped) return false;
    try {runtime.getManifest();return true;} catch {return false;}
  }
  function identity() {
    const caption = document.querySelector(".xp-title .caption")?.textContent || "";
    const match = caption.match(/^RO放置仙境 - \[([^\]]+)\]/);
    return {account: sessionStorage.getItem("ro-ext:loginName") || "", character: match ? match[1] : ""};
  }
  function enqueue(row) {
    queue.push({...identity(), receivedAt: Date.now(), ...row});
    if (queue.length >= 100) flush();
  }
  async function flush() {
    if (stopped || flushing || !queue.length) return;
    flushing = true;
    const rows = queue.slice(0, 100);
    try {
      const result = await runtime.sendMessage({type: "ro-vault:save-logs", rows});
      if (!result?.ok) throw new Error(result?.error || "LOG 保存失敗");
      queue.splice(0, rows.length);
      if (result.saved > 0) lastSavedAt = Date.now();
      lastError = "";
      if (lastSavedAt) document.documentElement?.setAttribute("data-ro-log-saved-at", String(lastSavedAt));
      document.documentElement?.setAttribute("data-ro-log-recorder", "1.9.4");
      document.documentElement?.removeAttribute("data-ro-log-error");
    } catch (error) {
      lastError = error.message;
      document.documentElement?.setAttribute("data-ro-log-error", lastError);
      if (/context invalidated/i.test(lastError)) controller.stop();
    } finally {
      flushing = false;
      clearTimeout(retryTimer);
      if (!stopped && queue.length) retryTimer = setTimeout(flush, 1000);
    }
  }
  function messageListener(event) {
    const message = event.data;
    if (stopped || event.source !== window || event.origin !== location.origin || message?.source !== "ro-vault-log-stream") return;
    if (message.type === "display") {
      if (typeof message.text !== "string" || message.text.length > 2000000) return;
      const current = identity();
      enqueue({
        id: ["battle-text", current.account, current.character, CombatLogs.dayKey(message.wallMs || Date.now()), message.lineId].join(":"),
        kind: "遊戲文字", event: "display", characterId: String(message.characterId || ""),
        text: message.text, seq: message.seq, category: message.category, tone: message.tone,
        eventAt: Number.isFinite(message.wallMs) ? message.wallMs : Date.now()
      });
      return;
    }
    if (message.type !== "events" || typeof message.data !== "string" || message.data.length > 2000000) return;
    let payload;
    try {payload = JSON.parse(message.data);} catch {return;}
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const data of rows) {
      const seq = data && typeof data === "object" ? data.seq : null;
      const stable = seq != null ? String(seq) : message.lastEventId;
      enqueue({
        id: stable ? ["sse", message.characterId, message.type, CombatLogs.dayKey(data?.wallMs || Date.now()), stable].join(":") : crypto.randomUUID(),
        kind: "事件 JSON", characterId: String(message.characterId || ""), event: "events",
        text: JSON.stringify(data), seq, eventAt: Number.isFinite(data?.wallMs) ? data.wallMs : Date.now(),
        category: CombatLogs.category({data}), transport: message.transport || "SSE", data
      });
    }
  }
  function statusListener(message, sender, reply) {
    if (message?.type !== "ro-vault:capture-status") return;
    reply({pending: queue.length, lastSavedAt, error: lastError, recorderVersion: "1.9.4"});
  }
  const controller = {
    version: "1.9.4", valid,
    stop() {
      stopped = true;
      intervals.forEach(clearInterval);clearTimeout(retryTimer);
      window.removeEventListener("message", messageListener);
      window.removeEventListener("pagehide", flush);
      try {runtime.onMessage.removeListener(statusListener);} catch {}
    }
  };
  globalThis.__roVaultLogCaptureController = controller;
  window.addEventListener("message", messageListener);
  window.addEventListener("pagehide", flush);
  runtime.onMessage.addListener(statusListener);
  intervals.push(setInterval(flush, 1000));
})();
