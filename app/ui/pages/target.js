import { previewSearch, isRunning } from "../../core/engine";
import { cancelTask, currentTask } from "../../core/tasks";
import { availableGroups, GROUP_LABELS, categoryChoices, providerEntries, switchGroupPatch } from "../../core/itemTargets";
import { currentItemQuote, itemQuoteRecord, onItemQuote, requestItemQuote } from "../../prices/nonPlayerQuotes";
import { pageGlobal } from "../../core/page";
import {
  addFilter,
  describeFilter,
  duplicateFilter,
  filterHasTarget,
  getActiveFilter,
  getFilters,
  getLastEaSearch,
  getRotation,
  normalizeFilter,
  onFiltersChange,
  removeFilter,
  setActiveFilter,
  setRotation,
  futbinKeyForFilter,
  updateFilter,
} from "../../core/filters";
import { percentRange } from "../../core/listing";
import { afterTax, floorPrice, formatCoins, profitFor, roundPrice, toInt } from "../../core/prices";
import { getSettings } from "../../core/settings";
import { currentPrice, getPriceRecord, onPriceUpdate, requestPrice, trackPrice } from "../../prices/priceService";
import { loadEaPlayersCatalog, searchEaPlayersByTerm } from "../../services/datasource/eaPlayers";
import { debounce, escapeHtml, qs, qsa, setHtml } from "../dom";
import {
  grid,
  numberField,
  priceField,
  rangeField,
  registerVirtualFilterFields,
  section,
  selectField,
  textField,
  toggleField,
} from "../fields";

const LEVELS = [
  ["any", "All"],
  ["bronze", "Bronze"],
  ["silver", "Silver"],
  ["gold", "Gold"],
  ["SP", "Special"],
];

const POSITIONS = [
  ["any", "All positions"],
  ["130", "Zone: defense"],
  ["131", "Zone: midfield"],
  ["132", "Zone: attack"],
  ["GK", "GK (goalkeeper)"],
  ["RB", "RB"],
  ["RWB", "RWB"],
  ["CB", "CB"],
  ["LB", "LB"],
  ["LWB", "LWB"],
  ["CDM", "CDM"],
  ["CM", "CM"],
  ["CAM", "CAM"],
  ["RM", "RM"],
  ["LM", "LM"],
  ["RW", "RW"],
  ["LW", "LW"],
  ["CF", "CF"],
  ["ST", "ST"],
];

let unsubscribeFilters = null;
let unsubscribePrices = null;
let liveTrack = { key: 0, untrack: null };
let liveTimer = null;
let unsubscribeItemQuotes = null;

const LIVE_MAX_AGE = 5 * 60 * 1000;

const isDefaultName = (name) => /^(new filter|my filter|filter|nouveau filtre|mon filtre|filtre)( \((?:copy|copie)\))?$/i.test(String(name || "").trim());

const filterPrices = (filter) => {
  const parts = [];
  if (filter.priceMode === "futbin") {
    parts.push(`≤ ${filter.futbinPercent} % FUTBIN`);
  } else if (filter.maxBuy) {
    parts.push(`≤ ${formatCoins(filter.maxBuy)}`);
  }
  if (filter.sellMode === "fixed" && filter.sellPrice) {
    parts.push(`→ ${formatCoins(filter.sellPrice)}`);
  } else if (filter.sellMode === "futbin") {
    parts.push(`→ ${filter.sellPercent || getSettings().sell.futbinPercent} %`);
  }
  return parts.join(" ");
};

