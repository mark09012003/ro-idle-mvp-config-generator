export function marketPlan(response, slots, buyer, criteria) {
  const {keyword, holes, ceiling, quantity} = criteria;
  const term = keyword.trim().toLowerCase();
  if (!term || !Number.isInteger(holes) || holes < 0 ||
      !Number.isSafeInteger(ceiling) || ceiling < 1 ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new Error("請填寫裝備名稱、指定洞數、單價上限及購買件數。");
  }

  const definitions = new Map((response.heldItems ?? []).map(def => [def.id, def]));
  const lines = response.shops.flatMap(shop => {
    if (shop.vendorId === buyer.id || typeof shop.mapId !== "string" ||
        !Number.isSafeInteger(shop.vendorId)) return [];
    return shop.items.filter(item => {
      const def = definitions.get(item.itemId);
      const cardSlots = def ? (def.category === "equipment" ? def.cardSlots ?? 0 : undefined) : slots[item.itemId];
      return cardSlots === holes && item.name.toLowerCase().includes(term) &&
        Number.isSafeInteger(item.price) && item.price > 0 && item.price <= ceiling &&
        Number.isSafeInteger(item.qty) && item.qty > 0 && Number.isSafeInteger(item.cartUid);
    }).map(item => {
      const def = definitions.get(item.itemId);
      const unitWeight = Number.isFinite(def?.weight) && def.weight > 0 ? def.weight : null;
      return {vendorId: shop.vendorId, seller: shop.vendorName, openedAt: shop.openedAt, mapId: shop.mapId, item, unitWeight};
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

export function diffPurchasedItems(beforeInventory, afterInventory, expectedItemId, expectedQty) {
  if (!Array.isArray(beforeInventory) || !Array.isArray(afterInventory) ||
      !Number.isInteger(expectedItemId) || !Number.isInteger(expectedQty) || expectedQty < 1) {
    throw new Error("無法核對剛買到的裝備。");
  }
  const beforeByUid = new Map(beforeInventory.map(item => [item.uid, item]));
  const added = [];
  let total = 0;
  for (const item of afterInventory) {
    if (item.itemId !== expectedItemId || !Number.isSafeInteger(item.uid) || !Number.isInteger(item.qty) || item.qty < 1) {
      continue;
    }
    const previous = beforeByUid.get(item.uid);
    const delta = previous ? item.qty - previous.qty : item.qty;
    if (delta > 0) {
      added.push({uid: item.uid, qty: delta});
      total += delta;
    }
  }
  if (total !== expectedQty) {
    throw new Error("無法確認剛買到的裝備位置，已停止自動存倉。");
  }
  return added.sort((a, b) => a.uid - b.uid);
}

export function planAutoDeposit(snapshot, storage, pendingEntries) {
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
  const items = [];
  let totalQty = 0;
  for (const [uid, qty] of pendingEntries) {
    if (!Number.isSafeInteger(uid) || !Number.isInteger(qty) || qty < 1) continue;
    const item = inventory.get(uid);
    if (!item || item.qty < qty || item.locked || equipped.has(uid)) {
      throw new Error("待存倉的剛購裝備狀態已變更，請檢查背包。");
    }
    items.push({uid, qty});
    totalQty += qty;
    if (items.length >= 100) break;
  }
  if (!items.length) {
    return {items: [], fee: 0, totalQty: 0};
  }
  if (storage.items.length + items.length > storage.capacity) {
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
      throw new Error("伺服器未確認剛買到的裝備已存入倉庫，請檢查背包與倉庫。");
    }
  }
}
