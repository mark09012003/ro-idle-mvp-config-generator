(() => {
  if (window.__roBackgroundPresenceInstalled) return;
  window.__roBackgroundPresenceInstalled = true;
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  let enabled = false;

  function setEnabled(next) {
    if (enabled === next) return;
    enabled = next;
    if (enabled) {
      Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "visible"});
      Object.defineProperty(document, "hidden", {configurable: true, get: () => false});
    } else {
      if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
      else delete document.visibilityState;
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else delete document.hidden;
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source === "ro-vault:background-presence-setting") setEnabled(event.data.enabled === true);
  });
  setEnabled(false);
})();
