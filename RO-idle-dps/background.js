const opening = new Map();

async function openDps(tabId) {
  const url = new URL(chrome.runtime.getURL("popup.html"));
  url.searchParams.set("gameTab", String(tabId));
  const windows = await chrome.windows.getAll({populate:true, windowTypes:["popup"]});
  const existing = windows.find(window => window.tabs?.some(tab => tab.url === url.href));
  if (existing) {
    await chrome.windows.update(existing.id, {focused:true, state:"normal"});
    return;
  }
  await chrome.windows.create({url:url.href, type:"popup", width:490, height:740, focused:true});
}

chrome.action.onClicked.addListener(tab => {
  if (!Number.isSafeInteger(tab?.id) || opening.has(tab.id)) return;
  const task = openDps(tab.id)
    .catch(error => console.warn("無法開啟單怪 DPS 視窗", error))
    .finally(() => opening.delete(tab.id));
  opening.set(tab.id, task);
});
