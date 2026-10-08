import { pageGlobal, toPageArray } from "./page";
import { ceilPrice, floorPrice, priceAbove, toInt } from "./prices";
import { loadJson, loadLegacy, saveJson } from "./storage";
import { groupForType, hasExactTarget, switchGroupPatch } from "./itemTargets";

// A filter is a snipe target (player / criteria) with buy and sell prices.
export const DEFAULT_FILTER = {
  id: "",
  name: "New filter",
  enabled: true,
  type: "player",
  itemGroup: "players",
  selectedItem: null,
  authenticity: "any",
  primaryColor: -1,
  secondaryColor: -1,
  player: null, // { id: baseId, name, rating }
  definitionId: 0, // exact card version (optional)
  level: "any",
  rarities: [],
  position: "any",
  zone: -1,
  nation: -1,
  league: -1,
  club: -1,
  playStyle: -1,
  category: "any",
  ratingMode: "any", // any | exact | range; migrated from existing rating bounds
  minRating: 0,
  maxRating: 0,
  minBuy: 0,
  maxBuy: 0, // max buy price (BIN); optional absolute cap in FUTBIN mode
  buyBelow: false, // exclude the entered max buy price
  priceMode: "fixed", // fixed | futbin (buy at X% of the FUTBIN price)
  futbinPercent: 90,
  sellMode: "global", // global (Sell tab) | fixed | futbin
  sellPrice: 0,
  sellPercent: "",
  maxBid: 0,
  tradeMode: "standard", // standard | bidOnly (exact amount, exact version)
  bidExpiresWithin: "5M",
};

const STORAGE_KEY = "filters";
const listeners = new Set();

