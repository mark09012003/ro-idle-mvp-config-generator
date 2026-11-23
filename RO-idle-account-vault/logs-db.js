globalThis.VaultLogs = {
  defaultLimit: 10000,
  limits: [10000, 50000, 100000, 200000],
  open(upgradeVersion) {
    return new Promise((resolve, reject) => {
      const request = upgradeVersion === undefined
        ? indexedDB.open(this.databaseName ?? "ro-vault-logs")
        : indexedDB.open(this.databaseName ?? "ro-vault-logs", upgradeVersion);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
        if (!db.objectStoreNames.contains("mvpBattles")) {
          db.createObjectStore("mvpBattles", {keyPath: "id"}).createIndex("characterKey", "characterKey");
        }
        if (!db.objectStoreNames.contains("mvpArchive")) db.createObjectStore("mvpArchive", {keyPath: "id"});
        if (!db.objectStoreNames.contains("mvpArchiveRows")) db.createObjectStore("mvpArchiveRows");
        const store = db.objectStoreNames.contains("logs")
          ? request.transaction.objectStore("logs")
          : db.createObjectStore("logs", {keyPath: "id"});
        if (!store.indexNames.contains("receivedAt")) store.createIndex("receivedAt", "receivedAt");
        const needsMigration = !store.indexNames.contains("eventAt") || !store.indexNames.contains("characterKey");
        if (!store.indexNames.contains("eventAt")) store.createIndex("eventAt", "eventAt");
        if (!store.indexNames.contains("characterKey")) store.createIndex("characterKey", "characterKey");
        if (!store.indexNames.contains("characterReceivedAt")) store.createIndex("characterReceivedAt", ["characterKey", "receivedAt"]);
        if (!store.indexNames.contains("characterEventAt")) store.createIndex("characterEventAt", ["characterKey", "eventAt"]);
        if (!store.indexNames.contains("mvpQueued")) store.createIndex("mvpQueued", "mvpQueued");
        if (needsMigration) {
          const migration = store.openCursor();
          migration.onsuccess = () => {
            const cursor = migration.result;
            if (!cursor) return;
            const row = cursor.value;
            if (row.kind === "聊天文字" || (row.kind === "事件 JSON" && row.event !== "events")) {
              cursor.delete();
            } else {
              row.eventAt = row.eventAt ?? row.data?.wallMs ?? row.wallMs ?? row.receivedAt;
              row.characterKey = this.characterKey(row);
              request.transaction.objectStore("settings").put({key:row.characterKey,characterId:row.characterId || "",character:row.character || "",account:row.account || ""}, "character:" + row.characterKey);
              cursor.update(row);
            }
            cursor.continue();
          };
        }
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error("資料庫正由舊分頁使用，請關閉舊的戰鬥紀錄分頁後重試。"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {db.close();return;}
        db.onversionchange = () => db.close();
        const hasStores = db.objectStoreNames.contains("logs") && db.objectStoreNames.contains("settings");
        const store = hasStores ? db.transaction("logs").objectStore("logs") : null;
        if (!hasStores || !db.objectStoreNames.contains("mvpArchive") || !db.objectStoreNames.contains("mvpArchiveRows") || !db.objectStoreNames.contains("mvpBattles") || !store.indexNames.contains("characterEventAt") || !store.indexNames.contains("mvpQueued") || !store.indexNames.contains("receivedAt") || !store.indexNames.contains("eventAt") || !store.indexNames.contains("characterKey") || !store.indexNames.contains("characterReceivedAt")) {
          const nextVersion = db.version + 1;
          db.close();
          this.open(nextVersion).then(resolve, reject);
          return;
        }
        resolve(db);
      };
      request.onerror = () => {
        if (request.error?.name === "VersionError" && upgradeVersion !== undefined) {
          this.open().then(resolve, reject);
          return;
        }
        reject(request.error);
      };
    });
  },
  characterKey(row) {
    if (row.characterId != null && String(row.characterId)) return "id:" + row.characterId;
    if (row.character) return "name:" + encodeURIComponent(row.account || "") + ":" + encodeURIComponent(row.character);
    return "unknown";
  },
  async registerCharacters(characters) {
    const db = await this.open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["logs", "settings", "mvpBattles"], "readwrite");
        const settings = transaction.objectStore("settings");
        const catalog = new Map(characters.map(character => [this.characterKey(character), character]));
        const fingerprint = JSON.stringify([...catalog.entries()]);
        const previous = settings.get("catalogFingerprint");
        previous.onsuccess = () => {
          if (previous.result === fingerprint) return;
          const names = new Map();
          for (const [key, character] of catalog) {
            settings.put({...character, key}, "character:" + key);
            const same = characters.filter(item => item.character === character.character);
            if (same.length === 1) names.set(character.character, {...character, key});
          }
          let moved = false;
          const request = transaction.objectStore("logs").openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              if (moved) {settings.delete("mvpIndexState");transaction.objectStore("mvpBattles").clear();}
              return;
            }
            const row = cursor.value;
            const match = !row.characterId && names.get(row.character);
            if (match) {
              moved = true;
              const oldKey = row.characterKey;
              row.characterKey = match.key;row.characterId = String(match.characterId);
              row.account = row.account || match.account;
              cursor.update(row);
              if (oldKey !== match.key) settings.delete("character:" + oldKey);
            }
            cursor.continue();
          };
          settings.put(fingerprint, "catalogFingerprint");
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {db.close();}
  },
  async characters() {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(["logs", "settings"]);
        const settings = new Map();
        const counts = new Map();
        const settingCursor = transaction.objectStore("settings").openCursor();
        settingCursor.onsuccess = () => {
          const cursor = settingCursor.result;
          if (!cursor) return;
          settings.set(cursor.key, cursor.value);cursor.continue();
        };
        const logCursor = transaction.objectStore("logs").index("characterKey").openKeyCursor();
        logCursor.onsuccess = () => {
          const cursor = logCursor.result;
          if (!cursor) return;
          counts.set(cursor.key, (counts.get(cursor.key) || 0) + 1);cursor.continue();
        };
        transaction.oncomplete = () => resolve([...settings.entries()]
          .filter(([key]) => key.startsWith("character:"))
          .map(([key, character]) => ({...character, count: counts.get(character.key) || 0,
            enabled: settings.get("recording:" + character.key)?.enabled === true})));
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {db.close();}
  },
  async setRecording(key, enabled) {
    const db = await this.open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("settings", "readwrite");
        transaction.objectStore("settings").put({enabled, since: Date.now()}, "recording:" + key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {db.close();}
  },
  async deleteCharacter(key) {
    const db = await this.open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["logs", "settings", "mvpBattles"], "readwrite");
        transaction.objectStore("settings").put({enabled: false, since: Date.now()}, "recording:" + key);
        const summaries = transaction.objectStore("mvpBattles").index("characterKey").openCursor(key);
        summaries.onsuccess = () => {
          const cursor = summaries.result;
          if (cursor) {cursor.delete();cursor.continue();}
        };
        const settings = transaction.objectStore("settings");
        const current = settings.get("mvpIndexState");
        current.onsuccess = () => {
          const state = current.result;
          if (!state) return;
          for (const [id, battle] of state.pending) if (battle.characterKey === key) state.pending.delete(id);
          for (const [id, battle] of state.textPending ?? []) if (battle.characterKey === key) state.textPending.delete(id);
          settings.put(state, "mvpIndexState");
        };
        const request = transaction.objectStore("logs").index("characterKey").openCursor(key);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();cursor.continue();
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {db.close();}
  },

  async mvpIndexBatch() {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(["logs", "settings", "mvpBattles"], "readwrite");
        const logs = tx.objectStore("logs");
        const settings = tx.objectStore("settings");
        const summaries = tx.objectStore("mvpBattles");
        let more = false;
        tx.oncomplete = () => resolve(more);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("MVP 索引更新失敗"));
        const stateRequest = settings.get("mvpIndexState");
        stateRequest.onsuccess = () => {
          const prior = stateRequest.result;
          const state = prior?.revision === 2 ? prior
            : {revision: 2, checkpoint: null, complete: false, pending: new Map(), textPending: new Map()};
          if (prior && prior.revision !== 2) summaries.clear();
          const checkpoint = state.checkpoint;
          const range = checkpoint ? IDBKeyRange.lowerBound(checkpoint.time) : null;
          const request = state.complete ? logs.index("mvpQueued").openCursor()
            : logs.index("eventAt").openCursor(range);
          const records = [];
          const textRows = [];
          let scanned = 0;
          function finish() {
            for (const battle of CombatLogs.buildMvpIndex(records, state.pending)) summaries.put(battle);
            for (const battle of CombatLogs.indexMvpText(textRows, state.textPending)) summaries.put(battle);
            const expired = Date.now() - 24 * 3600 * 1000;
            if (state.complete) {
              for (const [key, battle] of state.pending) {
                if (battle.endedAt < expired) state.pending.delete(key);
              }
            }
            settings.put(state, "mvpIndexState");
          }
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              if (!state.complete) {state.complete = true; more = true;}
              else if (!scanned) return;
              finish();
              return;
            }
            if (!state.complete && checkpoint && cursor.key === checkpoint.time &&
                indexedDB.cmp(cursor.primaryKey, checkpoint.id) <= 0) {
              cursor.continue();
              return;
            }
            const row = cursor.value;
            if (state.complete || row.mvpQueued === undefined) {
              const body = row.data?.body;
              if (row.kind === "遊戲文字" || ["death", "stop", "mapChange", "teleport", "arrive"].includes(body?.type)) {
                textRows.push(row);
              }
              if (row.event === "events" && body && Number.isFinite(row.data.seq)) {
                records.push({
                  characterKey: row.characterKey, characterId: row.characterId,
                  character: row.character, account: row.account, seq: row.data.seq,
                  eventAt: CombatLogs.eventTime(row), monsterName: body.monsterName,
                  won: body.won, monsterId: body.monsterId, uid: body.uid, type: body.type,
                });
              } else if (row.kind === "遊戲文字" && CombatLogs.marker(row) && !CombatLogs.mvpText(row)?.result) {
                summaries.put({id: "notice:" + row.id, characterKey: row.characterKey,
                  characterId: row.characterId, character: row.character, account: row.account,
                  notice: true, seq: row.seq, startedAt: CombatLogs.eventTime(row), monsterName: row.text});
              }
              if (state.complete) {
                delete row.mvpQueued;
                cursor.update(row);
              }
            }
            if (!state.complete) state.checkpoint = {time: cursor.key, id: cursor.primaryKey};
            if (++scanned >= 400) {more = true;finish();return;}
            cursor.continue();
          };
        };
      });
    } finally {db.close();}
  },

  async refreshMvpIndex() {
    if (!this.mvpIndexWork) {
      this.mvpIndexWork = (async () => {
        while (await this.mvpIndexBatch()) await new Promise(resolve => setTimeout(resolve, 20));
      })().finally(() => {this.mvpIndexWork = null;});
    }
    return this.mvpIndexWork;
  },

  async indexedMvpBattles(characterKey, monsterNames = new Map()) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(["mvpBattles", "logs"]);
        const query = tx.objectStore("mvpBattles").index("characterKey").getAll(characterKey);
        const oldest = tx.objectStore("logs").index("eventAt").openKeyCursor();
        tx.oncomplete = () => {
          const minimum = oldest.result?.key;
          const retained = query.result.filter(item => minimum !== undefined &&
            (item.endedAt ?? item.startedAt) >= minimum);
          const battles = retained.filter(item => !item.notice);
          for (const battle of battles) {
            battle.monsterName ||= monsterNames.get(Number(battle.monsterId)) || "";
          }
          const notices = retained.filter(item => {
            if (!item.notice) return false;
            const end = item.endedAt ?? item.startedAt;
            const match = battles.find(battle =>
              (item.seq != null && battle.sequences.has(item.seq) && end >= battle.startedAt && end <= battle.endedAt) ||
              (item.textContext && battle.monsterName === item.monsterName && Math.abs(battle.endedAt - end) <= 5000));
            if (!match) return true;
            if (item.textContext) {
              match.startedAt = Math.min(match.startedAt, item.startedAt);
              match.endedAt = Math.max(match.endedAt, end);
              match.textContext = true;
            }
            return false;
          });
          resolve([...battles, ...notices]);
        };
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally {db.close();}
  },

  async stats(characterKey) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(["logs", "settings"]);
        const limit = transaction.objectStore("settings").get("limit");
        const store = transaction.objectStore("logs");
        const count = characterKey ? store.index("characterKey").count(characterKey) : store.count();
        const newest = characterKey
          ? store.index("characterReceivedAt").openCursor(IDBKeyRange.bound([characterKey, 0], [characterKey, Number.MAX_SAFE_INTEGER]), "prev")
          : store.index("receivedAt").openCursor(null, "prev");
        let latest = null;
        newest.onsuccess = () => {
          const cursor = newest.result;
          latest = count.result > 0 ? cursor?.value || null : null;
        };
        transaction.oncomplete = () => resolve({count: count.result, lastSavedAt: latest?.receivedAt || 0, limit: limit.result ?? this.defaultLimit});
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {db.close();}
  },
  prune(transaction) {
    const store = transaction.objectStore("logs");
    const limitRequest = transaction.objectStore("settings").get("limit");
    limitRequest.onsuccess = () => {
      const countRequest = store.count();
      countRequest.onsuccess = () => {
        let remaining = countRequest.result - (limitRequest.result ?? this.defaultLimit);
        if (remaining <= 0) return;
        const cursorRequest = store.index("eventAt").openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || remaining <= 0) return;
          cursor.delete();
          remaining--;
          cursor.continue();
        };
      };
    };
  },
  async setLimit(value) {
    if (!this.limits.includes(value)) throw new Error("不支援的紀錄上限");
    await this.save([], value);
    return this.stats();
  },
  async save(rows, nextLimit, accepted = false) {
    const db = await this.open();
    let saved = 0;
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["logs", "settings"], "readwrite");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("保存交易已取消"));
        try {
          if (nextLimit !== undefined) transaction.objectStore("settings").put(nextLimit, "limit");
          for (const row of rows) {
            if (row.kind !== "遊戲文字" && !(row.kind === "事件 JSON" && row.event === "events")) continue;
            const key = this.characterKey(row);
            const settings = transaction.objectStore("settings");
            settings.put({key, characterId:row.characterId || "", character:row.character || "", account:row.account || ""}, "character:" + key);
            const write = () => {
              transaction.objectStore("logs").put({...row, characterKey:key, eventAt:row.eventAt ?? row.data?.wallMs ?? row.wallMs ?? row.receivedAt,
                ...(CombatLogs.mvpIndexRelevant(row) ? {mvpQueued: row.receivedAt} : {})});
              saved++;
            };
            if (accepted) write();
            else {
              const recording = settings.get("recording:" + key);
              recording.onsuccess = () => {
                if (recording.result?.enabled && row.receivedAt >= recording.result.since) write();
              };
            }
          }
          if (!accepted) this.prune(transaction);
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
      if (saved && !accepted) this.refreshMvpIndex().catch(() => {});
      return saved;
    } finally {db.close();}
  }
};

