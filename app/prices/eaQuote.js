import { buildCriteria } from "../core/filters";
import { matchesItem } from "../core/itemTargets";
import * as market from "../core/market";
import { maxPrice, priceAbove } from "../core/prices";

// A truncated page proves >=3, never <3. Exhaust and confirm the winning tier.
export const discoverEaQuote = async (filter, { token, search = market.searchMarket, pageSize = market.marketPageSize(), budget = 20 } = {}) => {
  const tiers = [];
  for (let p = 150; p <= maxPrice(); p = priceAbove(p)) {
    tiers.push(p);
    if (p === maxPrice()) break;
  }
  let requests = 0;
  let failure = "request budget exhausted";
  let error = null;
  const scan = async (ceiling, exhaust = false) => {
    const found = new Map();
    for (let page = 1; requests < Math.min(20, budget); page += 1) {
      if (token && token.cancelled) { failure = "cancelled"; return null; }
      requests += 1;
      const result = await search(buildCriteria(filter, { maxBuy: ceiling, minBuy: 0, minBid: 0, maxBid: 0 }), page, token);
      if (!result.ok) { error = result.error; failure = error && error.label || "EA search failed"; return null; }
      if (token && token.cancelled) { failure = "cancelled"; return null; }
      for (const item of result.items) {
        const auction = market.auctionOf(item);
        if (!auction || auction.tradeOwner || !(auction.expires > 0) || !matchesItem(item, filter, { fromSearch: true })) continue;
        const bin = Number(auction.buyNowPrice) || 0;
        const id = String(auction.tradeId || "");
        if (id && id !== "0" && bin >= 150 && bin <= ceiling) {
          const old = found.get(id);
          if (old && old.price !== bin) { failure = "unstable auction prices"; return null; }
          found.set(id, { id, price: bin });
        }
      }
      const complete = result.items.length <= pageSize;
      if (complete || (!exhaust && found.size >= 3)) return { rows: Array.from(found.values()).sort((a, b) => a.price - b.price || a.id.localeCompare(b.id)), complete };
    }
    return null;
  };
  let low = 0;
  let high = tiers.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const sample = await scan(tiers[mid]);
    if (!sample) return { status: "unavailable", price: 0, reason: failure, requests, error };
    if (sample.rows.length >= 3) high = mid;
    else low = mid + 1;
  }
  const first = await scan(tiers[low], true);
  const second = first && first.rows.length >= 3 ? await scan(tiers[low], true) : null;
  const signature = (sample) => sample.rows.map((r) => `${r.id}:${r.price}`).join("|");
  if (!first || !second || !first.complete || !second.complete || signature(first) !== signature(second)) {
    return { status: "unavailable", price: 0, reason: first && first.rows.length < 3 ? "fewer than three listings" : second ? "market changed during discovery" : failure, requests, error };
  }
  return { status: "available", price: second.rows[2].price, source: "EA third-cheapest BIN", referenceIdentity: `exact:${filter.definitionId || filter.selectedItem.definitionId}`, fetchedAt: Date.now(), requests };
};