const makeId = () =>
  `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const normalizeFilter = (raw) => {
  const filter = Object.assign({}, DEFAULT_FILTER, raw || {});
  filter.id = filter.id || makeId();
  filter.name = String(filter.name || "").trim() || "Filter";
  filter.enabled = filter.enabled !== false;
  filter.type = filter.type || "player";
  filter.itemGroup = raw && raw.itemGroup || groupForType(filter.type);
  filter.selectedItem = raw && raw.selectedItem ? Object.assign({}, raw.selectedItem) : null;
  if (filter.itemGroup !== "players") {
    filter.player = null;
    filter.position = "any";
    filter.zone = -1;
    filter.minRating = filter.maxRating = 0;
    filter.ratingMode = "any";
    if (!raw || raw.futbinPercent == null) filter.futbinPercent = 80;
    if (!raw || raw.sellPercent == null) filter.sellPercent = "95";
  }
  const player = filter.player;
  filter.player =
    player && toInt(player.id)
      ? {
          id: toInt(player.id) & 0xffffff,
          name: String(player.name || "").trim(),
          rating: toInt(player.rating),
        }
      : null;
  filter.definitionId = toInt(filter.definitionId);
  filter.rarities = (Array.isArray(filter.rarities) ? filter.rarities : [])
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  // EA FC 27 zones: 130 defense, 131 midfield, 132 attack (-1 = any).
  ["nation", "league", "club", "playStyle", "zone", "primaryColor", "secondaryColor"].forEach((key) => {
    const n = parseInt(filter[key], 10);
    filter[key] = Number.isFinite(n) && n > 0 ? n : -1;
  });
  ["minRating", "maxRating", "minBuy", "maxBuy", "sellPrice", "maxBid"].forEach(
    (key) => {
      filter[key] = toInt(filter[key]);
    }
  );
  filter.minRating = Math.min(99, filter.minRating);
  filter.maxRating = Math.min(99, filter.maxRating);
  if (filter.itemGroup === "players") {
    const mode = raw && raw.ratingMode;
    filter.ratingMode = ["any", "exact", "range"].includes(mode) ? mode :
      filter.minRating && filter.minRating === filter.maxRating ? "exact" :
      filter.minRating || filter.maxRating ? "range" : "any";
    if (filter.ratingMode === "any") filter.minRating = filter.maxRating = 0;
    if (filter.ratingMode === "exact") filter.maxRating = filter.minRating;
  }
  filter.buyBelow = filter.buyBelow === true;
  filter.tradeMode = filter.tradeMode === "bidOnly" ? "bidOnly" : "standard";
  filter.bidExpiresWithin = String(filter.bidExpiresWithin == null ? "5M" : filter.bidExpiresWithin).trim();
  ["level", "position", "category"].forEach((key) => {
    filter[key] = filter[key] ? String(filter[key]) : "any";
  });
  filter.priceMode = filter.priceMode === "futbin" ? "futbin" : "fixed";
  const percent = parseFloat(filter.futbinPercent);
  filter.futbinPercent = Number.isFinite(percent) ? Math.min(150, Math.max(10, percent)) : 90;
  // Filters saved before sell modes: an entered sell price still takes priority.
  const wantedSell = raw && raw.sellMode;
  filter.sellMode = ["global", "fixed", "futbin"].includes(wantedSell)
    ? wantedSell
    : filter.sellPrice > 0
    ? "fixed"
    : "global";
  filter.sellPercent = String(filter.sellPercent || "").trim();
  return filter;
};

// Card whose FUTBIN price is the filter's reference (exact version, otherwise base card).
export const futbinKeyForFilter = (filter) =>
  (filter && filter.itemGroup === "players" && (filter.definitionId || (filter.player && filter.player.id))) || 0;

// Shared by search, purchase decisions and the displayed price/profit hints.
export const buyCeilingForFilter = (filter, reference = 0) => {
  if (filter.tradeMode === "bidOnly") return 0;
  const cap = floorPrice(toInt(filter.maxBuy) - (filter.buyBelow ? 1 : 0));
  if (filter.priceMode !== "futbin") return cap;
  if (!reference) return 0;
  const computed = floorPrice(reference * filter.futbinPercent / 100);
  return filter.maxBuy ? Math.min(cap, computed) : computed;
};

export const ratingProblem = (filter) => {
  if (!filter || filter.itemGroup !== "players") return "";
  if (filter.ratingMode === "exact" && !filter.minRating) return "Enter an exact player rating (1–99).";
  if (filter.minRating && filter.maxRating && filter.minRating > filter.maxRating) return "Min rating must be at or below Max rating.";
  return "";
};

// Migrate v4 filters (localStorage mbSavedFilters).
const migrateLegacy = () => {
  const legacy = loadLegacy("mbSavedFilters");
  if (!Array.isArray(legacy) || !legacy.length) {
    return [];
  }
  return legacy
    .map((entry) => {
      const criteria = (entry && entry.criteria) || {};
      const player = entry && entry.player;
      return normalizeFilter({
        name: entry && entry.name,
        player:
          player && (player.eaId || player.id)
            ? {
                id: player.eaId || player.id,
                name: player.name,
                rating: player.rating,
              }
            : null,
        level: criteria.level === "special" ? "SP" : criteria.level,
        position: criteria.position,
        nation: criteria.nation || criteria.nationality,
        league: criteria.league,
        club: criteria.club,
        minBuy: criteria.minBuy,
        maxBuy: criteria.maxBuy,
        maxBid: criteria.maxBid,
      });
    })
    .filter((filter) => filter.player || filter.maxBuy);
};

const load = () => {
  const stored = loadJson(STORAGE_KEY, null);
  if (stored && Array.isArray(stored.list)) {
    return {
      list: stored.list.map(normalizeFilter),
      activeId: stored.activeId || null,
      rotation: Object.assign(
        { enabled: false, every: 3, random: false },
        stored.rotation || {}
      ),
      lastEaSearch: stored.lastEaSearch || null,
    };
  }
  const migrated = migrateLegacy();
  const list = migrated.length ? migrated : [normalizeFilter({ name: "My filter" })];
  return {
    list,
    activeId: list[0].id,
    rotation: { enabled: false, every: 3, random: false },
    lastEaSearch: null,
  };
};

let data = load();

const emit = () => {
  saveJson(STORAGE_KEY, data);
  listeners.forEach((fn) => {
    try {
      fn(data);
    } catch (e) {}
  });
};

export const onFiltersChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getFilters = () => data.list;
export const getRotation = () => data.rotation;

export const getActiveFilter = () =>
  data.list.find((filter) => filter.id === data.activeId) || data.list[0] || null;

export const setActiveFilter = (id) => {
  if (data.list.some((filter) => filter.id === id)) {
    data = Object.assign({}, data, { activeId: id });
    emit();
  }
};

export const updateFilter = (id, patch) => {
  data = Object.assign({}, data, {
    list: data.list.map((filter) =>
      filter.id === id ? normalizeFilter(Object.assign({}, filter,
        patch.itemGroup && patch.itemGroup !== filter.itemGroup ? switchGroupPatch(patch.itemGroup) : {}, patch, { id })) : filter
    ),
  });
  emit();
};

export const addFilter = (raw, activate = true) => {
  const filter = normalizeFilter(Object.assign({}, raw, { id: "" }));
  data = Object.assign({}, data, {
    list: data.list.concat(filter),
    activeId: activate ? filter.id : data.activeId,
  });
  emit();
  return filter;
};

export const duplicateFilter = (id) => {
  const source = data.list.find((filter) => filter.id === id);
  if (!source) {
    return null;
  }
  return addFilter(Object.assign({}, source, { name: `${source.name} (copy)` }));
};

export const removeFilter = (id) => {
  let list = data.list.filter((filter) => filter.id !== id);
  if (!list.length) {
    list = [normalizeFilter({ name: "My filter" })];
  }
  const activeId = list.some((filter) => filter.id === data.activeId)
    ? data.activeId
    : list[0].id;
  data = Object.assign({}, data, { list, activeId });
  emit();
};

export const setRotation = (patch) => {
  data = Object.assign({}, data, {
    rotation: Object.assign({}, data.rotation, patch),
  });
  emit();
};

export const setLastEaSearch = (snapshot) => {
  data = Object.assign({}, data, { lastEaSearch: snapshot });
  emit();
};

export const getLastEaSearch = () => data.lastEaSearch;

// Filters used by the bot: rotation (checked filters) or only the active filter.
export const runnableFilters = () => {
  if (data.rotation.enabled) {
    const enabled = data.list.filter((filter) => filter.enabled);
    if (enabled.length) {
      return enabled;
    }
  }
  const active = getActiveFilter();
  return active ? [active] : [];
};

// A target is a player, an exact version, or at least one restrictive criterion.
// A price alone is not enough (otherwise the bot would buy any player below that price).
export const filterHasTarget = (filter) =>
  !!(
    filter && ["players", "managers", "club", "consumables"].includes(filter.itemGroup) &&
    (hasExactTarget(filter) ||
      (filter.itemGroup !== "players" && filter.category && filter.category !== "any") ||
      (filter.player && filter.player.id) ||
      filter.definitionId ||
      filter.rarities.length ||
      filter.level !== "any" ||
      filter.nation > 0 ||
      filter.league > 0 ||
      filter.club > 0 ||
      filter.playStyle > 0 ||
      filter.zone > 0 ||
      (filter.position && filter.position !== "any") ||
      filter.minRating ||
      filter.maxRating)
  );

export const describeFilter = (filter) => {
  if (!filter) {
    return "No filter";
  }
  const parts = [];
  if (filter.itemGroup !== "players") {
    parts.push(filter.selectedItem ? filter.selectedItem.name : `${filter.itemGroup} · ${filter.category}`);
  } else if (filter.player) {
    parts.push(
      `${filter.player.name || "Player"}${filter.player.rating ? ` ${filter.player.rating}` : ""}`
    );
  } else if (filter.definitionId) {
    parts.push(`Card #${filter.definitionId}`);
  } else {
    parts.push("All players");
  }
  const levels = { bronze: "Bronze", silver: "Silver", gold: "Gold", SP: "Special" };
  if (levels[filter.level]) {
    parts.push(levels[filter.level]);
  }
  if (filter.rarities.length) {
    parts.push(`rarity ${filter.rarities.join("/")}`);
  }
  if (filter.position && filter.position !== "any") {
    parts.push(filter.position);
  }
  if (filter.minRating || filter.maxRating) {
    parts.push(filter.minRating === filter.maxRating ? `rating ${filter.minRating}` : `rating ${filter.minRating || "…"}–${filter.maxRating || "…"}`);
  }
  if (filter.priceMode === "futbin") {
    if (filter.tradeMode !== "bidOnly") parts.push(`buy ≤ ${filter.futbinPercent} % ${filter.itemGroup === "players" ? "FUTBIN" : "reference"}`);
  }
  if (filter.tradeMode === "bidOnly") parts.push(`bid ${filter.maxBid} · ends within ${filter.bidExpiresWithin}`);
  return parts.join(" · ");
};

