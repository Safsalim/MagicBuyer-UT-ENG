import { getFutShortYear } from "../app.constants";
import { loadPlayerCardCatalog } from "../services/datasource/playerCards";
import { bidsOnly } from "./bidding";
import { loadJson, saveJson } from "./storage";

const MAX_AGE = 30 * 60 * 1000;
const cache = new Map();
const pending = new Map();
const listeners = new Set();
const stored = loadJson("ratingCardLists", {}) || {};
const validCard = (card) => card && Number.isSafeInteger(card.definitionId) && card.definitionId > 0 &&
  Number.isInteger(card.baseId) && card.baseId > 0 && typeof card.name === "string" && Number.isInteger(card.rating) && card.rating > 0 && card.rating <= 99 &&
  typeof card.special === "boolean" && ["bronze", "silver", "gold"].includes(card.level) && Number.isInteger(card.rarity) && card.rarity >= 0;

export const usesRatingRotation = (filter) => !!(filter && filter.itemGroup === "players" &&
  !bidsOnly(filter) && !filter.player && !filter.definitionId && !filter.selectedItem && (filter.minRating || filter.maxRating));
export const ratingTargetsKey = (f) => JSON.stringify([getFutShortYear(), f.minRating || 1, f.maxRating || 99,
  f.level, f.rarities, f.nation, f.league, f.club, f.position, f.zone]);
export const onRatingTargetsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (key) => listeners.forEach((fn) => { try { fn(key); } catch (e) {} });

export const catalogCardMatches = (card, filter) => {
  if ((filter.minRating && card.rating < filter.minRating) || (filter.maxRating && card.rating > filter.maxRating)) return false;
  if (filter.level === "SP" ? !card.special : filter.level !== "any" && (card.special || card.level !== filter.level)) return false;
  if (filter.rarities.length && !filter.rarities.includes(card.rarity)) return false;
  if (["nation", "league", "club"].some((key) => filter[key] > 0 && card[key] !== filter[key])) return false;
  if (filter.position !== "any" && card.position !== filter.position) return false;
  const zones = { 130: ["RB", "RWB", "CB", "LB", "LWB"], 131: ["CDM", "CM", "CAM", "RM", "LM"], 132: ["RW", "LW", "CF", "ST"] };
  return !(filter.zone > 0) || !!(zones[filter.zone] && zones[filter.zone].includes(card.position));
};

export const ratingTargetsRecord = (filter) => {
  const key = ratingTargetsKey(filter);
  let record = cache.get(key);
  if (!record && stored[key] && stored[key].status === "ready" && Array.isArray(stored[key].cards) &&
    stored[key].cards.every(validCard) && Date.now() - stored[key].loadedAt <= MAX_AGE) {
    record = stored[key]; cache.set(key, record);
  }
  return record || { status: "idle", cards: [] };
};

export const loadRatingTargets = (filter, { force = false } = {}) => {
  const key = ratingTargetsKey(filter);
  if (pending.has(key)) return pending.get(key);
  const current = ratingTargetsRecord(filter);
  if (!force && current.status === "ready" && Date.now() - current.loadedAt <= MAX_AGE) return Promise.resolve(current);
  if (!force && current.status === "error" && Date.now() - current.loadedAt < 60000) return Promise.resolve(current);
  const snapshot = JSON.parse(JSON.stringify(filter));
  const task = (async () => {
    try {
      const rows = await loadPlayerCardCatalog({ minRating: snapshot.minRating || 1, maxRating: snapshot.maxRating || 99 });
      if (!Array.isArray(rows) || !rows.every(validCard)) throw new Error("The card catalogue contains incomplete card identities. Reload the card list.");
      const cards = rows.filter((row) => catalogCardMatches(row, snapshot))
        .sort((a, b) => a.name.localeCompare(b.name) || a.definitionId - b.definitionId);
      const record = { status: "ready", cards, loadedAt: Date.now(), source: "FUT.GG card catalogue" };
      cache.set(key, record); stored[key] = record;
      const recent = Object.entries(stored).filter(([, value]) => Date.now() - value.loadedAt <= MAX_AGE).slice(-20);
      saveJson("ratingCardLists", Object.fromEntries(recent));
      return record;
    } catch (e) {
      const record = { status: "error", cards: [], loadedAt: Date.now(), message: String(e.message || e) };
      cache.set(key, record); return record;
    } finally { pending.delete(key); emit(key); }
  })();
  pending.set(key, task); cache.set(key, { status: "loading", cards: [] }); emit(key);
  return task;
};

export const selectRatingTarget = async (ctx, filter) => {
  if (!usesRatingRotation(filter)) return { filter };
  const record = await loadRatingTargets(filter);
  if (ctx.token && ctx.token.cancelled) return { cancelled: true };
  if (record.status !== "ready") return { error: record.message };
  if (!record.cards.length) return { error: "No cards match this rating and card type. Adjust the rating or type." };
  if (!ctx.ratingCursors) ctx.ratingCursors = new Map();
  const key = ratingTargetsKey(filter);
  const previous = ctx.ratingCursors.get(filter.id);
  let index = 0;
  if (previous && previous.key === key) {
    index = previous.next % record.cards.length;
    if (previous.loadedAt !== record.loadedAt) {
      const lastIndex = record.cards.findIndex((entry) => entry.definitionId === previous.lastId);
      if (lastIndex >= 0) index = (lastIndex + 1) % record.cards.length;
    }
  }
  const card = record.cards[index];
  ctx.ratingCursors.set(filter.id, { key, loadedAt: record.loadedAt, next: index + 1, lastId: card.definitionId });
  return { card, index, total: record.cards.length, filter: Object.assign({}, filter, {
    definitionId: card.definitionId, player: { id: card.baseId, name: card.name, rating: card.rating }, selectedItem: null,
  }) };
};