// Live FUTBIN price row for the active filter (% FUTBIN mode).
const futbinLiveHtml = () => {
  const filter = getActiveFilter();
  if (!filter || filter.priceMode !== "futbin") {
    return "";
  }
  if (filter.itemGroup !== "players") {
    const quote = currentItemQuote(filter);
    const record = itemQuoteRecord(filter);
    return quote ? `<div class="mb-note mb-live">${escapeHtml(quote.source)} <b>${formatCoins(quote.price)}</b>
      · ${escapeHtml(quote.referenceIdentity)} · ${Math.round((Date.now() - quote.fetchedAt) / 1000)} s ago
      <button type="button" class="mb-link" data-target-action="futbin-refresh">Refresh reference</button></div>` :
      `<div class="mb-note is-warn">${escapeHtml(record && record.reason || "Select an exact search result. Fetching FUTBIN first, then EA if needed…")}</div>`;
  }
  const key = futbinKeyForFilter(filter);
  if (!key) {
    return `<div class="mb-note is-warn">Choose a player (or version ID): the FUTBIN price belongs to that card.</div>`;
  }
  const record = getPriceRecord(key);
  const price = currentPrice(key, LIVE_MAX_AGE);
  if (!price) {
    const text =
      record && record.status === "miss"
        ? "Card not found on FUTBIN: enter an exact version ID or switch to a fixed price."
        : record && record.status === "error"
        ? "FUTBIN is not responding right now (use the FUTBIN tab to test access)."
        : "Fetching FUTBIN price…";
    return `<div class="mb-note${record && record.status && record.status !== "ok" ? " is-warn" : ""}">${text}</div>`;
  }
  const computed = floorPrice((currentPrice(key, LIVE_MAX_AGE, "buy") * filter.futbinPercent) / 100);
  const max = filter.maxBuy ? Math.min(filter.maxBuy, computed) : computed;
  const seconds = Math.round((Date.now() - record.fetchedAt) / 1000);
  const age = seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
  return `<div class="mb-note mb-live">FUTBIN <b>${formatCoins(price)}</b>${record.suspect ? " ⚠" : ""} · fetched ${age}
    → max buy <b>${formatCoins(max)}</b>${filter.maxBuy && filter.maxBuy < computed ? " (cap)" : ""}
    <button type="button" class="mb-link" data-target-action="futbin-refresh">refresh</button></div>`;
};

// Track the displayed filter's FUTBIN price while the Target tab is open.
const syncLiveTracking = () => {
  const filter = getActiveFilter();
  if (filter && filter.itemGroup !== "players" && filter.priceMode === "futbin" && !currentItemQuote(filter)) requestItemQuote(filter);
  const key = filter && filter.priceMode === "futbin" ? futbinKeyForFilter(filter) : 0;
  if (key === liveTrack.key) {
    return;
  }
  if (liveTrack.untrack) {
    liveTrack.untrack();
  }
  liveTrack = {
    key,
    untrack: key
      ? trackPrice(key, { name: filter.player ? filter.player.name : "", rating: filter.player ? filter.player.rating : 0 }, "visible")
      : null,
  };
};

const listHtml = () => {
  const active = getActiveFilter();
  const rotation = getRotation();
  return getFilters()
    .map(
      (filter) => `
      <div class="mb-filter-item${active && active.id === filter.id ? " is-active" : ""}" data-filter-id="${filter.id}" role="button" tabindex="0">
        ${
          rotation.enabled
            ? `<button type="button" class="mb-check" role="checkbox" aria-checked="${filter.enabled}" data-filter-toggle="${filter.id}" aria-label="Include ${escapeHtml(filter.name)} in rotation">${filter.enabled ? "✓" : ""}</button>`
            : ""
        }
        <div class="mb-filter-main">
          <b>${escapeHtml(filter.name)}</b>
          <small>${escapeHtml(describeFilter(filter))}</small>
        </div>
        <span class="mb-price-tag">${escapeHtml(filterPrices(filter))}</span>
      </div>`
    )
    .join("");
};

const playerChipHtml = () => {
  const filter = getActiveFilter();
  if (filter && filter.itemGroup !== "players") {
    return filter.selectedItem ? `<span class="mb-chip"><span>${escapeHtml(filter.selectedItem.name)} · id ${filter.selectedItem.definitionId}</span>
      <button type="button" data-player-clear aria-label="Remove selected item">×</button></span>` :
      `<span class="mb-empty">Search a subtype, then select a result below to target a specific item.</span>`;
  }
  const player = filter && filter.player;
  if (!player) {
    return `<span class="mb-empty">No player selected: the filter applies to all players matching the criteria.</span>`;
  }
  return `<span class="mb-chip"><span>${escapeHtml(player.name || "Player")}${player.rating ? ` · ${player.rating}` : ""} · id ${player.id}</span><button type="button" data-player-clear aria-label="Remove player">×</button></span>`;
};

const targetWarningHtml = () => {
  const filter = getActiveFilter();
  if (!filter || filterHasTarget(filter)) {
    return "";
  }
  return `<div class="mb-note is-warn" style="margin-top:8px">Choose a specific item, subtype, or restrictive criterion before searching.</div>`;
};

