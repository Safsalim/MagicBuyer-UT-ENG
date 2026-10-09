import { sleep, withTimeout } from "./async";
import { KIND, isFatal } from "./errors";
import { durationSeconds, futbinSellPrice, prepareListing, sellModeFor, sellPercentFor, fixedSellPriceFor } from "./listing";
import { hasReferenceTarget, matchesItem, targetIdentity } from "./itemTargets";
import { normalizeFilter, filterHasTarget } from "./filters";
import { requestItemQuote } from "../prices/nonPlayerQuotes";
import { log } from "./logger";
import * as market from "./market";
import { floorPrice, formatCoins } from "./prices";
import { randomBetween } from "./ranges";
import { getSettings } from "./settings";
import { recordTransaction } from "./state";
import { currentPrice, requestPrice } from "../prices/priceService";

// Bulk listing of transfer list cards at the current FUTBIN price
// (percentage from the Sell tab): available cards and, optionally, unsold cards.

const USABLE = 10 * 60 * 1000;

const safeCall = (target, method) => {
  try {
    return !!(target && typeof target[method] === "function" && target[method]());
  } catch (e) {
    return false;
  }
};

const isPlayer = (item) => safeCall(item, "isPlayer");

// A card can be listed if it is neither selling nor sold; include unsold cards only when requested.
const listable = (item, includeExpired) => {
  if (!isPlayer(item)) {
    return false;
  }
  const auction = market.auctionOf(item);
  if (!auction || !auction.tradeId || String(auction.tradeId) === "0") {
    return true;
  }
  if (safeCall(auction, "isSold") || safeCall(auction, "isSelling")) {
    return false;
  }
  if (safeCall(auction, "isExpired")) {
    return includeExpired;
  }
  return !safeCall(auction, "isActiveTrade");
};

export const matchingListable = (item, filter, includeExpired = true) => {
  if (item.untradeable || item.tradable === false || item.tradeable === false || safeCall(item, "isUntradeable") || !matchesItem(item, filter)) return false;
  const auction = market.auctionOf(item);
  if (!auction || !auction.tradeId || String(auction.tradeId) === "0") return true;
  if (safeCall(auction, "isSold") || safeCall(auction, "isSelling") || safeCall(auction, "isActiveTrade") || auction.expires > 0) return false;
  return safeCall(auction, "isExpired") ? includeExpired : true;
};

export const matchingListingPrice = async (item, filter, sell, token) => {
  if (sellModeFor(filter, sell) === "fixed") return { price: fixedSellPriceFor(filter, sell), source: "Fixed price", fetchedAt: Date.now() };
  if (!hasReferenceTarget(filter)) return { price: 0, reason: "Broad filters require fixed prices" };
  if (filter.itemGroup !== "players") {
    const quoteFilter = normalizeFilter(Object.assign({}, filter, { selectedItem: targetIdentity(item), definitionId: Number(item.definitionId) }));
    const quote = await requestItemQuote(quoteFilter, { token, maxAge: 60000 });
    return Object.assign({}, quote, { reference: quote.price, price: quote.price ? futbinSellPrice(quote.price, sellPercentFor(filter, sell)).price : 0 });
  }
  const id = Number(item.definitionId);
  if (!currentPrice(id, 60000, "sell")) await withTimeout(requestPrice(id, { name: market.nameOf(item), rating: market.ratingOf(item) }), 25000);
  const reference = currentPrice(id, 60000, "sell");
  return { reference, price: reference ? futbinSellPrice(reference, sellPercentFor(filter, sell)).price : 0, source: "FUTBIN player", fetchedAt: Date.now() };
};

