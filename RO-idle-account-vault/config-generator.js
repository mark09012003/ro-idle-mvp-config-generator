"use strict";

const byId = id => document.getElementById(id);
const value = id => byId(id).value;
const checked = id => byId(id).checked;
const route = [];
let base;
let results = [];
let maps = [];
const selectedMaps = new Set();

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (tag === "button") node.className = "btn";
  return node;
}

function status(message, error = false) {
  byId("status").textContent = message;
  byId("status").dataset.error = error;
}

function clearPreview() {
  results = [];
  byId("preview").replaceChildren();
  byId("download").disabled = true;
  status("");
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return [hours && `${hours} 小時`, minutes && `${minutes} 分`, remainder && `${remainder} 秒`]
    .filter(Boolean).join(" ") || "0 秒";
}

function respawnLabel(monster) {
  if (!monster.respawn) return "時間未列出";
  const [base, variance] = monster.respawn;
  const earliest = formatDuration(base);
  return variance ? `${earliest}～${formatDuration(base + variance)}` : earliest;
}

function updateMapSelection() {
  byId("map-selection").textContent = `已勾選 ${selectedMaps.size} 張`;
  byId("add").disabled = !selectedMaps.size;
  byId("clear-maps").hidden = !selectedMaps.size;
}

function matchesMonsterFilter(monster, filter) {
  if (!filter || filter === "all-mvp") return monster.kind === "mvp";
  if (filter === "all-boss") return monster.kind === "boss";
  return monster.kind !== "normal" && String(monster.id) === filter;
}

function renderMapChoices() {
  const query = value("map-search").trim().toLowerCase();
  const filter = value("mvp-filter");
  const inRoute = new Set(route.map(row => row.map.id));
  const matching = maps.filter(map => {
    const bosses = map.monsters.filter(monster => monster.kind !== "normal");
    const matchesFilter = !filter || bosses.some(monster => matchesMonsterFilter(monster, filter));
    return matchesFilter && [map.name, map.id, map.region, ...bosses.map(monster => monster.name)]
      .some(text => text.toLowerCase().includes(query));
  });
  const regions = new Map();
  for (const map of matching) {
    if (!regions.has(map.region)) regions.set(map.region, []);
    regions.get(map.region).push(map);
  }
  const choices = document.createDocumentFragment();
  for (const [region, group] of regions) {
    const fieldset = element("fieldset", "");
    fieldset.className = "map-region";
    fieldset.append(element("legend", region), ...group.map(map => mapOption(map, inRoute, filter)));
    choices.append(fieldset);
  }
  byId("map-choices").replaceChildren(choices);
  if (!matching.length && maps.length) byId("map-choices").append(element("p", "沒有符合條件的地圖。"));
  updateMapSelection();
}

function mapOption(map, inRoute, filter) {
  const label = element("label", "");
  label.className = "check map-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = map.id;
  input.checked = inRoute.has(map.id) || selectedMaps.has(map.id);
  input.disabled = inRoute.has(map.id);
  input.onchange = () => {
    if (input.checked) selectedMaps.add(map.id);
    else selectedMaps.delete(map.id);
    updateMapSelection();
  };
  const content = element("span", "");
  content.append(element("strong", map.name), element("small", map.id));
  const targets = map.monsters.filter(monster => matchesMonsterFilter(monster, filter));
  for (const monster of targets) {
    const kind = monster.kind === "boss" ? "（Boss）" : "";
    content.append(element("span", `${monster.name}${kind} · 重生 ${respawnLabel(monster)}`));
  }
  if (!targets.length) content.append(element("small", "無 MVP"));
  label.append(input, content);
  return label;
}

async function loadCatalog() {
  try {
    const response = await fetch("ro-catalog.json");
    if (!response.ok) throw new Error();
    maps = await response.json();
    const byRegion = new Intl.Collator("zh-Hant");
    const byMapCode = new Intl.Collator("en", {numeric: true});
    maps.sort((a, b) => byRegion.compare(a.region, b.region) || byMapCode.compare(a.id, b.id));
    for (const [kind, label] of [["mvp", "MVP"], ["boss", "Boss"]]) {
      const monsters = new Map(maps.flatMap(map => map.monsters.filter(monster => monster.kind === kind)
        .map(monster => [monster.id, monster.name])));
      const group = document.createElement("optgroup");
      group.label = label;
      group.append(...[...monsters].sort((a, b) => a[1].localeCompare(b[1], "zh-Hant"))
        .map(([id, name]) => new Option(name, String(id))));
      byId("mvp-filter").append(group);
    }
    byId("mvp-filter").disabled = false;
    renderMapChoices();
    byId("catalog-status").textContent = `RO-idle 官方資料庫快照 · ${maps.length} 張地圖`;
  } catch {
    byId("catalog-status").textContent = "無法讀取地圖資料。請確認已完整解壓並重新載入擴充元件。";
  }
}