const lastEaHtml = () => {
  const snapshot = getLastEaSearch();
  if (!snapshot) {
    return "Run a search in EA's transfer market, then import it here (rarity, position, style, nation…).";
  }
  const when = new Date(snapshot.capturedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const player = snapshot.player && snapshot.player.name ? snapshot.player.name : snapshot.player ? `player ${snapshot.player.id}` : `${snapshot.itemGroup || "players"} · ${snapshot.category}`;
  return `Last EA search captured at ${when} : ${escapeHtml(player)}${snapshot.maxBuy ? ` · max buy ${formatCoins(snapshot.maxBuy)}` : ""}.`;
};

const categoryFieldsHtml = () => {
  const f = getActiveFilter();
  if (!f || f.itemGroup === "players") return "";
  const options = (method, ...args) => providerEntries(method, ...args).map((v) => [v.value, v.label]);
  const colorOptions = () => providerEntries("getVanityColorDP").map((v) => [v.id, v.label]);
  const fields = [];
  const choices = categoryChoices(f.itemGroup);
  const category = pageGlobal("SearchCategory") || {};
  fields.push(selectField({ bind: "f:categoryChoice", label: "Subtype", wide: true, options: choices.map((v) => [v.category, v.label]) }));
  const add = (bind, label, opts) => { if (opts.length) fields.push(selectField({ bind, label, options: opts })); };
  if (f.itemGroup === "managers" || f.itemGroup === "club") {
    add("f:levelChoice", "Quality", options("getItemLevelDP"));
    const type = (pageGlobal("ItemType") || {}).MANAGER;
    const choice = choices.find((v) => String(v.category) === String(f.category));
    add("f:rarityChoice", "Rarity", options("getItemRarityDP", { itemTypes: type != null && f.itemGroup === "managers" ? [type] : [], itemSubTypes: choice ? [choice.subtype] : [], quality: f.level, tradableOnly: true }));
  }
  if (f.itemGroup === "managers") add("f:nationChoice", "Nation", options("getNationDP"));
  if (f.itemGroup === "managers" || f.category === category.MANAGER_LEAGUE || f.itemGroup === "club" && f.category !== category.BALL) add("f:leagueChoice", "League", options("getLeagueDP", true));
  if (f.itemGroup === "club") {
    if ([category.KIT, category.BADGE, category.STADIUM].includes(f.category)) {
      add("f:clubChoice", "Club", options("getTeamDP", f.league));
      add("f:authenticity", "Authenticity", options("getVanityAuthenticityDP"));
    }
    if ([category.KIT, category.BADGE, category.BALL].includes(f.category)) {
      add("f:primaryColorChoice", "Primary color", colorOptions());
      if (f.category !== category.BALL) add("f:secondaryColorChoice", "Secondary color", colorOptions());
    }
  }
  if (f.category === category.PLAYSTYLE) add("f:playStyleChoice", "Chemistry style", options("getPlayStyleDP"));
  fields.push(`<div class="mb-field is-wide" data-player-chip>${playerChipHtml()}</div>
    <p class="mb-hint is-wide">Broad filters use fixed buy and sell prices. For automatic pricing, select a Test search result. Manager FUTBIN references group country and quality; league and rarity modifiers use EA.</p>`);
  return grid(...fields);
};

export const targetPageHtml = () => `
  ${section(
    "Snipe filters",
    `<div class="mb-filter-list" data-filter-list>${listHtml()}</div>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-filter-action="add">+ New</button>
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-filter-action="duplicate">Duplicate</button>
       <button type="button" class="mb-btn mb-btn-danger mb-btn-sm" data-filter-action="delete">Delete</button>
     </div>
     <div style="margin-top:8px">${grid(
       toggleField({ bind: "r:enabled", label: "Rotate filters", hint: "Alternate between checked filters." }),
       numberField({ bind: "r:every", label: "Switch every", hint: "searches", min: 1, max: 50 }),
       toggleField({ bind: "r:random", label: "Random order", wide: true })
     )}</div>`
  )}
  ${section(
    "Target",
    grid(
      textField({ bind: "f:name", label: "Filter name", wide: true }),
      selectField({ bind: "f:itemGroupChoice", label: "Item group", wide: true, options: availableGroups().map((v) => [v, GROUP_LABELS[v]]) }),
      `<div class="mb-field is-wide" data-show-if="f:itemGroup=players">
        <label class="mb-label" for="mb-player-input"><span>Player</span><em data-catalog-status></em></label>
        <div class="mb-player-search">
          <input id="mb-player-input" class="mb-input" type="search" autocomplete="off" spellcheck="false" placeholder="Player name (e.g. Mbappé)" data-player-input aria-autocomplete="list" aria-controls="mb-player-results" />
          <div class="mb-results" id="mb-player-results" role="listbox" data-player-results hidden></div>
        </div>
        <div style="margin-top:8px" data-player-chip>${playerChipHtml()}</div>
        <div data-target-warning>${targetWarningHtml()}</div>
        <p class="mb-hint">All versions of the player are searched. For a specific card (TOTW, promo…), enter its version ID or filter by rating / rarity.</p>
      </div>`,
      selectField({ bind: "f:level", label: "Quality", options: LEVELS, showIf: "f:itemGroup=players" }),
      selectField({ bind: "f:positionChoice", label: "Position", options: POSITIONS, showIf: "f:itemGroup=players" }),
      numberField({ bind: "f:minRating", label: "Min rating", placeholder: "—", max: 99, showIf: "f:itemGroup=players" }),
      numberField({ bind: "f:maxRating", label: "Max rating", placeholder: "—", max: 99, showIf: "f:itemGroup=players" }),
      `<div class="mb-field is-wide" data-category-fields>${categoryFieldsHtml()}</div>`
    )
  )}
  ${section(
    "Buy price",
    grid(
      selectField({
        bind: "f:priceMode",
        label: "Mode",
        wide: true,
        options: [
          ["fixed", "Fixed price"],
          ["futbin", "% of reference (FUTBIN first, EA fallback for items)"],
        ],
      }),
      numberField({
        bind: "f:futbinPercent",
        label: "Buy reference %",
        float: true,
        min: 10,
        max: 150,
        key: true,
        showIf: "f:priceMode=futbin",
        hint: "Non-player default: 80%. Rounded down to an EA price tier. Automatic pricing requires a specific item.",
      }),
      priceField({
        bind: "f:maxBuy",
        label: "Max buy price (Buy Now)",
        key: true,
        wide: true,
        hint: "Fixed mode: ceiling for matching items. Automatic mode: optional absolute cap.",
      }),
      `<div class="mb-field is-wide" data-show-if="f:priceMode=futbin"><div data-futbin-live>${futbinLiveHtml()}</div></div>`,
      priceField({ bind: "f:maxBid", label: "Max bid", hint: "Used only when bidding is enabled (Buy tab)." }),
      priceField({ bind: "f:minBuy", label: "Min buy price (filter)", hint: "Optionnel." })
    )
  )}
  ${section(
    "Reselling",
    grid(
      selectField({
        bind: "f:sellMode",
        label: "Sell price",
        wide: true,
        options: [
          ["global", "Use Sell tab setting"],
          ["fixed", "Fixed price for this filter"],
          ["futbin", "% of reference for this filter"],
        ],
      }),
      priceField({ bind: "f:sellPrice", label: "Sell price", wide: true, showIf: "f:sellMode=fixed" }),
      rangeField({
        bind: "f:sellPercent",
        label: "Sell reference %",
        unit: null,
        optional: true,
        wide: true,
        placeholder: "e.g. 98-100 (empty = Sell tab)",
        showIf: "f:sellMode=futbin",
        hint: "Non-player default: 95%. References older than one minute are refreshed before listing.",
      })
    )
  )}
  ${section(
    "Advanced criteria (EA IDs)",
    grid(
      numberField({ bind: "f:definitionId", label: "Exact version ID", placeholder: "e.g. 50565123" }),
      textField({ bind: "f:raritiesText", label: "Rarity IDs", placeholder: "e.g. 3", showIf: "f:itemGroup=players" }),
      numberField({ bind: "f:nationField", label: "Nation (ID)", placeholder: "—", showIf: "f:itemGroup=players" }),
      numberField({ bind: "f:leagueField", label: "League (ID)", placeholder: "—", showIf: "f:itemGroup=players" }),
      numberField({ bind: "f:clubField", label: "Club (ID)", placeholder: "—", showIf: "f:itemGroup=players" }),
      numberField({ bind: "f:playStyleField", label: "Play style (ID)", placeholder: "—", showIf: "f:itemGroup=players" })
    ) +
      `<p class="mb-hint">Set up your search in the EA market, then click “Import”.</p>`
  )}
  ${section(
    "Import & test",
    `<div class="mb-note" data-last-ea>${lastEaHtml()}</div>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-target-action="import">Import EA search</button>
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-target-action="preview">Test search (without buying)</button>
       <button type="button" class="mb-btn mb-btn-danger mb-btn-sm" data-target-action="stop-preview" hidden>Stop test</button>
     </div>
     <div data-preview></div>`
  )}
`;

// Virtual fields: convert to the filter model.
const VIRTUAL = {
  itemGroupChoice: { read: (f) => f.itemGroup, write: (v) => switchGroupPatch(v) },
  categoryChoice: { read: (f) => f.category, write: (v, f) => {
    const choice = categoryChoices(f.itemGroup).find((c) => String(c.category) === String(v));
    return choice ? Object.assign({}, switchGroupPatch(f.itemGroup), { type: choice.type, category: choice.category,
      futbinPercent: f.futbinPercent, sellPercent: f.sellPercent }) : {};
  } },
  rarityChoice: { read: (f) => f.rarities[0] == null ? -1 : f.rarities[0], write: (v) => ({ rarities: Number(v) >= 0 ? [Number(v)] : [] }) },
  levelChoice: { read: (f) => f.level, write: (v) => ({ level: v, rarities: [] }) },
  positionChoice: {
    read: (filter) => (filter.zone > 0 ? String(filter.zone) : filter.position || "any"),
    write: (value) =>
      /^13[0-2]$/.test(value) ? { zone: Number(value), position: "any" } : { zone: -1, position: value || "any" },
  },
  raritiesText: {
    read: (filter) => filter.rarities.join(", "),
    write: (value) => ({
      rarities: String(value || "")
        .split(/[\s,;]+/)
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isFinite(v) && v >= 0),
    }),
  },
  nationField: { read: (f) => (f.nation > 0 ? f.nation : 0), write: (v) => ({ nation: toInt(v) || -1 }) },
  leagueField: { read: (f) => (f.league > 0 ? f.league : 0), write: (v) => ({ league: toInt(v) || -1 }) },
  clubField: { read: (f) => (f.club > 0 ? f.club : 0), write: (v) => ({ club: toInt(v) || -1 }) },
  playStyleField: { read: (f) => (f.playStyle > 0 ? f.playStyle : 0), write: (v) => ({ playStyle: toInt(v) || -1 }) },
};
["nation", "league", "club", "playStyle", "primaryColor", "secondaryColor"].forEach((key) => {
  VIRTUAL[`${key}Choice`] = { read: (f) => f[key], write: (v) => Object.assign({ [key]: Number(v) }, key === "league" ? { club: -1 } : {}) };
});

