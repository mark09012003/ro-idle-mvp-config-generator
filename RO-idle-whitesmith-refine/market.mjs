const maxInventorySlots = 100;

function toWeight10(weight) {
  return Math.round(weight * 10);
}

export function isSkippableVendorError(error) {
  const status = error?.status;
  if (!Number.isInteger(status) || status < 400 || status >= 500 || status === 401 || status === 403) {
    return false;
  }
  const msg = String(error?.message ?? "");
  if (/切換角色|遊戲分頁|登入|權限/.test(msg)) return false;
  // Seller-side Zeny/space limits mention 賣家 / 攤主 / 對方; buyer-side ones should stop buying.
  const isSellerSide = /賣家|攤主|對方|攤位|商品|此攤|該攤/.test(msg);
  if (!isSellerSide && /Zeny\s*不足|金幣不足|餘額不足|負重|背包|空間不足|欄位不足|掛機|死亡|擺攤中/.test(msg)) {
    return false;
  }
  return true;
}

export function marketPlan(response, slots, buyer, criteria, weights = null, excludeVendorIds = null) {
  const {keyword = "", holes = "any", ceiling, quantity, itemId = null} = criteria;
  const term = String(keyword).trim().toLowerCase();
  const validHoles = holes === "any" || holes === "non-equip" || (Number.isInteger(holes) && holes >= 0);
  const exactItemId = itemId != null ? Number(itemId) : null;
  if ((!term && !(Number.isInteger(exactItemId) && exactItemId > 0)) || !validHoles ||
      !Number.isSafeInteger(ceiling) || ceiling < 1 ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
    throw new Error("請填寫道具名稱、篩選條件、單價上限及購買數量（1～10000）。");
  }

  const definitions = new Map((response.heldItems ?? []).map(def => [def.id, def]));
  const lines = response.shops.flatMap(shop => {
    if (shop.vendorId === buyer.id || excludeVendorIds?.has(shop.vendorId) || typeof shop.mapId !== "string" ||
        !Number.isSafeInteger(shop.vendorId)) return [];
    return shop.items.filter(item => {
      const def = definitions.get(item.itemId);
      const isEquipment = def ? def.category === "equipment" : Object.hasOwn(slots ?? {}, item.itemId);
      const cardSlots = isEquipment ? (def ? def.cardSlots ?? 0 : slots[item.itemId]) : null;
      const matchesTarget = exactItemId != null
        ? item.itemId === exactItemId
        : item.name.toLowerCase().includes(term) && (
          holes === "any"
            ? true
            : holes === "non-equip"
              ? !isEquipment
              : isEquipment && cardSlots === holes
        );
      return matchesTarget &&
        Number.isSafeInteger(item.price) && item.price > 0 && item.price <= ceiling &&
        Number.isSafeInteger(item.qty) && item.qty > 0 && Number.isSafeInteger(item.cartUid);
    }).map(item => {
      const def = definitions.get(item.itemId);
      const isEquipment = def ? def.category === "equipment" : Object.hasOwn(slots ?? {}, item.itemId);
      const cardSlots = isEquipment ? (def ? def.cardSlots ?? 0 : slots[item.itemId]) : null;
      const rawWeight = Number.isFinite(def?.weight) ? def.weight : weights?.[item.itemId];
      const unitWeight = Number.isFinite(rawWeight) && rawWeight >= 0 ? rawWeight : null;
      return {
        vendorId: shop.vendorId,
        seller: shop.vendorName,
        openedAt: shop.openedAt,
        mapId: shop.mapId,
        item,
        isEquipment,
        cardSlots,
        unitWeight,
      };
    });
  }).sort((a, b) => a.item.price - b.item.price);

  const orders = [];
  const seen = new Set();
  let count = 0;
  let total = 0;
  const local = lines.filter(line => line.mapId === buyer.mapId);
  for (const line of local) {
    const key = `${line.vendorId}:${line.item.cartUid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const qty = Math.min(quantity - count, line.item.qty, Math.floor((buyer.zeny - total) / line.item.price));
    if (qty < 1) break;
    orders.push({...line, qty});
    count += qty;
    total += line.item.price * qty;
  }
  return {orders, count, total, localMatches: local.length, remote: lines.filter(line => line.mapId !== buyer.mapId)};
}

export function groupVendorOrders(orders) {
  const groups = [];
  const byVendor = new Map();
  for (const order of orders) {
    let group = byVendor.get(order.vendorId);
    if (!group) {
      group = {vendorId: order.vendorId, seller: order.seller, orders: []};
      byVendor.set(order.vendorId, group);
      groups.push(group);
    }
    group.orders.push(order);
  }
  return groups;
}

export function takeVendorBatch(queue, snapshot, autoStore) {
  if (!queue.length) return [];
  if (!autoStore) {
    return queue.splice(0, queue.length);
  }
  const weight = snapshot?.weight;
  const weightMax = snapshot?.derived?.weightMax;
  const hasWeight = Number.isFinite(weight) && Number.isFinite(weightMax) && weightMax > 0;
  const weight10 = hasWeight ? toWeight10(weight) : 0;
  const weightMax10 = hasWeight ? toWeight10(weightMax) : Infinity;
  const freeWeight10 = hasWeight ? Math.max(0, weightMax10 - weight10) : Infinity;
  const halfWeight10 = hasWeight ? Math.floor(weightMax10 / 2) : Infinity;
  const freeSlots = Math.max(0, maxInventorySlots - (snapshot?.inventory?.length ?? 0));

  const hasUnlockedStack = new Set();
  for (const inv of snapshot?.inventory ?? []) {
    if (!inv.locked && inv.refine == null && !(inv.cards?.length) && !inv.forged) {
      hasUnlockedStack.add(inv.itemId);
    }
  }

  const batch = [];
  const newStackIds = new Set();
  let usedWeight10 = 0;
  let usedSlots = 0;
  let crossedHalf = hasWeight ? weight10 * 2 > weightMax10 : false;

  while (queue.length) {
    const head = queue[0];
    const isEquip = head.isEquipment !== false && (head.isEquipment === true || head.cardSlots != null);
    const needsNewStackSlot = !isEquip && !hasUnlockedStack.has(head.item.itemId) && !newStackIds.has(head.item.itemId);
    const minSlotNeeded = isEquip ? 1 : (needsNewStackSlot ? 1 : 0);
    if (usedSlots + minSlotNeeded > freeSlots) break;

    const u10 = Number.isFinite(head.unitWeight) && head.unitWeight > 0 ? toWeight10(head.unitWeight) : 0;
    if (!hasWeight || u10 === 0) {
      if (head.unitWeight == null && batch.length > 0) break;
      const takeQty = isEquip ? Math.min(head.qty, freeSlots - usedSlots) : head.qty;
      if (takeQty < 1) break;
      batch.push({...head, qty: takeQty});
      usedSlots += isEquip ? takeQty : (needsNewStackSlot ? 1 : 0);
      if (needsNewStackSlot) newStackIds.add(head.item.itemId);
      if (takeQty === head.qty) queue.shift();
      else queue[0] = {...head, qty: head.qty - takeQty};
      if (head.unitWeight == null) break;
      continue;
    }

    const remFree10 = freeWeight10 - usedWeight10;
    const maxByWeight = Math.floor(remFree10 / u10);
    const maxBySlots = isEquip ? (freeSlots - usedSlots) : head.qty;
    const maxFit = Math.min(head.qty, maxByWeight, maxBySlots);
    if (maxFit < 1) break;

    let takeQty = maxFit;
    if (!crossedHalf) {
      const curTotal10 = weight10 + usedWeight10;
      const toCrossHalf = curTotal10 > halfWeight10 ? 1 : Math.floor((halfWeight10 - curTotal10) / u10) + 1;
      takeQty = Math.min(maxFit, toCrossHalf);
    }

    batch.push({...head, qty: takeQty});
    usedWeight10 += u10 * takeQty;
    usedSlots += isEquip ? takeQty : (needsNewStackSlot ? 1 : 0);
    if (needsNewStackSlot) newStackIds.add(head.item.itemId);
    if (takeQty === head.qty) queue.shift();
    else queue[0] = {...head, qty: head.qty - takeQty};

    if (!crossedHalf && (weight10 + usedWeight10) * 2 > weightMax10) {
      crossedHalf = true;
      break;
    }
  }
  return batch;
}

export function isOverHalfWeight(snapshot) {
  const weight = snapshot?.weight;
  const maxWeight = snapshot?.derived?.weightMax;
  if (Number.isFinite(weight) && Number.isFinite(maxWeight) && maxWeight > 0) {
    return weight * 2 > maxWeight;
  }
  const percent = snapshot?.weightPercent;
  if (Number.isFinite(percent)) {
    return percent > 50;
  }
  throw new Error("無法確認角色目前負重。");
}

export function wouldExceedMaxWeight(snapshot, unitWeight, qty) {
  if (!Number.isFinite(unitWeight) || unitWeight <= 0 || !Number.isInteger(qty) || qty < 1) return false;
  const weight = snapshot?.weight;
  const maxWeight = snapshot?.derived?.weightMax;
  if (!Number.isFinite(weight) || !Number.isFinite(maxWeight) || maxWeight <= 0) return false;
  return weight + unitWeight * qty > maxWeight;
}

export function diffPurchasedBatch(beforeInventory, afterInventory, batchOrders) {
  if (!Array.isArray(beforeInventory) || !Array.isArray(afterInventory) || !Array.isArray(batchOrders) || !batchOrders.length) {
    throw new Error("無法核對剛買到的物品。");
  }
  const expectedByItemId = new Map();
  for (const order of batchOrders) {
    const itemId = order.item?.itemId ?? order.itemId;
    const qty = order.qty;
    if (!Number.isInteger(itemId) || !Number.isInteger(qty) || qty < 1) {
      throw new Error("無法核對剛買到的物品。");
    }
    expectedByItemId.set(itemId, (expectedByItemId.get(itemId) ?? 0) + qty);
  }
  const beforeByUid = new Map(beforeInventory.map(item => [item.uid, item]));
  const addedByItemId = new Map();
  const added = [];
  for (const item of afterInventory) {
    if (!expectedByItemId.has(item.itemId) || !Number.isSafeInteger(item.uid) || !Number.isInteger(item.qty) || item.qty < 1) {
      continue;
    }
    const previous = beforeByUid.get(item.uid);
    const delta = previous ? item.qty - previous.qty : item.qty;
    if (delta > 0) {
      added.push({uid: item.uid, qty: delta});
      addedByItemId.set(item.itemId, (addedByItemId.get(item.itemId) ?? 0) + delta);
    }
  }
  for (const [itemId, expectedQty] of expectedByItemId) {
    if ((addedByItemId.get(itemId) ?? 0) !== expectedQty) {
      throw new Error("無法確認剛買到的物品位置，已停止自動存倉。");
    }
  }
  return added.sort((a, b) => a.uid - b.uid);
}

export function diffPurchasedItems(beforeInventory, afterInventory, expectedItemId, expectedQty) {
  return diffPurchasedBatch(beforeInventory, afterInventory, [{itemId: expectedItemId, qty: expectedQty}]);
}

function isStackableItem(item, slots) {
  if (!item || item.refine != null || item.cards?.length || item.forged || item.broken || item.unidentified) {
    return false;
  }
  if (slots) return !Object.hasOwn(slots, item.itemId);
  return item.qty > 1;
}

export function planAutoDeposit(snapshot, storage, pendingEntries, slots = null) {
  if (snapshot?.activity === "dead") {
    throw new Error("角色目前處於死亡狀態，無法自動存倉。");
  }
  const fee = storage?.fees?.[snapshot?.mapId];
  if (!Number.isFinite(fee)) {
    throw new Error("目前城鎮沒有卡普拉倉庫服務，無法自動存倉。");
  }
  if (!Array.isArray(storage?.items) || !Number.isInteger(storage?.capacity)) {
    throw new Error("無法確認倉庫容量。");
  }
  const zeny = snapshot?.character?.zeny;
  if (!Number.isSafeInteger(zeny) || zeny < fee) {
    throw new Error(`Zeny 不足，無法支付倉庫費 ${fee} Zeny。`);
  }
  const equipped = new Set(Object.values(snapshot?.equipment ?? {}).filter(uid => uid != null));
  const inventory = new Map((snapshot?.inventory ?? []).map(item => [item.uid, item]));
  const existingStorageStacks = new Set(
    storage.items.filter(item => !item.locked && isStackableItem(item, slots)).map(item => item.itemId),
  );
  const newStorageStacks = new Set();
  const items = [];
  let totalQty = 0;
  let addedStorageSlots = 0;
  for (const [uid, qty] of pendingEntries) {
    if (!Number.isSafeInteger(uid) || !Number.isInteger(qty) || qty < 1) continue;
    const item = inventory.get(uid);
    if (!item || item.qty < qty || item.locked || equipped.has(uid)) {
      throw new Error("待存倉的剛購物品狀態已變更，請檢查背包。");
    }
    items.push({uid, qty});
    totalQty += qty;
    const stackable = isStackableItem(item, slots);
    if (stackable && (existingStorageStacks.has(item.itemId) || newStorageStacks.has(item.itemId))) {
      // Merges into an existing unlocked stack in storage.
    } else {
      addedStorageSlots++;
      if (stackable) newStorageStacks.add(item.itemId);
    }
    if (items.length >= 100) break;
  }
  if (!items.length) {
    return {items: [], fee: 0, totalQty: 0};
  }
  if (storage.items.length + addedStorageSlots > storage.capacity) {
    throw new Error("倉庫空間不足，無法自動存倉。");
  }
  return {items, fee, totalQty};
}

export function verifyDeposited(beforeInventory, afterInventory, depositedItems) {
  const before = new Map(beforeInventory.map(item => [item.uid, item.qty]));
  const after = new Map(afterInventory.map(item => [item.uid, item.qty]));
  for (const {uid, qty} of depositedItems) {
    const expected = (before.get(uid) ?? 0) - qty;
    const actual = after.get(uid) ?? 0;
    if (expected < 0 || actual !== expected) {
      throw new Error("伺服器未確認剛買到的物品已存入倉庫，請檢查背包與倉庫。");
    }
  }
}