function ruleSelect(label, current, choices, onChange) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  select.replaceChildren(...choices.map(([key, name]) => new Option(name, key)));
  select.value = current;
  select.onchange = () => {
    onChange(select.value);
    clearPreview();
  };
  return select;
}

function monsterEditor(row) {
  const details = element("details", "");
  details.className = "route-monsters";
  details.open = Boolean(row.editorOpen);
  details.ontoggle = () => { row.editorOpen = details.open; };
  const monsters = row.map.monsters;
  details.append(element("summary", `怪物設定（${monsters.length} 種）`));
  for (const boss of row.map.monsters.filter(monster => monster.kind !== "normal")) {
    const label = element("label", "");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = row.targets.includes(boss.id);
    input.onchange = () => {
      row.targets = input.checked ? [...row.targets, boss.id] : row.targets.filter(id => id !== boss.id);
      clearPreview();
    };
    label.append(input, ` ${boss.name}（${boss.kind === "mvp" ? "MVP" : "Boss"}） · 重生 ${respawnLabel(boss)}`);
    details.append(label);
  }
  if (!monsters.length) return details;

  const table = element("table", "");
  const header = table.createTHead().insertRow();
  for (const title of ["怪物", "動作", "逃生"]) header.append(element("th", title));
  const body = table.createTBody();
  for (const monster of monsters) {
    const rule = row.smallRules[monster.id] ??= {};
    const line = body.insertRow();
    line.insertCell().textContent = monster.name;
    line.insertCell().append(ruleSelect(`${monster.name} 動作`, rule.action ?? "", [
      ["", "沿用所屬方案"], ["defend", "被打才還手"], ["attack", "主動打"], ["priority", "優先打"], ["lure", "引怪"],
    ], action => { rule.action = action || undefined; }));
    line.insertCell().append(ruleSelect(`${monster.name} 逃生`, rule.escape ?? "default", [
      ["default", "沿用所屬方案"], ["sight", "看到就逃"], ["attacked", "被打才逃"],
      ["afterTarget", "先打完目標再逃"], ["", "不逃"],
    ], escape => { rule.escape = escape === "default" ? undefined : escape; }));
  }
  details.append(table);
  return details;
}

function routeButton(text, action, disabled = false, label = text) {
  const button = element("button", text);
  button.type = "button";
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  button.onclick = () => {
    action();
    renderRoute();
    renderMapChoices();
    clearPreview();
  };
  return button;
}

function moveRow(index, destination) {
  [route[index], route[destination]] = [route[destination], route[index]];
}

function renderRoute() {
  byId("route-count").textContent = `${route.length} 張地圖`;
  byId("empty-route").hidden = Boolean(route.length);
  byId("go-preview").hidden = !route.length;
  byId("route").replaceChildren(...route.map((row, index) => {
    const item = element("li", "");
    const order = element("span", String(index + 1).padStart(2, "0"));
    order.className = "route-index";
    item.append(order);
    const content = element("div", "");
    content.className = "route-content";
    const title = element("strong", row.map.name);
    title.className = "route-map-name";
    content.append(title);
    if (index === 0) {
      const start = element("span", "起點");
      start.className = "route-start";
      title.append(start);
    }
    const details = monsterEditor(row);
    const targetSummary = element("p", "");
    const updateSummary = () => {
      const names = row.map.monsters.filter(monster => row.targets.includes(monster.id))
        .map(monster => `${monster.name}（${respawnLabel(monster)}）`);
      targetSummary.textContent = names.join("、") || "只巡迴此地圖";
    };
    updateSummary();
    details.addEventListener("change", updateSummary);
    targetSummary.className = "route-targets";
    const next = element("p", "");
    next.className = "route-next";
    if (route.length === 1) next.textContent = "留在此地圖";
    else {
      const nextIndex = (index + 1) % route.length;
      const destination = route[nextIndex].map.name;
      next.textContent = nextIndex === 0
        ? `↻ 回到 01 ${destination}`
        : `→ ${String(nextIndex + 1).padStart(2, "0")} ${destination}`;
    }
    content.append(next, targetSummary, details);
    item.append(content);
    const controls = element("div", "");
    controls.className = "route-buttons";
    controls.append(
      routeButton("上移", () => moveRow(index, index - 1), index === 0, `上移 ${row.map.name}`),
      routeButton("下移", () => moveRow(index, index + 1), index === route.length - 1, `下移 ${row.map.name}`),
      routeButton("移除", () => route.splice(index, 1), false, `移除 ${row.map.name}`),
    );
    item.append(controls);
    return item;
  }));
}