// Empty criteria outside the web app (tests): same defaults as UTSearchCriteriaDTO.
const plainCriteria = () => ({
  type: "any",
  category: "any",
  position: "any",
  zone: -1,
  level: "any",
  rarities: [],
  defId: [],
  maskedDefId: 0,
  nation: -1,
  league: -1,
  club: -1,
  playStyle: -1,
  minBid: 0,
  maxBid: 0,
  minBuy: 0,
  maxBuy: 0,
  offset: 0,
  count: 21,
  authenticity: "any",
  primaryColor: -1,
  secondaryColor: -1,
  icontraits: "any",
});

// Build a real FC 27 UTSearchCriteriaDTO. Note: the type setter resets
// nation/subtypes, so it must be assigned first.
export const buildCriteria = (filter, prices = {}) => {
  const Dto = pageGlobal("UTSearchCriteriaDTO");
  let criteria;
  try {
    criteria = typeof Dto === "function" ? new Dto() : plainCriteria();
  } catch (e) {
    criteria = plainCriteria();
  }
  criteria.type = filter.type || "player";
  if (filter.category && filter.category !== "any") {
    criteria.category = filter.category;
  }
  if (filter.level && filter.level !== "any") {
    criteria.level = filter.level;
  }
  if (filter.rarities.length) {
    criteria.rarities = toPageArray(filter.rarities);
  }
  if (filter.zone >= 0) {
    criteria.zone = filter.zone;
  } else if (filter.position && filter.position !== "any") {
    criteria.position = filter.position;
  }
  if (filter.nation > 0) {
    criteria.nation = filter.nation;
  }
  if (filter.league > 0) {
    criteria.league = filter.league;
  } else if (filter.itemGroup === "consumables" && filter.selectedItem && filter.selectedItem.league > 0) {
    criteria.league = filter.selectedItem.league;
  }
  if (filter.club > 0) {
    criteria.club = filter.club;
  }
  if (filter.playStyle > 0) {
    criteria.playStyle = filter.playStyle;
  }
  ["authenticity", "primaryColor", "secondaryColor"].forEach((key) => {
    if (filter[key] != null && filter[key] !== "any" && filter[key] !== -1) criteria[key] = filter[key];
  });
  // EA prioritizes defId (exact version) over maskedDefId (all versions).
  const exactId = filter.definitionId || (filter.selectedItem && filter.selectedItem.definitionId);
  if (exactId > 0) {
    criteria.defId = toPageArray([exactId]);
  } else if (filter.player && filter.player.id > 0) {
    criteria.maskedDefId = filter.player.id;
  }
  const minBuy = filter.tradeMode === "bidOnly" ? 0 : toInt(prices.minBuy != null ? prices.minBuy : filter.minBuy);
  const maxBuy = filter.tradeMode === "bidOnly" ? 0 : toInt(prices.maxBuy != null ? prices.maxBuy : floorPrice(filter.maxBuy - (filter.buyBelow ? 1 : 0)));
  const minBid = toInt(prices.minBid);
  const maxBid = toInt(prices.maxBid);
  // Round maximums down and minimums up: never exceed the entered values.
  if (minBuy) {
    criteria.minBuy = ceilPrice(minBuy);
  }
  if (maxBuy) {
    criteria.maxBuy = floorPrice(maxBuy);
  }
  if (minBid) {
    criteria.minBid = ceilPrice(minBid);
  }
  if (maxBid) {
    criteria.maxBid = floorPrice(maxBid);
  }
  return criteria;
};

