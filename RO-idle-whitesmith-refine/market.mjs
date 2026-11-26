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
    }).map(item => ({vendorId: shop.vendorId, seller: shop.vendorName, openedAt: shop.openedAt, mapId: shop.mapId, item}));
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
