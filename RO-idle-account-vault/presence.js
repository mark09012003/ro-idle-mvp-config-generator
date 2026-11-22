(() => {
  if (globalThis.__roVaultIdentityWatcher) return;
  globalThis.__roVaultIdentityWatcher = true;
  let last = "";
  const timer = setInterval(() => {
    const caption = document.querySelector(".xp-title .caption");
    const signature = JSON.stringify([location.href, caption ? caption.textContent.trim() : "", Boolean(document.querySelector('input[type="password"]'))]);
    if(signature === last) return;
    last = signature;
    try {
      chrome.runtime.sendMessage({type:"ro-vault:identity-changed"}).catch(()=>{});
    } catch(error) {clearInterval(timer);}
  }, 1000);
})();