// EA cache busting: every search must have a different URL to get
// fresh results. Auto mode varies the max bid ABOVE the max buy
// price: no purchasable listing is excluded (bid < BIN ≤ max price).
export const cacheBusterPrices = (mode, step, { maxBuy, minBuy, maxBid, cap }) => {
  const out = { minBuy, maxBuy, maxBid, minBid: 0 };
  const variants = 20;
  const index = step % variants;
  const capped = Math.max(150, toInt(cap) || 1000);
  const ladder = (from, count) => {
    let value = ceilPrice(from) || 150;
    for (let i = 0; i < count; i += 1) {
      value = priceAbove(value);
    }
    return value;
  };
  let effective = mode;
  if (effective === "auto") {
    effective = maxBuy && !maxBid ? "maxBid" : "minBuy";
  }
  if (effective === "maxBid" && maxBuy) {
    out.maxBid = ladder(maxBuy, index);
    return out;
  }
  if (effective === "minBuy") {
    const ceiling = maxBuy ? Math.min(capped, Math.floor(maxBuy * 0.5)) : capped;
    if (ceiling >= 150 && !minBuy) {
      const choices = [];
      for (let v = 150; v <= ceiling && choices.length < 40; v = priceAbove(v)) {
        choices.push(v);
      }
      out.minBuy = choices.length ? choices[index % choices.length] : 0;
    }
    return out;
  }
  if (effective === "minBid") {
    const ceiling = Math.min(capped, maxBid ? Math.floor(maxBid * 0.5) : capped);
    const choices = [];
    for (let v = 150; v <= ceiling && choices.length < 40; v = priceAbove(v)) {
      choices.push(v);
    }
    out.minBid = choices.length ? choices[index % choices.length] : 0;
    return out;
  }
  return out;
};

