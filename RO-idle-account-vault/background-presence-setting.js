(() => {
  if (globalThis.__roBackgroundPresenceBridge) return;
  globalThis.__roBackgroundPresenceBridge = true;
  function publish(enabled) {
    window.postMessage({source: "ro-vault:background-presence-setting", enabled}, location.origin);
  }
  chrome.storage.local.get({pointerActivityEnabled: true}).then(settings => publish(settings.pointerActivityEnabled)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pointerActivityEnabled) publish(changes.pointerActivityEnabled.newValue === true);
  });
})();
