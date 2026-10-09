import { getFutShortYear } from "../../app.constants";
import { sendExternalRequest } from "../externalRequest";

// Public card metadata only. No prices are read or used by this catalogue.
const ORIGIN = "https://www.fut.gg";
const MAX_CARDS = 3000;
let lane = Promise.resolve();
let lastRead = 0;

const readPage = (url) => {
  const task = lane.then(async () => {
    const wait = Math.max(0, lastRead + 350 - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRead = Date.now();
    return new Promise((resolve, reject) => sendExternalRequest({
      method: "GET", url, timeout: 15000, anonymous: true,
      headers: { Accept: "application/json" },
      onload: (res) => {
        if (res.status !== 200) return reject(new Error(`Card catalogue unavailable (${res.status || "network error"}). Retry loading the card list.`));
        try { resolve(JSON.parse(res.responseText || res.response)); }
        catch (e) { reject(new Error("Card catalogue returned invalid data. Retry loading the card list.")); }
      },
    }));
  });
  lane = task.catch(() => {});
  return task;
};

export const normalizeCatalogCard = (row, year) => {
  if (!row || String(row.game) !== String(year) || !Number.isSafeInteger(row.eaId) || row.eaId <= 0 ||
    !Number.isInteger(row.overall) || row.overall < 1 || row.overall > 99 || typeof row.isSpecial !== "boolean" ||
    !Number.isInteger(row.rarityEaId) || row.rarityEaId < 0) throw new Error("Card catalogue is missing version, rating or type data. Retry loading the card list.");
  if (row.isSbc || row.isObjective || row.isEvolutionPlayerItem || row.isMyEvolutionsPlayerItem || row.loanDuration > 0) return null;
  return {
    definitionId: row.eaId, baseId: Number(row.basePlayerEaId) || (row.eaId & 0xffffff),
    name: String(row.cardName || row.commonName || `${row.firstName || ""} ${row.lastName || ""}`.trim() || `Card #${row.eaId}`),
    rating: row.overall, level: row.overall <= 64 ? "bronze" : row.overall <= 74 ? "silver" : "gold",
    special: row.isSpecial, rarity: row.rarityEaId,
    nation: Number(row.nation && row.nation.eaId) || -1,
    league: Number(row.league && row.league.eaId) || -1,
    club: Number(row.club && row.club.eaId) || -1,
    position: String(row.position || ""),
  };
};

export const loadPlayerCardCatalog = async ({ minRating, maxRating, year = getFutShortYear() }) => {
  const cards = new Map();
  let expected = null;
  let read = 0;
  for (let page = 1; page <= 100; page += 1) {
    const url = `${ORIGIN}/api/fut/players/v2/${encodeURIComponent(year)}/?overall__gte=${minRating}&overall__lte=${maxRating}&page=${page}`;
    const result = await readPage(url);
    if (!result || !Array.isArray(result.data) || !Number.isInteger(result.total) || result.total < 0 || result.currentPage !== page) {
      throw new Error("Card catalogue returned an incomplete page. Retry loading the card list.");
    }
    if (result.total > MAX_CARDS) throw new Error(`The rating range contains more than ${MAX_CARDS} cards. Narrow the rating range.`);
    if (expected == null) expected = result.total;
    if (expected !== result.total) throw new Error("The card catalogue changed while loading. Retry loading the card list.");
    read += result.data.length;
    for (const row of result.data) {
      if (row.overall < minRating || row.overall > maxRating) throw new Error("The card catalogue did not apply the rating filter. Retry loading the card list.");
      const card = normalizeCatalogCard(row, year);
      if (card) cards.set(card.definitionId, card);
    }
    if (result.next == null) {
      if (read !== expected) throw new Error("Card catalogue stopped before the full list was loaded. Retry loading the card list.");
      return Array.from(cards.values());
    }
    if (!result.data.length || result.next !== page + 1) throw new Error("Card catalogue pagination is incomplete. Retry loading the card list.");
  }
  throw new Error("Too many catalogue pages. Narrow the rating range.");
};