// A preview has no listing side effects. Its frozen filter/settings travel with every row.
export const previewMatchingItems = async ({ filter, token, items, expiredOnly = false, limit = Infinity, sell = getSettings().sell }) => {
  const snapshot = normalizeFilter(JSON.parse(JSON.stringify(filter)));
  if (!filterHasTarget(snapshot)) return { ok: false, error: { label: "Choose a specific item, subtype, or restrictive criterion first" }, rows: [] };
  const config = Object.assign({}, sell);
  const result = items ? { ok: true, items } : await market.fetchTransferList();
  if (!result.ok) return { ok: false, error: result.error, rows: [] };
  const rows = [];
  for (const item of result.items) {
    if (rows.length >= limit || token && token.cancelled) break;
    if (!matchingListable(item, snapshot) || expiredOnly && !safeCall(market.auctionOf(item), "isExpired")) continue;
    const quote = await matchingListingPrice(item, snapshot, config, token);
    if (quote.error && stopsTask(quote.error)) return { ok: false, error: quote.error, rows };
    const listing = quote.price ? await prepareListing(item, quote.price) : null;
    const reason = !quote.price ? quote.reason || "Reference unavailable" : !listing.valid ? "EA price limits prevent listing" : config.minProfit > 0 ? "Purchase cost unknown: cannot verify minimum profit" : "";
    rows.push({ item, itemId: String(item.id), name: market.nameOf(item), filter: snapshot, sell: config, quote,
      start: listing && listing.start || 0, buyNow: listing && listing.buyNow || 0, reason, previewedAt: Date.now() });
  }
  return { ok: true, rows, filter: snapshot, sell: config, previewedAt: Date.now() };
};

export const listMatchingPreview = async ({ preview, token, onProgress = () => {} }) => {
  const report = { total: preview.rows.length, listed: 0, skipped: 0, stopped: "" };
  const list = await market.fetchTransferList();
  if (!list.ok) return Object.assign(report, { stopped: list.error.label });
  const fresh = new Map(list.items.map((item) => [String(item.id), item]));
  for (const row of preview.rows) {
    if (token && token.cancelled) { report.stopped = "stop requested"; break; }
    const item = fresh.get(row.itemId);
    if (row.reason || !item || !matchingListable(item, row.filter)) { report.skipped += 1; continue; }
    // An accepted preview never silently changes the proposed price.
    if (sellModeFor(row.filter, row.sell) === "futbin" && Date.now() - row.quote.fetchedAt > 60000) {
      const quote = await matchingListingPrice(item, row.filter, row.sell, token);
      if (quote.error && stopsTask(quote.error)) { report.stopped = quote.error.label; break; }
      if (!quote.price || quote.price !== row.quote.price) { report.skipped += 1; continue; }
    }
    const listing = await prepareListing(item, row.buyNow);
    if (!listing.valid || listing.buyNow !== row.buyNow) { report.skipped += 1; continue; }
    if (token && token.cancelled) break;
    const result = await market.listOnMarket(item, listing.start, listing.buyNow, durationSeconds(row.sell.duration));
    if (result.ok) {
      report.listed += 1;
      recordTransaction({ type: "matching listing", name: row.name, price: listing.buyNow, filter: row.filter.name });
    } else {
      report.skipped += 1;
      if (stopsTask(result.error)) { report.stopped = result.error.label; break; }
    }
    onProgress(report);
  }
  return report;
};

const stopsTask = (error) =>
  error && (isFatal(error.kind) || error.kind === KIND.RATE || error.kind === KIND.BLOCKED || error.kind === KIND.FULL);

// This manual action uses one exact pair of prices, independent of target/sell pricing.
export const fixedTransferPrices = (price) => {
  const buyNow = Number(price);
  const start = buyNow - 100;
  const valid = Number.isSafeInteger(buyNow) && buyNow >= 250 &&
    floorPrice(buyNow) === buyNow && floorPrice(start) === start;
  return { buyNow, start, valid, reason: valid ? "" : "Enter a valid EA Buy Now price of at least 250 with a valid starting bid exactly 100 lower." };
};

const availableForFixedListing = (item) => {
  if (!item || item.untradeable || item.tradable === false || item.tradeable === false || safeCall(item, "isUntradeable")) return false;
  const auction = market.auctionOf(item);
  if (!auction) return true;
  if (safeCall(auction, "isSold") || safeCall(auction, "isSelling") || safeCall(auction, "isActiveTrade") ||
    safeCall(auction, "isExpired") || auction.expires > 0) return false;
  return !auction.tradeId || String(auction.tradeId) === "0";
};