registerVirtualFilterFields(VIRTUAL);

const previewHtml = (result) => {
  if (!result.ok) {
    return `<div class="mb-note is-warn" style="margin-top:8px">${escapeHtml(result.message)}</div>`;
  }
  if (!result.rows.length) {
    return `<div class="mb-note" style="margin-top:8px">No cards found${result.maxBuy ? ` at ${formatCoins(result.maxBuy)} or less` : ""} (${Math.round(result.latency)} ms). This is normal if your max price is below market value: the bot waits for a deal to appear.</div>`;
  }
  const rows = result.rows
    .slice(0, 21)
    .map((row, index) => {
      const deal = result.maxBuy && row.bin && row.bin <= result.maxBuy && row.match && !row.own;
      const minutes = Math.floor(row.expires / 60);
      const time = row.expires >= 3600 ? `${Math.floor(row.expires / 3600)} h` : `${minutes} min`;
      return `<tr class="${deal ? "is-deal" : row.match ? "" : "is-muted"}">
        <td><button type="button" class="mb-link" data-exact-result="${index}">${escapeHtml(row.name)}${row.rating ? ` ${row.rating}` : ""}</button>${row.own ? " (you)" : ""}</td>
        <td class="is-num">${row.bin ? formatCoins(row.bin) : "—"}</td>
        <td class="is-num">${row.bid ? formatCoins(row.bid) : "—"}</td>
        <td class="is-num">${time}</td>
      </tr>`;
    })
    .join("");
  const cheapest = result.rows.find((row) => row.bin && row.match && !row.own);
  const futbin = result.futbinPrice ? ` · FUTBIN ${formatCoins(result.futbinPrice)} → max buy ${formatCoins(result.maxBuy)}` : "";
  return `<div class="mb-preview">
      <table>
        <thead><tr><th>Card</th><th class="is-num">Buy Now</th><th class="is-num">Bid</th><th class="is-num">Ends</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="mb-hint">${result.rows.length} result(s) · ${Math.round(result.latency)} ms${cheapest ? ` · cheapest: ${formatCoins(cheapest.bin)}` : ""}${futbin}. Green shows what the bot would buy.</p>`;
};

