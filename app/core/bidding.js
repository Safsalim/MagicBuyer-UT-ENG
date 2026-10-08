import { ceilPrice, floorPrice, priceAbove, toInt } from "./prices";
import { parseRange } from "./ranges";

export const bidsOnly = (filter) => filter && filter.tradeMode === "bidOnly";
export const exactCardId = (filter) => filter.definitionId || (filter.selectedItem && filter.selectedItem.definitionId) || 0;

export const bidRulesForFilter = (filter, settings) => {
  const only = bidsOnly(filter);
  const window = parseRange(only ? filter.bidExpiresWithin : settings.bid.expiresWithin, "M");
  return {
    enabled: only || settings.bid.enabled,
    exact: only || settings.bid.exact,
    maxBid: floorPrice(filter.maxBid),
    windowSeconds: window && window.max > 0 ? window.max : 0,
  };
};

export const bidProblem = (filter, settings, { preview = false } = {}) => {
  if (bidsOnly(filter) && !preview && !exactCardId(filter)) return "Bids only requires an exact card version. Select a Test search result or enter its Exact version ID.";
  const rules = bidRulesForFilter(filter, settings);
  if (bidsOnly(filter) && !rules.maxBid) return "Enter a bid amount of at least 150 coins for Bids only.";
  if (rules.enabled && rules.maxBid && !rules.windowSeconds) return "Enter a positive auction ending window (e.g. 90S or 5M).";
  return "";
};

// A bid must satisfy the ending window and minimum increment without becoming Buy Now.
export const bidPriceForAuction = (auction, rules, expires = Number(auction && auction.expires)) => {
  if (!auction || auction.tradeOwner || !rules.enabled || !rules.maxBid || !rules.windowSeconds ||
    !Number.isFinite(expires) || expires <= 0 || expires > rules.windowSeconds) return 0;
  const current = toInt(auction.currentBid);
  const minimum = current ? priceAbove(current) : Math.max(150, ceilPrice(auction.startingBid));
  const price = rules.exact ? rules.maxBid : minimum;
  const bin = toInt(auction.buyNowPrice);
  return price >= minimum && price > current && price <= rules.maxBid && (!bin || price < bin) ? price : 0;
};