export const listAvailableAtFixedPrice = async ({ price, token, onProgress = () => {} }) => {
  const prices = fixedTransferPrices(price);
  const report = { total: 0, listed: 0, skipped: 0, stopped: "", current: "" };
  if (!prices.valid) return Object.assign(report, { stopped: prices.reason });
  const cancelled = () => token && token.cancelled;
  if (cancelled()) return Object.assign(report, { stopped: "stop requested" });
  const duration = durationSeconds(getSettings().sell.duration);
  const list = await market.fetchTransferList();
  if (!list.ok) return Object.assign(report, { stopped: list.error.label });
  const ids = Array.from(new Set(list.items.filter(availableForFixedListing).map((item) => String(item.id))));
  report.total = ids.length;
  onProgress(report);
  for (const id of ids) {
    if (cancelled()) { report.stopped = "stop requested"; break; }
    // Refresh ownership/auction state before each listing, including items changed in another tab.
    const fresh = await market.fetchTransferList();
    if (!fresh.ok) { report.stopped = fresh.error.label; break; }
    const item = fresh.items.find((entry) => String(entry.id) === id);
    if (!availableForFixedListing(item)) { report.skipped += 1; onProgress(report); continue; }
    report.current = market.nameOf(item);
    onProgress(report);
    const limits = await market.fetchPriceLimits(item);
    if (cancelled()) { report.stopped = "stop requested"; break; }
    if (!availableForFixedListing(item) || !limits || (limits.min && prices.start < limits.min) ||
      (limits.max && prices.buyNow > limits.max)) {
      report.skipped += 1;
      log.warn(`${report.current}: exact listing prices unavailable within EA limits; skipped.`);
    } else {
      const result = await market.listOnMarket(item, prices.start, prices.buyNow, duration);
      if (result.ok) {
        report.listed += 1;
        recordTransaction({ type: "Fixed transfer listing", name: report.current, price: prices.buyNow });
      } else {
        report.skipped += 1;
        if (stopsTask(result.error)) { report.stopped = result.error.label; break; }
      }
    }
    onProgress(report);
  }
  report.current = "";
  if (cancelled() && !report.stopped) report.stopped = "stop requested";
  onProgress(report);
  return report;
};

export const listTransferAtFutbin = async ({ token, includeExpired = true, onProgress = () => {} }) => {
  const report = { total: 0, listed: 0, skipped: 0, noPrice: 0, stopped: "" };
  const list = await market.fetchTransferList();
  if (!list.ok) {
    report.stopped = `transfer list unavailable (${list.error.label})`;
    return report;
  }
  const items = list.items.filter((item) => listable(item, includeExpired));
  report.total = items.length;
  onProgress(report);
  const sell = getSettings().sell;
  const duration = durationSeconds(sell.duration);
  for (let index = 0; index < items.length; index += 1) {
    if (token.cancelled) {
      report.stopped = "stop requested";
      break;
    }
    const item = items[index];
    const name = market.nameOf(item);
    const id = Number(item.definitionId) || 0;
    report.current = name;
    onProgress(report);
    let reference = currentPrice(id, USABLE, "sell");
    if (!reference) {
      await withTimeout(requestPrice(id, { name, rating: market.ratingOf(item) }), 25000);
      reference = currentPrice(id, USABLE, "sell");
    }
    if (!reference) {
      report.noPrice += 1;
      report.skipped += 1;
      log.warn(`${name} : FUTBIN price unavailable, card left unchanged.`);
      continue;
    }
    const { price } = futbinSellPrice(reference, sell.futbinPercent);
    const listing = await prepareListing(item, price);
    const result = await market.listOnMarket(item, listing.start, listing.buyNow, duration);
    if (result.ok) {
      report.listed += 1;
      log.success(`Listed: ${name} at ${formatCoins(listing.buyNow)} (FUTBIN ${formatCoins(reference)}).`);
      recordTransaction({ type: "FUTBIN listing", name, rating: market.ratingOf(item), price: listing.buyNow });
    } else {
      report.skipped += 1;
      log.warn(`Listing ${name} rejected: ${result.error.label}.`);
      if (stopsTask(result.error)) {
        report.stopped = result.error.label;
        break;
      }
    }
    onProgress(report);
    if (index < items.length - 1) {
      await sleep(randomBetween(900, 1700), token);
    }
  }
  report.current = "";
  onProgress(report);
  return report;
};