export const bindTargetPage = (page, refreshAll) => {
  const listEl = qs(page, "[data-filter-list]");
  const chipEl = qs(page, "[data-player-chip]");
  const input = qs(page, "[data-player-input]");
  const results = qs(page, "[data-player-results]");
  const status = qs(page, "[data-catalog-status]");
  const lastEa = qs(page, "[data-last-ea]");
  const preview = qs(page, "[data-preview]");
  let hits = [];
  let focusIndex = -1;
  let previewRows = [];
  let previewGeneration = 0;
  let previewFilterKey = "";
  let categorySignature = "";
  let runtimeSignature = "";

  const warningEl = qs(page, "[data-target-warning]");
  const liveEl = qs(page, "[data-futbin-live]");
  const renderLive = () => setHtml(liveEl, futbinLiveHtml());
  const renderList = () => {
    const filter = getActiveFilter();
    const signature = filter ? `${filter.itemGroup}:${filter.category}:${filter.league}:${filter.level}:${JSON.stringify(categoryChoices(filter.itemGroup))}` : "";
    if (signature !== categorySignature) {
      categorySignature = signature;
      setHtml(qs(page, "[data-category-fields]"), categoryFieldsHtml());
    }
    setHtml(listEl, listHtml());
    qsa(page, "[data-player-chip]").forEach((el) => setHtml(el, playerChipHtml()));
    setHtml(warningEl, targetWarningHtml());
    setHtml(lastEa, lastEaHtml());
    syncLiveTracking();
    renderLive();
  };

  if (unsubscribeFilters) {
    unsubscribeFilters();
  }
  unsubscribeFilters = onFiltersChange(() => {
    previewGeneration += 1;
    previewRows = [];
    previewFilterKey = "";
    // Preview writes use innerHTML; always clear rather than trusting setHtml's cache.
    preview.innerHTML = "";
    if (currentTask() && currentTask().label === "Test search") cancelTask();
    renderList();
    refreshAll();
  });
  if (unsubscribePrices) {
    unsubscribePrices();
  }
  unsubscribePrices = onPriceUpdate((id) => {
    if (id === liveTrack.key) {
      renderLive();
      refreshAll();
    }
  });
  if (unsubscribeItemQuotes) unsubscribeItemQuotes();
  unsubscribeItemQuotes = onItemQuote(() => { renderLive(); refreshAll(); });
  syncLiveTracking();
  clearInterval(liveTimer);
  liveTimer = setInterval(renderLive, 15000);

  const closeResults = () => {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    focusIndex = -1;
  };

  const choose = (player) => {
    const filter = getActiveFilter();
    if (!filter || !player) {
      return;
    }
    const patch = { player: { id: player.eaId, name: player.name, rating: player.rating }, definitionId: 0 };
    if (isDefaultName(filter.name)) {
      patch.name = `${player.name}${player.rating ? ` ${player.rating}` : ""}`;
    }
    updateFilter(filter.id, patch);
    input.value = "";
    closeResults();
  };

  const paintHits = () => {
    if (!hits.length) {
      results.innerHTML = `<div class="mb-hit"><small>No players found.</small></div>`;
      results.hidden = false;
      return;
    }
    results.innerHTML = hits
      .map(
        (player, index) => `<button type="button" class="mb-hit${index === focusIndex ? " is-focus" : ""}" role="option" data-hit="${index}">
          <span class="mb-hit-rating">${player.rating || "—"}</span>
          <span><b>${escapeHtml(player.name)}</b><small>${escapeHtml(`${player.firstName || ""} ${player.lastName || ""}`.trim())} · id ${player.eaId}</small></span>
        </button>`
      )
      .join("");
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const search = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) {
      closeResults();
      return;
    }
    status.textContent = "searching…";
    hits = await searchEaPlayersByTerm(term, 12);
    status.textContent = hits.length ? "" : "EA catalog unavailable?";
    focusIndex = hits.length ? 0 : -1;
    paintHits();
  }, 180);

  input.addEventListener("input", search);
  input.addEventListener("focus", () => {
    loadEaPlayersCatalog().then((rows) => {
      status.textContent = rows && rows.length ? `${rows.length.toLocaleString("en-US")} players` : "catalog unavailable";
    });
  });
  input.addEventListener("keydown", (event) => {
    if (results.hidden || !hits.length) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusIndex = (focusIndex + (event.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      paintHits();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(hits[Math.max(0, focusIndex)]);
    } else if (event.key === "Escape") {
      closeResults();
    }
  });
  results.addEventListener("mousedown", (event) => event.preventDefault());
  results.addEventListener("click", (event) => {
    const hit = event.target.closest("[data-hit]");
    if (hit) {
      choose(hits[Number(hit.dataset.hit)]);
    }
  });
  input.addEventListener("blur", () => setTimeout(closeResults, 120));

  page.addEventListener("click", async (event) => {
    const target = event.target;
    const exact = target.closest("[data-exact-result]");
    if (exact) {
      const row = previewRows[Number(exact.dataset.exactResult)];
      const filter = getActiveFilter();
      if (row && row.match && filter && previewFilterKey === JSON.stringify(filter) && row.target.group === filter.itemGroup) {
        updateFilter(filter.id, { definitionId: row.definitionId, selectedItem: filter.itemGroup === "players" ? null : row.target,
          player: null, name: isDefaultName(filter.name) ? row.name : filter.name });
      }
      return;
    }
    const toggle = target.closest("[data-filter-toggle]");
    if (toggle) {
      event.stopPropagation();
      const filter = getFilters().find((f) => f.id === toggle.dataset.filterToggle);
      if (filter) {
        updateFilter(filter.id, { enabled: !filter.enabled });
      }
      return;
    }
    const item = target.closest("[data-filter-id]");
    if (item) {
      setActiveFilter(item.dataset.filterId);
      preview.innerHTML = "";
      return;
    }
    if (target.closest("[data-player-clear]")) {
      const filter = getActiveFilter();
      if (filter) {
        updateFilter(filter.id, { player: null, selectedItem: null, definitionId: 0 });
      }
      return;
    }
    const action = target.closest("[data-filter-action]");
    if (action) {
      const active = getActiveFilter();
      if (action.dataset.filterAction === "add") {
        addFilter({ name: "New filter" });
      } else if (action.dataset.filterAction === "duplicate" && active) {
        duplicateFilter(active.id);
      } else if (action.dataset.filterAction === "delete" && active) {
        if (window.confirm(`Delete filter “${active.name}”?`)) {
          removeFilter(active.id);
        }
      }
      preview.innerHTML = "";
      return;
    }
    const targetAction = target.closest("[data-target-action]");
    if (!targetAction) {
      return;
    }
    if (targetAction.dataset.targetAction === "stop-preview") {
      if (currentTask() && currentTask().label === "Test search") cancelTask();
      return;
    }
    if (targetAction.dataset.targetAction === "futbin-refresh") {
      const filter = getActiveFilter();
      if (filter && filter.itemGroup !== "players") { requestItemQuote(filter, { force: true }).then(renderLive); return; }
      const key = filter ? futbinKeyForFilter(filter) : 0;
      if (key) {
        requestPrice(key, { name: filter.player ? filter.player.name : "", rating: filter.player ? filter.player.rating : 0 }).then(renderLive);
      }
      return;
    }
    if (targetAction.dataset.targetAction === "import") {
      const snapshot = getLastEaSearch();
      if (!snapshot) {
        preview.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">No EA search captured. Go to Transfers → Transfer Market, set your criteria, then click Search (or “Snipe this search”).</div>`;
        return;
      }
      importSnapshot(snapshot);
      preview.innerHTML = `<div class="mb-note" style="margin-top:8px">EA search imported into the active filter. Check the max buy price.</div>`;
      return;
    }
    if (targetAction.dataset.targetAction === "preview") {
      if (isRunning()) {
        preview.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">The bot is already running: check the log.</div>`;
        return;
      }
      targetAction.disabled = true;
      const generation = ++previewGeneration;
      const filter = getActiveFilter();
      const filterKey = JSON.stringify(filter);
      previewRows = [];
      previewFilterKey = "";
      const stop = qs(page, '[data-target-action="stop-preview"]');
      stop.hidden = false;
      preview.innerHTML = `<div class="mb-note" style="margin-top:8px">Searching…</div>`;
      try {
        const result = await previewSearch(filter);
        if (generation !== previewGeneration || filterKey !== JSON.stringify(getActiveFilter())) return;
        previewRows = result.rows || [];
        previewFilterKey = filterKey;
        preview.innerHTML = previewHtml(result);
      } catch (e) {
        if (generation === previewGeneration) preview.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">${escapeHtml(e.message || e)}</div>`;
      } finally {
        targetAction.disabled = false;
        stop.hidden = true;
      }
    }
  });
  page.addEventListener("keydown", (event) => {
    const item = event.target.closest && event.target.closest("[data-filter-id]");
    if (item && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setActiveFilter(item.dataset.filterId);
    }
  });
  // The panel mounts at document-start, before EA's native providers may exist.
  // Refresh in place when the app finishes loading; never freeze the initial player-only list.
  const refreshRuntime = () => {
    const groups = availableGroups();
    const filter = getActiveFilter();
    const signature = JSON.stringify([groups, filter && categoryChoices(filter.itemGroup)]);
    if (signature === runtimeSignature) return;
    runtimeSignature = signature;
    const select = qs(page, '[data-bind="f:itemGroupChoice"]');
    setHtml(select, groups.map((group) => `<option value="${group}">${escapeHtml(GROUP_LABELS[group])}</option>`).join(""));
    renderList();
    refreshAll();
  };
  refreshRuntime();
  return refreshRuntime;
};