byId("map-search").oninput = renderMapChoices;
byId("mvp-filter").onchange = renderMapChoices;
byId("clear-maps").onclick = () => {
  selectedMaps.clear();
  renderMapChoices();
  byId("map-search").focus();
};
byId("add").onclick = () => {
  for (const id of selectedMaps) {
    const map = maps.find(map => map.id === id);
    route.push({map, targets: map.monsters.filter(monster => monster.kind === "mvp").map(monster => monster.id),
      smallRules: {}});
  }
  selectedMaps.clear();
  renderMapChoices();
  renderRoute();
  clearPreview();
};

byId("source").onchange = async event => {
  const file = event.target.files[0];
  base = undefined;
  clearPreview();
  byId("source-status").textContent = "目前直接產生部分設定。";
  byId("macros").value = "[]";
  byId("priority").value = "arrival";
  if (!file) return;
  try {
    const candidate = JSON.parse(await file.text());
    if (byId("source").files[0] !== file) return;
    RoConfigBuilder.validateBase(candidate);
    base = candidate;
    byId("macros").value = JSON.stringify(base.config.macros ?? [], null, 2);
    byId("priority").value = base.config.targets?.priority ?? "arrival";
    byId("source-status").textContent = [base.name, base.job].filter(Boolean).join(" · ") || file.name;
  } catch (error) {
    if (byId("source").files[0] === file) {
      byId("source").value = "";
      byId("source-status").textContent = error instanceof SyntaxError ? "這個檔案不是有效的 JSON。" : error.message;
    }
  }
};

let buffJobs = [];

async function loadBuffJobs() {
  try {
    const response = await fetch("buff-catalog.json");
    if (!response.ok) throw new Error();
    buffJobs = await response.json();
    byId("buffJob").append(...buffJobs.map(job => new Option(job.name, job.id)));
    byId("buffJob").disabled = false;
    byId("castBuffJob").append(...buffJobs.map(job => new Option(job.name, job.id)));
    byId("castBuffEnabled").disabled = false;
  } catch {
    byId("buff-status").textContent = "無法讀取 Buff 清單，請重新載入擴充元件。";
    byId("buff-status").hidden = false;
  }
}

byId("buffJob").onchange = () => {
  const job = buffJobs.find(job => job.id === value("buffJob"));
  byId("buff").replaceChildren(
    new Option(job ? "請選擇 Buff" : "請先選職業", ""),
    ...(job?.buffs ?? []).map(([id, name]) => new Option(name, id)),
  );
  byId("buff").disabled = !job;
  updateOptions();
  clearPreview();
};

function updateCastBuffSkills() {
  const job = buffJobs.find(candidate => candidate.id === value("castBuffJob"));
  const ally = value("castBuffTarget") === "ally";
  const previous = value("castBuffSkill");
  const skills = (job?.buffs ?? []).filter(([, , info]) =>
    ally ? info.scope !== "self" : info.scope !== "others");
  byId("castBuffSkill").replaceChildren(
    new Option(!job ? "請先選職業" : skills.length ? "請選技能" : "這個職業沒有可用技能", ""),
    ...skills.map(([id, name]) => new Option(name, id)),
  );
  if (skills.some(([id]) => id === previous)) byId("castBuffSkill").value = previous;
  updateCastBuffLevel();
  clearPreview();
}

function updateCastBuffLevel() {
  const skill = buffJobs.find(job => job.id === value("castBuffJob"))?.buffs
    .find(([id]) => id === value("castBuffSkill"));
  const level = byId("castBuffLevel");
  level.max = skill?.[2].maxLv ?? 10;
  if (Number(level.value) > Number(level.max)) level.value = level.max;
  clearPreview();
}

