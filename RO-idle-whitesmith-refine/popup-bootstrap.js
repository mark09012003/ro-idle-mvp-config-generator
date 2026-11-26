(() => {
  if (!globalThis.chrome?.runtime?.id) {
    document.getElementById("character").textContent = "請從 Chrome 工具列開啟擴充";
    document.getElementById("status").textContent = "先在 ro-idle.app 進入角色，再點工具列的擴充圖示。";
    return;
  }
  import("./popup.js").catch(error => {
    document.getElementById("character").textContent = "擴充載入失敗";
    document.getElementById("status").textContent =
      `請到 chrome://extensions 重新載入擴充。${error.message}`;
  });
})();
