import { futbinYear, fetchFutbinText } from "./futbinClient";
import { pricePlatform } from "./priceService";
import { parseManagerTable, parseChemistryTable } from "./nonPlayerParse";
import { discoverEaQuote } from "./eaQuote";
import { hasReferenceTarget, chemistryStyleTarget } from "../core/itemTargets";

const quotes = new Map();
const inflight = new Map();
const tables = new Map();
const listeners = new Set();
export const quoteKey = (filter) => JSON.stringify([futbinYear(), pricePlatform(), filter.itemGroup, filter.type, filter.category,
  filter.definitionId || (filter.selectedItem && filter.selectedItem.definitionId), filter.selectedItem, filter.level, filter.nation, filter.league,
  filter.club, filter.playStyle, filter.rarities, filter.authenticity, filter.primaryColor, filter.secondaryColor]);
export const currentItemQuote = (filter, maxAge = 5 * 60 * 1000) => {
  const quote = quotes.get(quoteKey(filter));
  return quote && quote.status === "available" && Date.now() - quote.fetchedAt <= maxAge ? quote : null;
};
export const itemQuoteRecord = (filter) => inflight.has(quoteKey(filter)) ? { status: "pending" } : quotes.get(quoteKey(filter)) || null;
export const onItemQuote = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const futbinQuote = async (filter, maxAge) => {
  const target = filter.selectedItem;
  const style = chemistryStyleTarget(filter);
  const isManager = filter.itemGroup === "managers" && target && target.nation > 0 && target.level !== "any" &&
    filter.league <= 0 && filter.club <= 0 && !filter.rarities.length && filter.authenticity === "any";
  const isChemistry = !!style;
  if (!isManager && !isChemistry) return null;
  const edition = futbinYear();
  const platform = pricePlatform();
  const url = isManager ? `https://www.futbin.com/${edition}/manager-prices` : "https://www.futbin.com/consumables";
  const cache = tables.get(url);
  let html = cache && Date.now() - cache.at <= maxAge ? cache.html : "";
  if (!html) {
    const result = await fetchFutbinText(url);
    if (!result.ok) return null;
    html = result.text;
    tables.set(url, { html, at: Date.now() });
  }
  const price = isManager ? parseManagerTable(html, { edition, platform, nation: target.nation, level: target.level }) :
    parseChemistryTable(html, { edition, platform, name: style.label });
  return price ? { status: "available", price, source: isManager ? "FUTBIN country / quality group" : "FUTBIN chemistry style",
    referenceIdentity: isManager ? `nation:${target.nation}:${target.level}` : `style:${style.label}`, fetchedAt: tables.get(url).at, url } : null;
};

export const requestItemQuote = (filter, { token, maxAge = 5 * 60 * 1000, force = false } = {}) => {
  if (!filter || filter.itemGroup === "players" || !hasReferenceTarget(filter)) return Promise.resolve({ status: "unavailable", price: 0, reason: "select a specific chemistry style or search result" });
  const key = quoteKey(filter);
  const cached = currentItemQuote(filter, maxAge);
  if (!force && cached) return Promise.resolve(cached);
  const record = quotes.get(key);
  if (!force && record && record.status === "unavailable" && Date.now() - record.fetchedAt < 60000) return Promise.resolve(record);
  if (inflight.has(key)) return inflight.get(key);
  // Freeze configuration before asynchronous work.
  const snapshot = JSON.parse(JSON.stringify(filter));
  const promise = (async () => {
    let quote = null;
    if (!token || !token.cancelled) quote = await futbinQuote(snapshot, force ? 0 : maxAge);
    if (token && token.cancelled) return { status: "unavailable", price: 0, reason: "cancelled" };
    if (!quote) quote = await discoverEaQuote(snapshot, { token });
    quote = Object.assign({ fetchedAt: Date.now(), edition: futbinYear(), platform: pricePlatform(), targetIdentity: key }, quote);
    if (!token || !token.cancelled) {
      quotes.set(key, quote);
    }
    return quote;
  })().catch((e) => {
    const quote = { status: "unavailable", price: 0, reason: String(e.message || e), fetchedAt: Date.now() };
    if (!token || !token.cancelled) {
      quotes.set(key, quote);
    }
    return quote;
  }).finally(() => {
    inflight.delete(key);
    const quote = quotes.get(key);
    if (quote) listeners.forEach((fn) => fn(key, quote));
  });
  inflight.set(key, promise);
  return promise;
};