(() => {
  const legacy = globalThis.VaultLogs;
  const shards = new Map();
  const migrations = new Map();
  const localLocks = new Map();

  function locked(key, task) {
    if (globalThis.navigator?.locks) return navigator.locks.request("ro-vault-logs:" + key, task);
    const pending = (localLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    localLocks.set(key, pending);
    return pending.finally(() => {if (localLocks.get(key) === pending) localLocks.delete(key);});
  }

  function shard(key) {
    if (!shards.has(key)) {
      const storage = Object.create(legacy);
      storage.databaseName = "ro-vault-logs:character:" + key;
      shards.set(key, storage);
    }
    return shards.get(key);
  }

  async function transaction(storage, stores, mode, setup) {
    const db = await storage.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("戰鬥紀錄交易失敗"));
        try {setup(tx, value => {result = value;});}
        catch (error) {tx.abort();reject(error);}
      });
    } finally {db.close();}
  }

  function setting(storage, key) {
    return transaction(storage, ["settings"], "readonly", (tx, result) => {
      const request = tx.objectStore("settings").get(key);
      request.onsuccess = () => result(request.result);
    });
  }

  function legacyPage(key, checkpoint) {
    return transaction(legacy, ["logs"], "readonly", (tx, result) => {
      const upper = checkpoint?.time ?? Number.MAX_SAFE_INTEGER;
      const range = IDBKeyRange.bound([key, 0], [key, upper]);
      const request = tx.objectStore("logs").index("characterReceivedAt").openCursor(range, "prev");
      const rows = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {result({rows, complete: true});return;}
        if (checkpoint && cursor.key[1] === checkpoint.time && indexedDB.cmp(cursor.primaryKey, checkpoint.id) >= 0) {
          cursor.continue();
          return;
        }
        rows.push(cursor.value);
        if (rows.length === 240) {
          result({rows, complete: false, time: cursor.key[1], id: cursor.primaryKey});
          return;
        }
        cursor.continue();
      };
    });
  }

  async function migrateBatch(key, firstOnly = false) {
    return locked(key, async () => {
      const storage = shard(key);
      const checkpoint = await setting(storage, "legacyMigration");
      if (checkpoint?.complete || (firstOnly && checkpoint)) return Boolean(checkpoint && !checkpoint.complete);
      const page = await legacyPage(key, checkpoint);
      const inheritedLimit = checkpoint ? undefined : await setting(legacy, "limit");
      await transaction(storage, ["logs", "settings"], "readwrite", tx => {
        const logs = tx.objectStore("logs");
        const settings = tx.objectStore("settings");
        if (inheritedLimit !== undefined) {
          const currentLimit = settings.get("limit");
          currentLimit.onsuccess = () => {
            if (currentLimit.result === undefined) settings.put(inheritedLimit, "limit");
          };
        }
        // Existing rows may have already arrived via live capture during migration.
        for (const row of page.rows) {
          const exists = logs.getKey(row.id);
          exists.onsuccess = () => {
            if (exists.result !== undefined) return;
            const {mvpQueued, ...copy} = row;
            logs.add(copy);
          };
        }
        settings.put({complete: page.complete, time: page.time, id: page.id}, "legacyMigration");
      });
      return !page.complete;
    });
  }

  function finishMigration(key) {
    if (!migrations.has(key)) {
      migrations.set(key, (async () => {
        while (await migrateBatch(key)) await new Promise(resolve => setTimeout(resolve, 20));
      })().finally(() => migrations.delete(key)));
    }
    return migrations.get(key);
  }

  function remember(rows) {
    return transaction(legacy, ["settings"], "readwrite", tx => {
      const settings = tx.objectStore("settings");
      for (const [key, row] of rows) {
        const request = settings.get("character:" + key);
        request.onsuccess = () => {
          const previous = request.result ?? {};
          const next = {key, characterId: row.characterId || previous.characterId || "",
            character: row.character || previous.character || "", account: row.account || previous.account || ""};
          if (next.characterId !== previous.characterId || next.character !== previous.character ||
              next.account !== previous.account) settings.put(next, "character:" + key);
        };
      }
    });
  }

  const logPresenceCache = new Map();
  function setLogPresence(key, present, onlyIfUnknown = false) {
    if (logPresenceCache.has(key) && (onlyIfUnknown || logPresenceCache.get(key) === present)) return Promise.resolve();
    return transaction(legacy, ["settings"], "readwrite", (tx, result) => {
      const settings = tx.objectStore("settings");
      const id = "logs-present:" + key;
      const request = settings.get(id);
      request.onsuccess = () => {
        let value = request.result;
        if ((!onlyIfUnknown || value === undefined) && value !== present) {
          settings.put(present, id);
          value = present;
        }
        result(value);
      };
    }).then(value => {logPresenceCache.set(key, value);});
  }

  async function checkLogPresence(character, databases) {
    if (character.mvpArchive?.count > 0) return true;
    if (character.hasLogs !== undefined) return character.hasLogs;
    const key = character.key;
    const oldCount = await transaction(legacy, ["logs"], "readonly", (tx, done) => {
      const request = tx.objectStore("logs").index("characterKey").count(key);
      request.onsuccess = () => done(request.result);
    });
    const existing = !databases || databases.has("ro-vault-logs:character:" + key);
    const present = oldCount > 0 || (existing && (await shard(key).stats(key)).count > 0);
    await setLogPresence(key, present, true);
    return present;
  }

  const archiveWork = new Map();
  const archiveTimers = new Map();
  const defaultMvpLimit = 20;
  let catalogNames;

  function archiveNames() {
    if (!catalogNames) {
      catalogNames = Promise.resolve().then(() => fetch("ro-catalog.json"))
        .then(response => response.ok ? response.json() : [])
        .then(maps => new Map(maps.flatMap(map => map.monsters.map(monster => [Number(monster.id), monster.name]))))
        .catch(() => new Map());
    }
    return catalogNames;
  }

  const archiveCutoverCache = new Map();
  function archiveCutover(storage) {
    const cacheKey = storage.databaseName ?? "ro-vault-logs";
    if (archiveCutoverCache.has(cacheKey)) return Promise.resolve(archiveCutoverCache.get(cacheKey));
    return transaction(storage, ["settings"], "readwrite", (tx, result) => {
      const settings = tx.objectStore("settings");
      const request = settings.get("mvpArchiveCutover");
      request.onsuccess = () => {
        const since = request.result ?? Date.now();
        if (request.result === undefined) settings.put(since, "mvpArchiveCutover");
        result(since);
      };
    }).then(since => {
      archiveCutoverCache.set(cacheKey, since);
      return since;
    });
  }

  function savedMvpArchive(storage) {
    return transaction(storage, ["mvpArchive"], "readonly", (tx, result) => {
      const request = tx.objectStore("mvpArchive").getAll();
      request.onsuccess = () => result(request.result);
    });
  }

  async function syncMvpArchive(key, overrideLimit) {
    const storage = shard(key);
    const [names, cutoff] = await Promise.all([archiveNames(), archiveCutover(storage)]);
    const limit = overrideLimit ?? (await setting(storage, "mvpArchiveLimit")) ?? defaultMvpLimit;
    const candidates = await storage.indexedMvpBattles(key, names);
    const saved = await savedMvpArchive(storage);
    const entries = new Map(saved.map(battle => [battle.id, battle]));
    const copies = new Map();
    for (const battle of candidates) {
      if (!battle.result || !Number.isFinite(battle.startedAt)) continue;
      const end = battle.endedAt ?? battle.startedAt;
      const previous = entries.get(battle.id) || [...entries.values()].find(old =>
        Boolean(old.notice) !== Boolean(battle.notice) && (
          (old.monsterName && battle.monsterName && old.monsterName === battle.monsterName && Math.abs(old.endedAt - end) <= 5000) ||
          (old.seq != null && battle.sequences?.has(old.seq)) || (battle.seq != null && old.sequences?.has(battle.seq))
        ));
      if (previous?.id === battle.id && previous.startedAt <= battle.startedAt && previous.endedAt >= end &&
          previous.monsterName === battle.monsterName && previous.result === battle.result) continue;
      const canonical = previous && !previous.notice && battle.notice ? previous : battle;
      const entry = {...canonical, startedAt: Math.min(previous?.startedAt ?? battle.startedAt, battle.startedAt),
        endedAt: Math.max(previous?.endedAt ?? end, end),
        textContext: Boolean(battle.textContext || previous?.textContext), archived: true,
        backfilled: previous?.backfilled ?? (end < cutoff)};
      if (previous) entries.delete(previous.id);
      entries.set(entry.id, entry);
      copies.set(entry.id, {entry, previousId: previous?.id});
    }
    const retained = [...entries.values()].sort((a,b) => b.endedAt - a.endedAt || a.id.localeCompare(b.id)).slice(0, limit);
    const keep = new Set(retained.map(entry => entry.id));
    const removed = saved.filter(entry => !keep.has(entry.id));
    if (removed.length || copies.size || overrideLimit !== undefined) {
      await transaction(storage, ["logs", "settings", "mvpArchive", "mvpArchiveRows"], "readwrite", tx => {
        const archives = tx.objectStore("mvpArchive");
        const details = tx.objectStore("mvpArchiveRows");
        const logs = tx.objectStore("logs").index("characterEventAt");
        if (overrideLimit !== undefined) tx.objectStore("settings").put(limit, "mvpArchiveLimit");
        const erase = () => {for (const entry of removed) {archives.delete(entry.id);details.delete(entry.id);}};
        let pending = retained.filter(entry => copies.has(entry.id)).length;
        if (!pending) erase();
        for (const entry of retained) {
          const copy = copies.get(entry.id);
          if (!copy) continue;
          const existing = copy.previousId ? details.get(copy.previousId) : null;
          const range = IDBKeyRange.bound([key, entry.startedAt], [key, entry.endedAt]);
          const recorded = logs.getAll(range);
          const commit = () => {
            if (recorded.readyState !== "done" || (existing && existing.readyState !== "done")) return;
            const rows = [...new Map([...(existing?.result ?? []), ...recorded.result].map(row => [row.id, row])).values()]
              .sort((a,b) => a.eventAt - b.eventAt || (a.seq ?? 0) - (b.seq ?? 0));
            details.put(rows, entry.id);
            archives.put(entry);
            if (--pending === 0) erase();
          };
          if (existing) existing.onsuccess = commit;
          recorded.onsuccess = commit;
        }
      });
    }
    const meta = {count: retained.length, backfilled: retained.filter(entry => entry.backfilled).length, limit};
    await transaction(legacy, ["settings"], "readwrite", tx => {
      const store = tx.objectStore("settings");
      const request = store.get("mvp-archive-meta:" + key);
      request.onsuccess = () => {
        if (JSON.stringify(request.result) !== JSON.stringify(meta)) store.put(meta, "mvp-archive-meta:" + key);
      };
    });
  }

  globalThis.VaultLogs = {
    async openCharacter(key, complete = false) {
      if (complete) await finishMigration(key);
      else await migrateBatch(key, true);
      return shard(key).open();
    },
    registerCharacters(characters) {
      return remember(characters.map(row => [legacy.characterKey(row), row]));
    },
    characters() {
      return transaction(legacy, ["settings"], "readonly", (tx, result) => {
        const settings = tx.objectStore("settings");
        const entries = new Map();
        const request = settings.openCursor(IDBKeyRange.bound("character:", "recording:\uffff"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {entries.set(cursor.key, cursor.value);cursor.continue();return;}
          result([...entries].filter(([key]) => key.startsWith("character:")).map(([, item]) => ({
            ...item, enabled: entries.get("recording:" + item.key)?.enabled === true,
            mvpArchive: entries.get("mvp-archive-meta:" + item.key),
            hasLogs: entries.get("logs-present:" + item.key),
          })));
        };
      });
    },
    async charactersWithLogStatus() {
      const characters = await this.characters();
      const unknown = characters.some(character => character.hasLogs === undefined && !character.mvpArchive?.count);
      const databases = unknown
        ? await indexedDB.databases?.().then(entries => new Set(entries.map(entry => entry.name))).catch(() => null)
        : null;
      return Promise.all(characters.map(async character => ({
        ...character, hasLogs: await checkLogPresence(character, databases),
      })));
    },
    setRecording(key, enabled) {return locked(key, () => legacy.setRecording(key, enabled));},
    async save(rows) {
      if (!rows.length) return 0;
      const groups = new Map();
      for (const row of rows) {
        const key = legacy.characterKey(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const counts = await Promise.all([...groups].map(([key, records]) => locked(key, async () => {
        const recording = await setting(legacy, "recording:" + key);
        if (!recording?.enabled) return 0;
        const accepted = records.filter(row => row.receivedAt >= recording.since);
        if (!accepted.length) return 0;
        await remember([[key, accepted.at(-1)]]);
        await archiveCutover(shard(key));
        const count = await shard(key).save(accepted, undefined, true);
        if (count) await setLogPresence(key, true);
        return count;
      }).then(count => {
        if (count) this.scheduleMvpIndex(key);
        return count;
      })));
      return counts.reduce((total, count) => total + count, 0);
    },
    async stats(key) {
      if (!key) return {count: 0, lastSavedAt: 0, limit: (await setting(legacy, "limit")) ?? legacy.defaultLimit};
      await migrateBatch(key, true);
      return shard(key).stats(key);
    },
    async setLimit(value, key) {
      await this.refreshMvpIndex(key);
      return locked(key, () => shard(key).setLimit(value));
    },
    async deleteCharacter(key) {
      return locked(key, async () => {
        await legacy.deleteCharacter(key);
        await shard(key).deleteCharacter(key);
        await transaction(shard(key), ["settings", "mvpArchive", "mvpArchiveRows"], "readwrite", tx => {
          tx.objectStore("settings").put({complete: true}, "legacyMigration");
          tx.objectStore("mvpArchive").clear();
          tx.objectStore("mvpArchiveRows").clear();
        });
        await transaction(legacy, ["settings"], "readwrite", tx => tx.objectStore("settings").delete("mvp-archive-meta:" + key));
        await setLogPresence(key, false);
      });
    },
    async refreshMvpIndex(key) {
      if (!key) return;
      clearTimeout(archiveTimers.get(key));
      archiveTimers.delete(key);
      if (!archiveWork.has(key)) {
        archiveWork.set(key, (async () => {
          await finishMigration(key);
          await locked(key, async () => {
            const storage = shard(key);
            await storage.refreshMvpIndex();
            await syncMvpArchive(key);
            await transaction(storage, ["logs", "settings"], "readwrite", tx => storage.prune(tx));
          });
        })().finally(() => archiveWork.delete(key)));
      }
      return archiveWork.get(key);
    },
    scheduleMvpIndex(key) {
      if (!key || archiveTimers.has(key)) return;
      archiveTimers.set(key, setTimeout(() => {
        archiveTimers.delete(key);
        this.refreshMvpIndex(key).catch(() => {});
      }, 5000));
    },
    mvpArchiveStatus(key) {
      return key ? setting(legacy, "mvp-archive-meta:" + key) : Promise.resolve(undefined);
    },
    async setMvpArchiveLimit(value, key) {
      if (![10, 20, 50, 100].includes(value) || !key) throw new Error("MVP 保存上限不正確");
      await this.refreshMvpIndex(key);
      await locked(key, () => syncMvpArchive(key, value));
    },
    async readMvpDetails(key, battle, relatedOnly, limit = 150, fromEnd = false) {
      if (!Number.isFinite(battle.startedAt)) return {rows: [], more: false};
      let archived;
      if (battle.archived) {
        archived = await transaction(shard(key), ["mvpArchiveRows"], "readonly", (tx, result) => {
          const request = tx.objectStore("mvpArchiveRows").get(battle.id);
          request.onsuccess = () => result(request.result);
        });
      }
      if (!archived) {
        const range = IDBKeyRange.bound([key, battle.startedAt], [key, battle.endedAt ?? battle.startedAt]);
        archived = await transaction(shard(key), ["logs"], "readonly", (tx, result) => {
          const request = tx.objectStore("logs").index("characterEventAt").getAll(range);
          request.onsuccess = () => result(request.result);
        });
      }
      const filtered = archived.filter(row => !relatedOnly || row.kind === "遊戲文字" || CombatLogs.directlyRelatedToMvp(row, battle));
      const rows = CombatLogs.dedupeRenderedEvents(filtered);
      return {rows: fromEnd ? rows.slice(-limit) : rows.slice(0, limit), more: rows.length > limit, total: rows.length};
    },
    async indexedMvpBattles(key, monsterNames = new Map()) {
      if (!key) return [];
      const battles = await savedMvpArchive(shard(key));
      for (const battle of battles) battle.monsterName ||= monsterNames.get(Number(battle.monsterId)) || "";
      return battles;
    },
  };
})();