// Apply a captured EA search to the active filter (or create a new one).
export const importSnapshot = (snapshot, { asNew = false } = {}) => {
  if (!snapshot) {
    return null;
  }
  const patch = {
    itemGroup: snapshot.itemGroup,
    selectedItem: snapshot.selectedItem || null,
    authenticity: snapshot.authenticity || "any",
    primaryColor: snapshot.primaryColor,
    secondaryColor: snapshot.secondaryColor,
    type: snapshot.type,
    category: snapshot.category,
    level: snapshot.level,
    rarities: snapshot.rarities,
    position: snapshot.position,
    zone: snapshot.zone,
    nation: snapshot.nation,
    league: snapshot.league,
    club: snapshot.club,
    playStyle: snapshot.playStyle,
    definitionId: snapshot.definitionId,
    player: snapshot.player,
  };
  if (snapshot.maxBuy) {
    patch.maxBuy = snapshot.maxBuy;
  }
  if (snapshot.minBuy) {
    patch.minBuy = snapshot.minBuy;
  }
  if (snapshot.maxBid) {
    patch.maxBid = snapshot.maxBid;
  }
  const name = snapshot.player && snapshot.player.name
    ? `${snapshot.player.name}${snapshot.player.rating ? ` ${snapshot.player.rating}` : ""}`
    : "EA search";
  const active = getActiveFilter();
  if (asNew || !active) {
    return addFilter(Object.assign({ name }, patch));
  }
  if (isDefaultName(active.name) || /^(?:EA search|Recherche EA)/.test(active.name)) {
    patch.name = name;
  }
  updateFilter(active.id, patch);
  return normalizeFilter(Object.assign({}, active, patch));
};

