const popupBase = chrome.runtime.getURL("popup.html");

chrome.action.onClicked.addListener(async tab => {
  if (tab?.url?.startsWith(popupBase)) return;
  const url = new URL(popupBase);
  if (Number.isInteger(tab?.id)) url.searchParams.set("gameTab", String(tab.id));
  const windows = await chrome.windows.getAll({populate: true, windowTypes: ["popup"]});
  const existing = windows.find(candidate => candidate.tabs?.some(entry => entry.url === url.href));
  if (existing) {
    await chrome.windows.update(existing.id, {focused: true, state: "normal"});
    return;
  }
  await chrome.windows.create({
    url: url.href,
    type: "popup",
    width: 420,
    height: 720,
    focused: true,
  });
});
