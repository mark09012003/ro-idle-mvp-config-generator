const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sent = [];
const windowListeners = new Map();
const runtimeListeners = [];
const windowObject = {
  addEventListener(type, listener) {windowListeners.set(type, listener);},
  removeEventListener() {},
};
const context = {
  chrome: {
    runtime: {
      getManifest() {return {};},
      sendMessage(message) {sent.push(message);return Promise.resolve({ok: true, saved: 1});},
      onMessage: {addListener(listener) {runtimeListeners.push(listener);}, removeListener() {}},
    },
  },
  CombatLogs: {dayKey() {return "2026-11-23";}, category() {return "combat";}},
  window: windowObject,
  location: {origin: "https://ro-idle.app"},
  document: {querySelector() {return {textContent: "RO放置仙境 - [測試角色]"};}, documentElement: null},
  sessionStorage: {getItem() {return "demo_user";}},
  crypto: {randomUUID() {return "uuid";}},
  queueMicrotask,
  setInterval() {return 1;},
  clearInterval() {},
  setTimeout() {return 1;},
  clearTimeout() {},
  console,
};
context.globalThis = context;
vm.runInNewContext(fs.readFileSync(require.resolve("../logs-capture.js"), "utf8"), context);

windowListeners.get("message")({
  source: windowObject,
  origin: "https://ro-idle.app",
  data: {
    source: "ro-vault-log-stream",
    type: "display",
    characterId: "123",
    text: "攻擊古埃及王",
    lineId: "line-1",
    seq: 1,
    wallMs: Date.now(),
  },
});

Promise.resolve().then(() => {
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "ro-vault:logs-received", "收到事件後應立即推送，不等待資料庫 flush");
  assert.equal(sent[0].rows[0].characterKey, "id:123");
  console.log("logs-capture live push tests passed");
});