// Effective max buy price (fixed or capped FUTBIN percentage) for page hints.
const effectiveBuy = (filter) => {
  if (filter.priceMode !== "futbin") {
    return toInt(filter.maxBuy);
  }
  const key = futbinKeyForFilter(filter);
  const quote = filter.itemGroup !== "players" ? currentItemQuote(filter) : null;
  const price = quote ? quote.price : key ? currentPrice(key, LIVE_MAX_AGE, "buy") : 0;
  if (!price) {
    return 0;
  }
  const computed = floorPrice((price * filter.futbinPercent) / 100);
  return filter.maxBuy ? Math.min(filter.maxBuy, computed) : computed;
};

// Help text below the sell price: net after tax + profit per card.
export const sellExtra = () => {
  const filter = getActiveFilter();
  if (!filter) {
    return "";
  }
  const settings = getSettings().sell;
  let sell = 0;
  let prefix = "";
  const futbinSell = filter.sellMode === "futbin" || (filter.sellMode === "global" && settings.priceMode === "futbin");
  if (futbinSell) {
    const key = futbinKeyForFilter(filter);
    const quote = filter.itemGroup !== "players" ? currentItemQuote(filter, 60000) : null;
    const price = quote ? quote.price : key ? currentPrice(key, LIVE_MAX_AGE, "sell") : 0;
    if (!price) {
      return "";
    }
    const range = percentRange(filter.sellMode === "futbin" && filter.sellPercent ? filter.sellPercent : settings.futbinPercent);
    sell = roundPrice((price * (range.min + range.max)) / 200);
    prefix = `≈ ${formatCoins(sell)} · `;
  } else {
    sell = filter.sellMode === "fixed" ? toInt(filter.sellPrice) || toInt(settings.defaultPrice) : toInt(settings.defaultPrice);
  }
  if (!sell) {
    return "";
  }
  const buy = effectiveBuy(filter);
  const net = afterTax(sell);
  const profit = buy ? profitFor(buy, sell) : 0;
  return `${prefix}net ${formatCoins(net)}${buy ? ` · profit ${profit >= 0 ? "+" : ""}${formatCoins(profit)}` : ""}`;
};
