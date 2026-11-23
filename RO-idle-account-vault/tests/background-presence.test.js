const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const listeners = new Map();
const documentObject = {};
Object.defineProperty(documentObject, "visibilityState", {configurable: true, get: () => "hidden"});
Object.defineProperty(documentObject, "hidden", {configurable: true, get: () => true});
documentObject.dispatchEvent = () => {};
const windowObject = {
  addEventListener(type, listener) {listeners.set(type, listener);},
};
const context = {
  window: windowObject,
  document: documentObject,
  location: {origin: "https://ro-idle.app"},
  Event: class Event {constructor(type) {this.type = type;}},
};
context.globalThis = context;
vm.runInNewContext(fs.readFileSync(require.resolve("../background-presence.js"), "utf8"), context);

assert.equal(documentObject.visibilityState, "hidden", "未開啟戰鬥紀錄時應保留原始可見狀態");
listeners.get("message")({
  source: windowObject,
  origin: "https://ro-idle.app",
  data: {source: "ro-vault:background-presence-setting", enabled: true},
});
assert.equal(documentObject.visibilityState, "visible");
assert.equal(documentObject.hidden, false);

listeners.get("message")({
  source: windowObject,
  origin: "https://ro-idle.app",
  data: {source: "ro-vault:background-presence-setting", enabled: false},
});
assert.equal(documentObject.visibilityState, "hidden", "關閉戰鬥紀錄後應恢復遊戲原本行為");
assert.equal(documentObject.hidden, true);
console.log("background presence tests passed");