byId("castBuffJob").onchange = updateCastBuffSkills;
byId("castBuffTarget").onchange = updateCastBuffSkills;
byId("castBuffSkill").onchange = updateCastBuffLevel;

function updateOptions() {
  const casting = checked("castBuffEnabled");
  byId("cast-buff-fields").hidden = !casting;
  for (const id of ["castBuffJob", "castBuffSkill", "castBuffLevel", "castBuffCooldown"]) {
    byId(id).required = casting;
    byId(id).disabled = !casting;
  }
  const leader = value("mode") === "leader";
  byId("leader").hidden = !leader;
  byId("buff").required = leader && Boolean(value("buffJob"));
  const skill = buffJobs.find(job => job.id === value("buffJob"))?.buffs.find(([id]) => id === value("buff"));
  const canPrecast = leader && value("buffWhen") === "selfLacks" && skill && skill[2].scope !== "others";
  const routeBuffEnabled = Boolean(canPrecast && checked("buffBeforeMove"));
  byId("route-buff-options").hidden = !canPrecast;
  byId("route-buff-level-label").hidden = !routeBuffEnabled;
  const routeLevel = byId("routeBuffLevel");
  routeLevel.disabled = !routeBuffEnabled;
  routeLevel.required = routeBuffEnabled;
  routeLevel.max = skill?.[2].maxLv ?? 10;
  if (Number(routeLevel.value) > Number(routeLevel.max)) routeLevel.value = routeLevel.max;
  byId("follower").hidden = leader;
  byId("fly").disabled = !value("partyBelow");
  const wait = checked("waitForParty");
  byId("wait-options").hidden = !wait;
  byId("target-job-field").hidden = leader;
  const customJob = wait && !leader && value("targetJob") === "custom";
  byId("custom-job-field").hidden = !customJob;
  byId("customJob").required = customJob;
  for (const id of ["waitBelow", "waitSeconds", "waitCooldown"]) {
    byId(id).disabled = !wait;
    byId(id).required = wait;
  }
}

