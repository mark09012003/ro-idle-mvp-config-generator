(() => {
  if (globalThis.__roBackgroundPresenceBridge) return;
  globalThis.__roBackgroundPresenceBridge = true;
  function publish(enabled) {
    window.postMessage({source: "ro-vault:background-presence-setting", enabled}, location.origin);
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "ro-vault:background-presence") publish(message.enabled === true);
  });
  chrome.runtime.sendMessage({type: "ro-vault:background-presence-status"})
    .then(result => publish(result?.enabled === true)).catch(() => publish(false));
})();