// Serializable snapshot of an EA market search (import from the native interface).
export const snapshotFromEaCriteria = (criteria, playerData) => {
  if (!criteria) {
    return null;
  }
  const read = (key, fallback) => {
    try {
      const value = criteria[key];
      return value == null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  };
  const defIds = read("defId", []);
  const rarities = read("rarities", []);
  let player = null;
  try {
    if (playerData) {
      const data = Array.isArray(playerData) ? playerData[0] : playerData;
      const id = toInt(
        data && (data.id || data.databaseId || data.assetId || data.definitionId)
      );
      if (id) {
        const name =
          (data.commonName || data.knownAs || "").trim() ||
          `${data.firstName || ""} ${data.lastName || ""}`.trim() ||
          data.name ||
          "";
        player = { id: id & 0xffffff, name, rating: toInt(data.rating) };
      }
    }
  } catch (e) {}
  const masked = toInt(read("maskedDefId", 0));
  if (!player && masked) {
    player = { id: masked & 0xffffff, name: "", rating: 0 };
  }
  const signed = (key) => {
    const n = parseInt(read(key, -1), 10);
    return Number.isFinite(n) && n > 0 ? n : -1;
  };
  const type = read("type", "player") === "any" ? "player" : read("type", "player");
  const itemGroup = groupForType(type);
  return {
    itemGroup,
    selectedItem: null,
    authenticity: read("authenticity", "any"),
    primaryColor: signed("primaryColor"),
    secondaryColor: signed("secondaryColor"),
    type: read("type", "player") === "any" ? "player" : read("type", "player"),
    category: read("category", "any"),
    level: read("level", "any"),
    rarities: Array.from(rarities || []).map(Number),
    position: read("position", "any"),
    zone: signed("zone"),
    nation: signed("nation"),
    league: signed("league"),
    club: signed("club"),
    playStyle: signed("playStyle"),
    definitionId: defIds && defIds.length ? toInt(defIds[0]) : 0,
    player: itemGroup === "players" ? player : null,
    minBuy: toInt(read("minBuy", 0)),
    maxBuy: toInt(read("maxBuy", 0)),
    maxBid: toInt(read("maxBid", 0)),
    capturedAt: Date.now(),
  };
};
