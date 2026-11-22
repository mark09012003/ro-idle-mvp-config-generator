
(() => {
  if (window.__roVaultLogStreamActive) return;
  window.__roVaultLogStreamActive = true;
  let characterId = "";
  function forward(message) {
    window.postMessage({source: "ro-vault-log-stream", ...message}, location.origin);
  }
  function eventReply(id, data, transport, lastEventId = "") {
    if (typeof data !== "string" || data.length > 2000000) return;
    characterId = id;
    forward({type: "events", characterId: id, data, transport, lastEventId});
  }
  const NativeEventSource = window.EventSource;
  window.EventSource = new Proxy(NativeEventSource, {
    construct(target, args, newTarget) {
      const stream = Reflect.construct(target, args, newTarget);
      try {
        const url = new URL(String(args[0]), location.href);
        const match = url.pathname.match(/^\/api\/characters\/([^/]+)\/stream$/);
        if (url.origin === location.origin && match) {
          characterId = match[1];
          stream.addEventListener("events", event => eventReply(match[1], event.data || "", "SSE", event.lastEventId || ""));
        }
      } catch (error) {}
      return stream;
    }
  });

  const nativeFetch = window.fetch;
  window.fetch = new Proxy(nativeFetch, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args);
      try {
        const url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : args[0].url, location.href);
        const match = url.pathname.match(/^\/api\/characters\/([^/]+)\/events$/);
        if (url.origin === location.origin && match) {
          characterId = match[1];
          result.then(response => {
            if (!response.ok) return;
            return response.clone().json().then(payload => {
              const events = Array.isArray(payload) ? payload : payload.events;
              if (Array.isArray(events)) eventReply(match[1], JSON.stringify(events), "fetch");
            });
          }).catch(() => {});
        }
      } catch (error) {}
      return result;
    }
  });

  // Observe the game's rendered battle lines, preserving its own text and categories.
  const seen = new WeakMap();
  function capture(node) {
    if (!(node instanceof Element)) return;
    const lines = node.matches(".log-line") ? [node] : node.querySelectorAll(".log-line");
    for (const line of lines) {
      const container = line.closest('.log-window[role="log"]');
      if (!container || container.hasAttribute("aria-label")) continue;
      const text = line.textContent.trim();
      if (!text || seen.get(line) === text) continue;
      seen.set(line, text);
      let gameLog;
      const fiberKey = Object.keys(line).find(key => key.startsWith("__reactFiber"));
      let fiber = fiberKey ? line[fiberKey] : null;
      for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return) {
        const candidate = fiber.memoizedProps?.l;
        if (candidate && typeof candidate.text === "string" && text.includes(candidate.text)) {
          gameLog = candidate;
          break;
        }
      }
      forward({
        type: "display",
        characterId,
        text,
        lineId: gameLog?.id ?? crypto.randomUUID(),
        seq: Number.isFinite(gameLog?.id) ? Math.floor(gameLog.id / 8) : null,
        category: gameLog?.cat,
        tone: gameLog?.tone,
        wallMs: gameLog?.wall
      });
    }
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData") capture(record.target.parentElement?.closest(".log-line"));
      else {
        capture(record.target instanceof Element ? record.target.closest(".log-line") : null);
        for (const node of record.addedNodes) capture(node);
      }
    }
  }).observe(document, {subtree: true, childList: true, characterData: true});
  if (document.documentElement) capture(document.documentElement);
})();