function download(urlData, filename, type) {
  const url = URL.createObjectURL(new Blob([urlData], {type}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function describeOperation(macro, mapNames, buffNames) {
  const condition = macro.cond ?? {};
  const clauses = [];
  if (condition.maps?.length) clauses.push(`在 ${condition.maps.map(id => mapNames.get(id) ?? id).join("、")}`);
  if (condition.engaged === false) clauses.push("未交戰");
  if (condition.inParty === true) clauses.push("已組隊");
  if (condition.partyBelow) clauses.push(`隊友少於 ${condition.partyBelow} 人`);
  for (const [key, label] of [["selfHas", "有"], ["selfLacks", "缺少"]]) {
    if (condition[key]?.length) clauses.push(label + condition[key].map(id => buffNames.get(id) ?? id).join("、"));
  }
  if (condition.allyJobs?.length) {
    const options = [...byId("targetJob").options];
    clauses.push("隊伍有 " + condition.allyJobs.map(id => options.find(option => option.value === id)?.text ?? id).join("、"));
  }
  if (condition.allyLacks?.length) {
    clauses.push("隊友缺少 " + condition.allyLacks.map(id => buffNames.get(id) ?? id).join("、"));
  }
  if (condition.doing?.length) {
    const states = {searching: "搜尋中", idle: "閒置"};
    clauses.push(condition.doing.map(state => states[state] ?? state).join("或"));
  }
  if (condition.spAbove != null) clauses.push(`SP 大於 ${condition.spAbove}`);
  const known = new Set(["doing", "spAbove", "allyLacks", "maps", "engaged", "inParty", "partyBelow", "selfHas", "selfLacks", "allyJobs"]);
  if (Object.keys(condition).some(key => !known.has(key))) clauses.push("另有自訂條件");
  const steps = macro.steps.map(step => {
    if (step.do === "wait") return `等待 ${step.sec} 秒`;
    if (step.do === "fly" || (step.do === "item" && step.itemId === 601)) return "使用蒼蠅翅膀";
    if (step.do === "butterfly") return "使用蝴蝶翅膀";
    if (step.do === "profile") return `切換配置 ${step.name}`;
    if (step.do === "map") return `前往 ${mapNames.get(step.mapId) ?? step.mapId}`;
    if (step.do === "skill") return `施放 ${buffNames.get(step.skill) ?? step.skill}${step.lv ? " Lv." + step.lv : ""}${step.target === "ally" ? " 給隊友" : step.target === "self" ? " 給自己" : ""}`;
    if (step.do === "item") return `使用道具 #${step.itemId}`;
    return step.name ? `${step.do}（${step.name}）` : step.do;
  });
  return `${clauses.join("、") || "無額外條件"} → ${steps.join(" → ")}（冷卻 ${macro.cooldownSec ?? 5} 秒）`;
}

function renderOperations() {
  const mapNames = new Map(maps.map(map => [map.id, map.name]));
  const buffNames = new Map([["AL_TELEPORT", "瞬間移動"], ...buffJobs.flatMap(job => job.buffs)]);
  const monsters = new Map(route.flatMap(row => row.map.monsters.map(monster => [monster.id, monster.name])));
  const fragment = document.createDocumentFragment();
  fragment.append(element("h3", "遊戲內執行順序"));
  for (const [index, {profile, segment, next}] of results.entries()) {
    const detail = element("details", "");
    detail.className = "operation-profile";
    detail.open = index === 0;
    detail.append(element("summary", `配置 ${profile.name} · ${segment[0].map.name}`));
    detail.append(element("p", [segment.map(row => row.map.name).join(" → "), next ? `接續配置 ${next}` : ""].filter(Boolean).join("；")));
    const whitelist = profile.config.targets.whitelist;
    if (whitelist.length) detail.append(element("p", `主動選怪白名單：${whitelist.map(id => monsters.get(id) ?? id).join("、")}`));
    const list = element("ol", "");
    for (const macro of profile.config.macros) {
      const item = element("li", "");
      item.append(element("strong", macro.name + (macro.enabled === false ? "（停用）" : "")),
        element("p", describeOperation(macro, mapNames, buffNames)));
      list.append(item);
    }
    if (list.children.length) detail.append(list);
    else detail.append(element("p", "留在這張地圖掛機。"));
    fragment.append(detail);
  }
  return fragment;
}

function renderPreview() {
  const table = element("table", "");
  const head = table.createTHead().insertRow();
  for (const label of ["配置", "起始 → 末張地圖", "接續配置", "怪物規則", "下載"]) head.append(element("th", label));
  const body = table.createTBody();
  for (const result of results) {
    const {segment, profile, next, file} = result;
    const row = body.insertRow();
    for (const text of [profile.name, `${segment[0].map.name} → ${segment.at(-1).map.name}`, next ?? "本配置", profile.config.monsterRules.length]) {
      row.insertCell().textContent = text;
    }
    const button = element("button", "JSON");
    button.type = "button";
    button.onclick = () => download(JSON.stringify(profile, null, 2) + "\n", file, "application/json");
    row.insertCell().append(button);
  }
  byId("preview").replaceChildren(table, renderOperations());
}

byId("generator").addEventListener("input", event => {
  if (["source", "map-search", "mvp-filter"].includes(event.target.id) || event.target.closest("#map-choices")) return;
  updateOptions();
  clearPreview();
});

byId("generator").onsubmit = event => {
  event.preventDefault();
  clearPreview();
  try {
    let macros;
    try { macros = JSON.parse(value("macros")); }
    catch { throw new Error("巨集欄位的 JSON 格式有誤。"); }
    if (!Array.isArray(macros) || macros.some(macro =>
      !Array.isArray(macro?.steps) || !macro.steps.length || macro.steps.length > 10 ||
      macro.steps.some(step => typeof step?.do !== "string"))) {
      throw new Error("請填入巨集陣列，每條巨集需有 1～10 個步驟。");
    }
    if (Number(value("maxLv")) && Number(value("minLv")) > Number(value("maxLv"))) throw new Error("最低等級不可高於最高等級。");
    if (value("mode") === "leader" && value("buffJob") && !value("buff")) {
      throw new Error("請選擇用來判斷換圖的 Buff。");
    }
    const castBuff = checked("castBuffEnabled") ? {
      skill: value("castBuffSkill"),
      name: byId("castBuffSkill").selectedOptions[0]?.text,
      target: value("castBuffTarget"),
      level: Number(value("castBuffLevel")),
      cooldown: Number(value("castBuffCooldown")),
    } : null;
    if (castBuff && castBuff.level > Number(byId("castBuffLevel").max)) {
      throw new Error("補放技能等級超過上限。");
    }
    const options = {
      macros,
      castBuff,
      buffBeforeMove: !byId("route-buff-options").hidden && checked("buffBeforeMove"),
      routeBuffLevel: value("routeBuffLevel"),
      waitForParty: checked("waitForParty"),
      targetJob: value("targetJob") === "custom" ? value("customJob") : value("targetJob"),
      waitBelow: value("waitBelow"),
      waitSeconds: value("waitSeconds"),
      waitCooldown: value("waitCooldown"),
      waitPosition: value("waitPosition"),
    };
    for (const id of ["mode", "buff", "buffWhen", "cooldown", "groupSize", "partyBelow", "departure", "targetEscape", "escape", "targetAction", "otherAction", "priority", "minLv", "maxLv"]) {
      options[id] = value(id);
    }
    for (const id of ["fly", "onlyMvp", "avoidAggressive"]) options[id] = checked(id);
    results = RoConfigBuilder.generate(base, route, options);
    renderPreview();
    byId("download").disabled = false;
    const instruction = results.length > 1 ? "請在遊戲中以預覽所示的名稱儲存每份配置，再從 01 開始。" : "";
    const warning = checked("avoidAggressive") || Number(value("maxLv")) || Number(value("minLv"))
      ? " 已啟用選怪篩選，請確認標的符合設定。" : "";
    const mergedBuff = options.buffBeforeMove && (route.length > 1 || options.waitForParty) && castBuff?.target === "self" && castBuff.skill === options.buff
      ? " 同技能的獨立自補已併入換圖巨集。" : "";
    const format = base ? "配置" : "部分設定（掛機地圖與目標、事件巨集）";
    status(`已產生 ${results.length} 份${format}。${instruction}${warning}${mergedBuff}`);
  } catch (error) {
    status(error.message, true);
  }
};

byId("download").onclick = () => {
  const files = Object.fromEntries(results.map(({file, profile}) => [file, fflate.strToU8(JSON.stringify(profile, null, 2) + "\n")]));
  download(fflate.zipSync(files), "RO-idle_MVP_route.zip", "application/zip");
};

const guideSteps = [
  ["route-section", "勾選地圖，按加入巡迴，再用上移／下移排順序。"],
  ["monster-section", "分別設定勾選的王和其他怪物怎麼逃。只想主動找指定的王時，可開啟白名單。"],
  ["switch-section", "選擇標的或非標的角色，再決定是否等待隊友。"],
  ["preview-section", "按產生預覽，檢查遊戲內執行順序，再下載 JSON 或 ZIP。"],
];
let guideIndex = 0;

function setGuide(active) {
  const form = byId("generator");
  form.toggleAttribute("data-guided", active);
  byId("guide-controls").hidden = !active;
  byId("start-guide").hidden = active;
  for (const section of form.querySelectorAll(":scope > section")) section.classList.remove("guide-current");
  if (!active) return;
  const [id, instruction] = guideSteps[guideIndex];
  const section = byId(id);
  section.classList.add("guide-current");
  const title = section.querySelector("h2");
  byId("guide-progress").textContent = `第 ${guideIndex + 1} 步／共 ${guideSteps.length} 步 · ${title.textContent}：${instruction}`;
  byId("guide-error").hidden = true;
  byId("guide-back").disabled = guideIndex === 0;
  byId("guide-next").hidden = guideIndex === guideSteps.length - 1;
  title.tabIndex = -1;
  title.focus({preventScroll: true});
  byId("guide-controls").scrollIntoView?.({block: "start"});
}

byId("start-guide").onclick = () => {
  guideIndex = 0;
  setGuide(true);
};
byId("exit-guide").onclick = () => {
  setGuide(false);
  byId("start-guide").focus();
};
byId("guide-back").onclick = () => {
  guideIndex--;
  setGuide(true);
};
byId("guide-next").onclick = () => {
  if (guideIndex === 0 && !route.length) {
    const error = byId("guide-error");
    error.textContent = "請先將至少一張地圖加入巡迴。";
    error.hidden = false;
    return;
  }
  guideIndex++;
  setGuide(true);
};

byId("generator").addEventListener("invalid", event => {
  if (!byId("generator").hasAttribute("data-guided")) return;
  const section = event.target.closest("section");
  const step = guideSteps.findIndex(([id]) => id === section?.id);
  if (step >= 0 && step !== guideIndex) {
    guideIndex = step;
    setGuide(true);
  }
}, true);

updateOptions();
loadCatalog();

loadBuffJobs();
