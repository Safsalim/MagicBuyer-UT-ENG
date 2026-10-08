const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const babel = require("babel-core");

function env(overrides = {}) {
  const storage = new Map();
  const modules = new Map();
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) } },
    document: { createElement: () => ({}) }, performance, URL,
  });
  const root = path.resolve(__dirname, "..");
  const mocks = new Map(Object.entries(overrides).map(([key, val]) => [path.resolve(root, key), Object.assign(val, { __esModule: true })]));
  const load = (filename) => {
    const full = path.resolve(root, filename);
    if (mocks.has(full)) return mocks.get(full);
    if (modules.has(full)) return modules.get(full);
    const module = { exports: {} };
    modules.set(full, module.exports);
    let source = fs.readFileSync(full, "utf8");
    if (filename.endsWith("engine.js")) source += '\nexport const testInternals = { effectiveMaxBuy, preflight, nextFilter, analyzeResults, attemptBuy, snipeCycle, checkBids, initialSync, sellJob, queueSale, relistAtFutbin, runPreviewSearch };';
    if (filename.endsWith("fields.js")) source += '\nexport const testWriteBound = writeBound;';
    const code = babel.transform(source, { presets: [require.resolve("babel-preset-es2015")], babelrc: false }).code;
    vm.runInContext(`(function(exports, require, module) {${code}\n})`, context)(module.exports, (name) => {
      if (!name.startsWith(".")) throw new Error(`Unexpected dependency ${name}`);
      return load(path.relative(root, path.resolve(path.dirname(full), name + (name.endsWith(".js") ? "" : ".js"))));
    }, module);
    return module.exports;
  };
  const page = load("app/core/page.js");
  const SearchType = { PLAYER: "player", STAFF: "staff", CLUB_INFO: "clubInfo", STADIUM: "stadium", BALL: "ball", VANITY: "vanity", CONSUMABLES_TRAINING: "training", CONSUMABLES_DEVELOPMENT: "development" };
  const SearchCategory = { ANY: "any", MANAGER: "manager", KIT: "kit", BADGE: "badge", STADIUM: "stadium", BALL: "ball", PLAYSTYLE: "playStyle", MANAGER_LEAGUE: "managerLeague", HEALING: "healing" };
  const ItemType = { PLAYER: "player", MANAGER: "manager", KIT: "kit", BADGE: "badge", HEALTH: "health", TRAINING: "training" };
  const ItemSubType = { MANAGER: 0, KIT: 1, BADGE: 2, TRAINING_PLAYERSTYLE_GENERAL_1: 250, TRAINING_MANAGERLEAGUE: 300, HEALING: 400 };
  const entry = (id, value, label = value) => ({ id, value, label });
  const dp = {
    getStaffTypeDP: () => [entry(-1, "any"), entry(0, "manager")],
    getConsumableTypeDP: () => [entry(3, "playStyle"), entry(4, "managerLeague"), entry(7, "healing")],
    getClubVanityTypesDP: () => [entry(1, "kit"), entry(2, "badge")],
    getItemLevelDP: () => [entry(-1, "any"), entry(0, "bronze"), entry(1, "silver"), entry(2, "gold")],
    getNationDP: () => [entry(-1, "-1", "All"), entry(18, "18", "France")],
    getLeagueDP: () => [entry(-1, "-1", "All"), entry(13, "13", "League")],
    getTeamDP: () => [entry(-1, "-1", "All"), entry(20, "20", "Club")],
    getVanityColorDP: () => [entry(-1, "any", "All"), entry(1, "RED", "Red")],
    getVanityAuthenticityDP: () => [entry(-1, "any", "All"), entry(1, "authentic", "Authentic")],
    getPlayStyleDP: () => [entry(-1, "-1", "All"), entry(250, "250", "Anchor"), entry(251, "251", "Hunter")],
    getItemRarityDP: () => [entry(-1, -1, "All"), entry(1, 1, "Rare")],
  };
  page.setPageForTests({ SearchType, SearchCategory, ItemType, ItemSubType, factories: { DataProvider: dp }, AUCTION_MAX_BID: 15000000,
    services: { User: { getUser: () => ({ coins: { amount: 10000 } }) } },
  });
  const filters = load("app/core/filters.js");
  const targets = load("app/core/itemTargets.js");
  const prices = load("app/core/prices.js");
  const item = (id = 101, price = 1000, opts = {}) => Object.assign({ id, definitionId: 9001, type: "manager", subtype: 0, nationId: 18, leagueId: 13, rating: 80, rareflag: 0,
    getSearchType() { return this.type === "player" ? "player" : this.type === "kit" ? "clubInfo" : this.type === "training" ? "training" : "staff"; },
    isPlayer() { return this.type === "player"; }, isGoldRating: () => true, isBronzeRating: () => false, isSilverRating: () => false,
    isStyleModifier() { return this.type === "training" && [250, 251].includes(this.subtype); },
    isManagerLeagueModifier() { return this.type === "training" && this.subtype === 300; },
    isInjuryHealing() { return this.type === "health" && this.subtype === 400; },
    getStaticData: () => ({ name: "Manager" }),
    _auction: { tradeId: String(id), buyNowPrice: price, expires: 1000, tradeOwner: false },
  }, opts);
  return { load, context, page, filters, targets, prices, item, dp, mocks, root };
}

const exactManager = (e, patch = {}) => e.filters.normalizeFilter(Object.assign({ itemGroup: "managers", type: "staff", category: "manager", definitionId: 9001 }, patch));

test("player rating modes migrate, persist and change without a named player", () => {
  const e = env();
  assert.equal(e.filters.normalizeFilter({ minRating: 81, maxRating: 81 }).ratingMode, "exact");
  assert.equal(e.filters.normalizeFilter({ maxRating: 84 }).ratingMode, "range");
  assert.equal(e.filters.normalizeFilter({}).ratingMode, "any");
  e.filters.addFilter({ maxBuy: 700 });
  const target = e.load("app/ui/pages/target.js");
  const fields = e.load("app/ui/fields.js");
  fields.testWriteBound("f:ratingModeChoice", "exact");
  assert.match(e.filters.ratingProblem(e.filters.getActiveFilter()), /Enter an exact/);
  fields.testWriteBound("f:exactRating", 81);
  fields.testWriteBound("f:buyComparison", "below");
  const f = e.filters.getActiveFilter();
  assert.equal(f.player, null); assert.equal(f.minRating, 81); assert.equal(f.maxRating, 81);
  assert.equal(e.filters.filterHasTarget(f), true);
  assert.match(e.filters.describeFilter(f), /rating 81$/);
  const saved = JSON.parse(e.context.window.localStorage.getItem("mb5.filters"));
  const restored = e.filters.normalizeFilter(saved.list.find((entry) => entry.id === f.id));
  assert.equal(restored.ratingMode, "exact"); assert.equal(restored.buyBelow, true);
  assert.equal(e.filters.buyCeilingForFilter(restored), 650);
  assert.match(target.targetPageHtml(), /Exact rating/);
  fields.testWriteBound("f:ratingModeChoice", "range");
  fields.testWriteBound("f:maxRating", 84);
  assert.equal(e.filters.getActiveFilter().minRating, 81);
  assert.equal(e.filters.getActiveFilter().maxRating, 84);
  fields.testWriteBound("f:minRating", 85);
  assert.match(e.filters.ratingProblem(e.filters.getActiveFilter()), /Min rating/);
  fields.testWriteBound("f:ratingModeChoice", "any");
  assert.equal(e.filters.getActiveFilter().minRating, 0); assert.equal(e.filters.getActiveFilter().maxRating, 0);
  assert.equal(e.filters.filterHasTarget(e.filters.getActiveFilter()), false);
});

test("81-rated purchases and preview exclude other ratings and the strict price boundary", async () => {
  const e = tradingEnv(); e.settings.buy.skipGk = false;
  e.page.getPage().UTSearchCriteriaDTO = function () { this.defId = []; this.maskedDefId = 0; };
  e.page.getPage().services.Item = {};
  const f = e.filters.addFilter({ minRating: 81, maxRating: 81, maxBuy: 700, buyBelow: true, sellMode: "fixed", sellPrice: 900 });
  e.m.results = [e.item(1, 650, { type: "player", rating: 81 }), e.item(2, 700, { type: "player", rating: 81 }),
    e.item(3, 600, { type: "player", rating: 80 }), e.item(4, 600, { type: "player", rating: 82 }),
    e.item(5, 600, { type: "player", rating: 0 })];
  assert.equal(e.internals.preflight(), null);
  const preview = await e.internals.runPreviewSearch(f, e.ctx().token);
  assert.equal(preview.maxBuy, 650);
  const eligible = preview.rows.filter((row) => row.match && row.bin <= preview.maxBuy);
  assert.equal(eligible.length, 1);
  await e.internals.snipeCycle(e.ctx(), f, e.internals.effectiveMaxBuy(f), e.settings);
  assert.equal(e.calls.searches[1].maxBuy, 650);
  assert.equal(e.calls.searches[1].maskedDefId, 0);
  assert.equal(e.calls.bids.length, 1); assert.equal(e.calls.bids[0].item.id, 1); assert.equal(e.calls.bids[0].price, 650);
  f.buyBelow = false;
  assert.equal(e.internals.effectiveMaxBuy(f), 700);
  const invalid = e.filters.normalizeFilter({ level: "gold", ratingMode: "range", minRating: 85, maxRating: 81, maxBuy: 700 });
  assert.match((await e.internals.runPreviewSearch(invalid, e.ctx().token)).message, /Min rating/);
  assert.equal(e.calls.searches.length, 2, "invalid ratings never search");
});

test("gold, silver, bronze and special player targets constrain searches, purchases and owned items", async () => {
  for (const [level, rating] of [["gold", 81], ["silver", 70], ["bronze", 60], ["SP", 85]]) {
    const e = tradingEnv(); e.settings.buy.skipGk = false;
    e.page.getPage().UTSearchCriteriaDTO = function () { this.defId = []; };
    e.page.getPage().services.Item = {};
    const card = (id, cardLevel, cardRating) => e.item(id, 650, { type: "player", rating: cardRating,
      isGoldRating: () => cardLevel === "gold", isSilverRating: () => cardLevel === "silver",
      isBronzeRating: () => cardLevel === "bronze", isSpecial: () => cardLevel === "SP" });
    const f = e.filters.addFilter({ level, maxBuy: 700, buyBelow: true });
    const matching = card(1, level, rating);
    const other = card(2, level === "gold" ? "silver" : "gold", level === "gold" ? 70 : 81);
    e.m.results = [matching, other];
    assert.equal(e.internals.preflight(), null);
    assert.equal(e.targets.matchesItem(matching, f), true); assert.equal(e.targets.matchesItem(other, f), false);
    await e.internals.snipeCycle(e.ctx(), f, e.internals.effectiveMaxBuy(f), e.settings);
    assert.equal(e.calls.searches[0].level, level); assert.equal(e.calls.searches[0].maxBuy, 650);
    assert.equal(e.calls.bids.length, 1); assert.equal(e.calls.bids[0].item.id, 1);
    const combined = e.filters.normalizeFilter({ ...f, ratingMode: "exact", minRating: rating + 1, maxRating: rating + 1 });
    assert.equal(e.targets.matchesItem(matching, combined), false);
  }
});

test("strict buy caps preserve price tiers, reference caps and the minimum price boundary", () => {
  const e = env();
  for (const [input, expected] of [[700, 650], [1000, 950], [10000, 9900], [50000, 49750], [100000, 99500], [150, 0]]) {
    const f = e.filters.normalizeFilter({ level: "gold", maxBuy: input, buyBelow: true });
    assert.equal(e.filters.buyCeilingForFilter(f), expected);
    assert.equal(e.filters.buildCriteria(f).maxBuy, expected);
  }
  const automatic = e.filters.normalizeFilter({ player: { id: 12 }, priceMode: "futbin", maxBuy: 700, buyBelow: true, futbinPercent: 90 });
  assert.equal(e.filters.buyCeilingForFilter(automatic, 1000), 650);
  assert.equal(e.filters.buyCeilingForFilter(automatic, 600), 500);
  assert.equal(e.filters.buyCeilingForFilter(automatic, 0), 0);
  assert.equal(e.targets.matchesItem(e.item(1, 600, { type: "player", rating: 0 }), e.filters.normalizeFilter({ maxRating: 81 })), false);
});
const hunterFilter = (e, patch = {}) => e.filters.normalizeFilter(Object.assign({ itemGroup: "consumables", type: "training", category: "playStyle", playStyle: 251,
  priceMode: "futbin", futbinPercent: 80 }, patch));
const chemistryHtml = '<h1>EA FC 27 Chemistry Styles</h1><table class="consumables-table"><tr class="consumableRow" data-name="Hunter" data-price-ps="2000" data-price-pc="3400"></tr><tr class="consumableRow" data-name="Anchor" data-price-ps="1000" data-price-pc="1500"></tr></table>';

test("legacy player defaults, group switching, category criteria and import/save round trips", () => {
  const e = env();
  const legacy = e.filters.normalizeFilter({ player: { id: 12 }, maxBuy: 1000 });
  assert.equal(legacy.itemGroup, "players");
  assert.equal(legacy.futbinPercent, 90);
  const created = e.filters.addFilter(legacy);
  e.filters.updateFilter(created.id, e.targets.switchGroupPatch("managers"));
  const manager = e.filters.getActiveFilter();
  assert.equal(manager.player, null); assert.equal(manager.definitionId, 0);
  assert.equal(manager.futbinPercent, 80); assert.equal(manager.sellPercent, "95");
  assert.equal(manager.position, "any"); assert.equal(e.filters.filterHasTarget(manager), true);
  const broad = e.filters.normalizeFilter({ itemGroup: "club", type: "clubInfo", category: "any" });
  assert.equal(e.filters.filterHasTarget(broad), false);
  const input = exactManager(e, { level: "gold", nation: 18, league: 13, rarities: [1], minBuy: 152, maxBuy: 1066 });
  const criteria = e.filters.buildCriteria(input);
  assert.equal(criteria.type, "staff"); assert.equal(criteria.nation, 18); assert.equal(criteria.minBuy, 200); assert.equal(criteria.maxBuy, 1000);
  const snapshot = e.filters.snapshotFromEaCriteria(criteria, { id: 9001, name: "Manager" });
  assert.equal(snapshot.itemGroup, "managers"); assert.equal(snapshot.player, null);
  const roundtrip = e.filters.normalizeFilter(snapshot);
  assert.equal(roundtrip.definitionId, 9001); assert.deepEqual(Array.from(roundtrip.rarities), [1]);
  const kit = e.filters.normalizeFilter({ itemGroup: "club", type: "clubInfo", category: "kit", authenticity: "authentic", primaryColor: 1, secondaryColor: 2 });
  const imported = e.filters.snapshotFromEaCriteria(e.filters.buildCriteria(kit));
  assert.equal(imported.authenticity, "authentic"); assert.equal(imported.primaryColor, 1); assert.equal(imported.category, "kit");
  assert.equal(e.targets.availableGroups().length, 4);
  e.page.setPageForTests({});
  assert.deepEqual(Array.from(e.targets.availableGroups()), ["players"], "unavailable native categories are hidden");
});

test("matching checks group, native type, exact identity and restrictive criteria", () => {
  const e = env(); const f = exactManager(e, { nation: 18, level: "gold" });
  assert.equal(e.targets.matchesItem(e.item(), f), true);
  assert.equal(e.targets.matchesItem(e.item(1, 1000, { type: "player" }), f), false);
  assert.equal(e.targets.matchesItem(e.item(1, 1000, { definitionId: 9002 }), f), false);
  assert.equal(e.targets.matchesItem(e.item(1, 1000, { nationId: 52 }), f), false);
  const selected = e.targets.targetIdentity(e.item());
  assert.equal(e.targets.matchesItem(e.item(1, 1000, { subtype: 99 }), exactManager(e, { selectedItem: selected })), false);
  const style = e.filters.normalizeFilter({ itemGroup: "consumables", type: "training", category: "playStyle", playStyle: 250 });
  assert.equal(e.targets.matchesItem(e.item(1, 1000, { type: "training", subtype: 250 }), style), true);
  assert.equal(e.targets.matchesItem(e.item(1, 1000, { type: "training", subtype: 300 }), style), false);
});

test("strict FUTBIN adapters preserve edition, platform, grouped quality and absent prices", () => {
  const e = env(); const parser = e.load("app/prices/nonPlayerParse.js");
  const html = '<h1>EA FC 27 Manager Prices</h1><table class="manager-prices-table"><thead><tr><th>Country</th><th><img src="/cards/tiny/0_bronze.png"></th><th><img src="/cards/tiny/0_silver.png"></th><th><img src="/cards/tiny/0_gold.png"></th></tr></thead><tbody><tr><td><img src="/nation/18.png"></td><td class="manager-price no-price">-</td><td class="manager-price platform-ps-only">400</td><td class="manager-price platform-pc-only">700</td><td class="manager-price platform-ps-only">4.4K</td><td class="manager-price platform-pc-only">5K</td></tr></tbody></table>';
  const key = { edition: "27", nation: 18, level: "gold", platform: "console" };
  assert.equal(parser.parseManagerTable(html, key), 4400);
  assert.equal(parser.parseManagerTable(html, { ...key, platform: "pc" }), 5000);
  assert.equal(parser.parseManagerTable(html, { ...key, level: "bronze" }), 0);
  assert.equal(parser.parseManagerTable(html, { ...key, edition: "26" }), 0);
  assert.equal(parser.parseManagerTable(html.replace(/platform-pc-only/g, "unknown"), { ...key, platform: "pc" }), 0);
  const chemistry = '<h1>EA FC 27 Chemistry Styles</h1><table class="consumables-table"><tr class="consumableRow" data-name="Anchor" data-price-ps="2000" data-price-pc="3400"><td class="consumable-max-price">5000</td></tr></table>';
  assert.equal(parser.parseChemistryTable(chemistry, { edition: "27", platform: "pc", name: "Anchor" }), 3400);
  assert.equal(parser.parseChemistryTable(chemistry, { edition: "27", platform: "console", name: "Unknown" }), 0);
  assert.equal(parser.parseChemistryTable(chemistry, { edition: "26", platform: "console", name: "Anchor" }), 0);
});

test("one EA lane spaces reads but dispatches Buy Now ahead of waiting reference reads", async () => {
  const e = env({ "app/core/settings.js": { getSettings: () => ({ timing: { wait: "5", maxPerMinute: 10 }, errors: { cooldown: "1M" } }) } });
  const queue = e.load("app/core/requestQueue.js"); const token = e.load("app/core/async.js").createCancelToken();
  queue.setRequestToken(token);
  const order = [];
  await queue.enqueueEa(async () => { order.push("search"); return { ok: true }; });
  const waiting = queue.enqueueEa(async () => { order.push("reference"); return { ok: true }; });
  const started = performance.now();
  await queue.enqueueEa(async () => { order.push("buy"); return { ok: true }; }, token, true);
  assert.ok(performance.now() - started < 250, "Buy Now does not wait configured 5s search delay");
  assert.deepEqual(order, ["search", "buy"]);
  token.cancel(); await waiting;
  assert.deepEqual(order, ["search", "buy"], "cancelled queued reads never execute");
  queue.resetRequestQueue(); queue.setRequestToken(null);
  await queue.enqueueEa(async () => ({ ok: false, error: { kind: "auth", label: "session expired" } }));
  const fatal = await queue.enqueueEa(async () => { throw Error("must not send"); }, null, true);
  assert.equal(fatal.error.kind, "auth");
});

test("EA reads share configured pacing and urgent purchases still respect rate cooldown", async () => {
  let clock = 1000;
  const e = env({
    "app/core/settings.js": { getSettings: () => ({ timing: { wait: "5", maxPerMinute: 10 }, errors: { cooldown: "1M" } }) },
    "app/core/async.js": { createCancelToken: () => ({ cancel() {} }), sleep: async (ms) => { clock += ms; } },
  });
  e.context.clock = () => clock;
  vm.runInContext("Date.now = () => clock()", e.context);
  const queue = e.load("app/core/requestQueue.js"); const sent = [];
  const read = async () => { sent.push(clock); return { ok: true }; };
  await queue.enqueueEa(read);
  await queue.enqueueEa(read);
  assert.equal(sent[1] - sent[0], 6000);
  await queue.enqueueEa(async () => ({ ok: false, error: { kind: "rate", label: "rate limit" } }));
  const rateAt = clock;
  await queue.enqueueEa(read, null, true);
  assert.equal(sent[2] - rateAt, 60000, "Buy Now bypasses search spacing, never an EA cooldown");
});

function tradingEnv() {
  const calls = { bids: [], listings: [], moves: [], searches: [] };
  const state = { stats: { won: 0 }, transfer: null };
  const reference = { price: 2000, status: "available", fetchedAt: Date.now(), source: "FUTBIN chemistry style" };
  const m = { auctionOf: (i) => i._auction, nameOf: () => "Manager", ratingOf: (i) => i.rating || 0,
    baseIdOf: (i) => i.definitionId & 0xffffff, isGoalkeeper: () => true,
    marketPageSize: () => 20, pileCapacity: () => 100, isPileFull: () => false,
    fetchPriceLimits: async () => ({ min: 150, max: 15000000 }),
    searchMarket: async (criteria) => { calls.searches.push(criteria); return { ok: true, items: m.results || [], latency: 1 }; },
    fetchTransferList: async () => ({ ok: true, items: m.transferItems || [] }),
    bidOnItem: async (item, price) => { calls.bids.push({ item, price }); return { ok: true, latency: 1 }; },
    listOnMarket: async (item, start, price, duration) => { calls.listings.push({ item, start, price, duration }); return { ok: true }; },
    moveItem: async (item, pile) => { calls.moves.push({ item, pile }); return { ok: true }; },
  };
  const priceService = { currentPrice: () => 0, requestPrice: async () => null, getPriceRecord: () => null, trackPrice: () => () => {}, onPriceUpdate: () => () => {} };
  const quoteService = { currentItemQuote: () => reference.price ? reference : null, requestItemQuote: async () => reference };
  const e = env({
    "app/core/market.js": m,
    "app/core/audio.js": { startKeepAlive: () => {}, stopKeepAlive: () => {}, unlockAudio: () => {} },
    "app/core/notify.js": { notifyEvent: () => {}, sound: () => {} },
    "app/core/logger.js": { log: new Proxy({}, { get: () => () => {} }), errorMessage: String },
    "app/core/state.js": { getState: () => state, bumpStat: (key, n = 1) => { state.stats[key] = (state.stats[key] || 0) + n; }, updateState: () => {}, recordSearch: () => {}, recordTransaction: () => {}, resetStats: () => {} },
    "app/prices/priceService.js": priceService,
    "app/prices/nonPlayerQuotes.js": quoteService,
  });
  const internals = e.load("app/core/engine.js").testInternals;
  const settings = e.load("app/core/settings.js").getSettings();
  const ctx = () => ({ token: e.load("app/core/async.js").createCancelToken(), attempted: new Set(), retries: new Map(), bids: new Map(), warned: new Set(), sellQueue: [],
    searchCount: 0, searchesSincePause: 0, filterSearches: 0, bidSearchCounter: 0, page: 1, tracked: new Map(), filterIndex: 0, userWatched: new Set(), notBefore: 0 });
  return Object.assign(e, { m, calls, state, reference, internals, settings, ctx });
}

const bidOnlyFilter = (e, patch = {}) => e.filters.normalizeFilter({ definitionId: 9001, tradeMode: "bidOnly", maxBid: 700, bidExpiresWithin: "90S", ...patch });
const bidPlayer = (e, id, patch = {}) => e.item(id, 2000, { type: "player", rating: 81,
  _auction: { tradeId: String(id), buyNowPrice: 2000, startingBid: 150, currentBid: 0, expires: 60, ...patch } });
const readyForTrading = (e) => {
  e.page.getPage().UTSearchCriteriaDTO = function () { this.defId = []; this.maskedDefId = 0; this.maxBuy = 0; this.minBuy = 0; };
  e.page.getPage().services.Item = {};
};

test("bid-only filters persist exact amount and time, reject incomplete targets, and leave old filters unchanged", () => {
  const e = tradingEnv(); readyForTrading(e);
  assert.equal(e.filters.normalizeFilter({ maxBuy: 700 }).tradeMode, "standard");
  const f = e.filters.addFilter(bidOnlyFilter(e, { definitionId: 0, player: { id: 9001 } }));
  assert.match(e.internals.preflight(), /exact card version/);
  e.filters.updateFilter(f.id, { definitionId: 9001, maxBid: 0 });
  assert.match(e.internals.preflight(), /bid amount/);
  e.filters.updateFilter(f.id, { maxBid: 700, bidExpiresWithin: "0S" });
  assert.match(e.internals.preflight(), /positive auction ending window/);
  e.filters.updateFilter(f.id, { bidExpiresWithin: "90S" });
  assert.equal(e.internals.preflight(), null, "global bidding can remain disabled");
  const saved = JSON.parse(e.context.window.localStorage.getItem("mb5.filters"));
  const restored = e.filters.normalizeFilter(saved.list.find((v) => v.id === f.id));
  assert.equal(restored.tradeMode, "bidOnly"); assert.equal(restored.bidExpiresWithin, "90S"); assert.equal(restored.maxBid, 700);
});

test("bid-only bids exactly 700 on the chosen version, with no Buy Now or FUTBIN dependency", async () => {
  const e = tradingEnv(); readyForTrading(e); e.settings.buy.skipGk = false;
  const f = e.filters.addFilter(bidOnlyFilter(e, { maxBuy: 5000, minBuy: 1000, priceMode: "futbin" }));
  e.m.results = [bidPlayer(e, 1, { expires: 90, currentBid: 600 }), bidPlayer(e, 2, { expires: 91 }),
    Object.assign(bidPlayer(e, 3), { definitionId: 16786217 }), bidPlayer(e, 4, { buyNowPrice: 650 }),
    bidPlayer(e, 5, { tradeOwner: true }), bidPlayer(e, 6, { currentBid: 700 }),
    bidPlayer(e, 7, { startingBid: 750 }), bidPlayer(e, 8, { expires: -1 })];
  assert.equal(e.internals.preflight(), null);
  assert.equal(e.internals.effectiveMaxBuy(f), 0);
  assert.equal(e.filters.buyCeilingForFilter(f, 10000), 0);
  assert.equal(e.internals.nextFilter(e.ctx(), e.settings).maxBuy, 0);
  await e.internals.snipeCycle(e.ctx(), f, 5000, e.settings);
  assert.deepEqual(Array.from(e.calls.searches[0].defId), [9001]);
  assert.equal(e.calls.searches[0].maxBuy, 0); assert.equal(e.calls.searches[0].minBuy, 0); assert.equal(e.calls.searches[0].maxBid, 700);
  assert.equal(e.calls.bids.length, 1); assert.equal(e.calls.bids[0].price, 700); assert.equal(e.calls.bids[0].item.id, 1);
  assert.equal(e.state.stats.won || 0, 0, "placing a bid is not a Buy Now purchase");
});

test("bid plans respect expiry, minimum increments and Buy Now boundaries", () => {
  const e = tradingEnv(); const bidding = e.load("app/core/bidding.js");
  const rules = bidding.bidRulesForFilter(bidOnlyFilter(e), e.settings);
  for (const [patch, expected] of [
    [{ expires: 90 }, 700], [{ expires: 91 }, 0], [{ expires: 0 }, 0], [{ expires: -1 }, 0], [{ expires: NaN }, 0],
    [{ currentBid: 650 }, 700], [{ currentBid: 700 }, 0], [{ startingBid: 750 }, 0],
    [{ buyNowPrice: 700 }, 0], [{ buyNowPrice: 650 }, 0], [{ buyNowPrice: 750 }, 700], [{ tradeOwner: true }, 0],
  ]) assert.equal(bidding.bidPriceForAuction(bidPlayer(e, 1, patch)._auction, rules), expected, JSON.stringify(patch));
  const standard = bidding.bidRulesForFilter(e.filters.normalizeFilter({ maxBid: 700 }), { bid: { enabled: true, exact: false, expiresWithin: "5M" } });
  assert.equal(bidding.bidPriceForAuction(bidPlayer(e, 1, { currentBid: 600 })._auction, standard), 650);
});

test("bid-only previews can select a version and show exact eligible bids without placing them", async () => {
  const e = tradingEnv(); readyForTrading(e);
  const broad = bidOnlyFilter(e, { definitionId: 0, player: { id: 9001 }, priceMode: "futbin" });
  e.m.results = [bidPlayer(e, 1, { expires: 45 }), bidPlayer(e, 2, { expires: 100 }), bidPlayer(e, 3, { buyNowPrice: 700 })];
  const selection = await e.internals.runPreviewSearch(broad, e.ctx().token);
  assert.equal(selection.ok, true); assert.equal(selection.needsExactCard, true);
  assert.ok(selection.rows.every((row) => !row.bidAmount));
  assert.equal(e.calls.bids.length, 0);
  const preview = await e.internals.runPreviewSearch({ ...broad, definitionId: 9001 }, e.ctx().token);
  assert.equal(preview.bidOnly, true); assert.equal(preview.maxBuy, 0); assert.equal(preview.bidAmount, 700);
  assert.equal(preview.rows.filter((row) => row.bidAmount).length, 1);
  assert.equal(preview.rows.find((row) => row.bidAmount).bidAmount, 700);
  assert.equal(e.calls.bids.length, 0); assert.equal(e.calls.searches[0].maxBid, 700);
});

test("bid-only respects reserves, duplicate bids, active limits and expiry while earlier bids are in flight", async () => {
  const e = tradingEnv(); const f = bidOnlyFilter(e);
  e.settings.buy.skipGk = false; e.m.results = [bidPlayer(e, 1)];
  const ctx = e.ctx(); e.settings.buy.coinsReserve = 9500;
  await e.internals.snipeCycle(ctx, f, 0, e.settings);
  assert.equal(e.calls.bids.length, 0);
  e.settings.buy.coinsReserve = 0; ctx.userWatched.add("1");
  await e.internals.snipeCycle(ctx, f, 0, e.settings); assert.equal(e.calls.bids.length, 0);
  ctx.userWatched.clear(); ctx.bids.set("other", {}); e.settings.bid.maxActive = 1;
  await e.internals.snipeCycle(ctx, f, 0, e.settings); assert.equal(e.calls.bids.length, 0);
  ctx.bids.clear();
  await e.internals.snipeCycle(ctx, f, 0, e.settings); await e.internals.snipeCycle(ctx, f, 0, e.settings);
  assert.equal(e.calls.bids.length, 1, "the same auction is not bid on twice");
  let clock = 10000; e.context.bidClock = () => clock; vm.runInContext("Date.now = () => bidClock()", e.context);
  e.settings.bid.maxPerSearch = 5; e.settings.bid.maxActive = 10;
  e.m.results = [bidPlayer(e, 2, { expires: 1 }), bidPlayer(e, 3, { expires: 2 })];
  e.m.bidOnItem = async (item, price) => { e.calls.bids.push({ item, price }); clock += 3000; return { ok: true }; };
  await e.internals.snipeCycle(e.ctx(), f, 0, e.settings);
  assert.equal(e.calls.bids.length, 2, "the second auction expired before its bid could be sent");
});

test("tracked bid-only auctions retain fixed rules when rebidding and process wins", async () => {
  const e = tradingEnv(); const f = bidOnlyFilter(e);
  e.settings.buy.skipGk = false; e.settings.bid.clearLost = false;
  const item = bidPlayer(e, 1); e.m.results = [item]; const ctx = e.ctx();
  await e.internals.snipeCycle(ctx, f, 0, e.settings);
  const tracked = ctx.bids.get("1"); f.maxBid = 1000; f.bidExpiresWithin = "10M";
  assert.equal(tracked.filter.maxBid, 700); assert.equal(tracked.filter.bidExpiresWithin, "90S");
  e.m.fetchWatchList = async () => ({ ok: true, items: [item] });
  e.m.refreshAuctions = async () => ({ ok: true });
  item._auction = { ...item._auction, currentBid: 600, isOutbid: () => true };
  await e.internals.checkBids(ctx, true);
  assert.equal(e.calls.bids.length, 2); assert.equal(e.calls.bids[1].price, 700);
  item._auction.currentBid = 700;
  await e.internals.checkBids(ctx, true);
  assert.equal(e.calls.bids.length, 2); assert.equal(ctx.bids.size, 0, "never raises above the frozen amount");
  ctx.bids.set("1", tracked); item._auction.currentBid = 600; item._auction.expires = 120;
  await e.internals.checkBids(ctx, true);
  assert.equal(e.calls.bids.length, 2, "auction extension outside the ending window prevents a rebid");
  ctx.bids.set("1", tracked); item._auction = { ...item._auction, currentBid: 700, expires: -1, isWon: () => true };
  await e.internals.checkBids(ctx, true);
  assert.equal(e.state.stats.won, 1); assert.equal(e.state.stats.spent, 700); assert.equal(ctx.sellQueue.length, 1);
});

test("mocked non-player purchase respects reserves, player-only rules and immutable sale configuration", async () => {
  const e = tradingEnv(); const f = exactManager(e, { maxBuy: 1000, sellMode: "fixed", sellPrice: 2000 });
  e.settings.buy.skipGk = true;
  e.m.results = [e.item(1), e.item(2, 900, { type: "player" })];
  let ctx = e.ctx();
  e.settings.buy.coinsReserve = 9500;
  await e.internals.snipeCycle(ctx, f, 1000, e.settings);
  assert.equal(e.calls.bids.length, 0);
  e.settings.buy.coinsReserve = 0;
  await e.internals.snipeCycle(ctx, f, 1000, e.settings);
  assert.equal(e.calls.bids.length, 1); assert.equal(e.calls.bids[0].price, 1000);
  assert.equal(ctx.sellQueue.length, 1, "manager survives skip-goalkeepers rule");
  f.sellPrice = 800; e.settings.sell.defaultPrice = 600;
  assert.equal(ctx.sellQueue[0].filter.sellPrice, 2000);
  await e.internals.sellJob(ctx, ctx.sellQueue[0]);
  assert.equal(e.calls.listings[0].price, 2000);
  assert.equal(e.calls.listings[0].duration, 3600);
  assert.equal(e.state.stats.estProfit, 900, "5% tax is included");
});

test("mocked sales obey EA bounds, minimum profit, full transfer list and missing references", async () => {
  const e = tradingEnv(); const fixed = exactManager(e, { sellMode: "fixed", sellPrice: 2000 });
  const job = () => ({ item: e.item(), buyPrice: 1000, filter: fixed, name: "Manager", rating: 80 });
  e.m.fetchPriceLimits = async () => ({ min: 500, max: 1500 });
  await e.internals.sellJob(e.ctx(), job());
  assert.equal(e.calls.listings[0].price, 1500); assert.ok(e.calls.listings[0].start >= 500);
  e.settings.sell.minProfit = 500;
  await e.internals.sellJob(e.ctx(), job());
  assert.equal(e.calls.listings.length, 1); assert.equal(e.calls.moves.length, 1);
  e.settings.sell.minProfit = 0;
  e.m.isPileFull = () => true;
  const full = e.ctx(); await e.internals.sellJob(full, job());
  assert.equal(full.fullStop, true); assert.equal(e.calls.listings.length, 1);
  e.m.isPileFull = () => false;
  e.reference.price = 0;
  const automatic = { ...job(), filter: exactManager(e, { sellMode: "futbin", selectedItem: e.targets.targetIdentity(e.item()) }) };
  await e.internals.sellJob(e.ctx(), automatic);
  assert.equal(e.calls.moves.length, 2, "missing resale reference moves without listing");
  e.m.fetchPriceLimits = async () => ({ min: 1000, max: 1000 });
  await e.internals.sellJob(e.ctx(), job());
  assert.equal(e.calls.listings.length, 1, "impossible price limits never list");
});

test("automatic buy ceilings round down and cap; mixed rotation prepares missing item references", () => {
  const e = tradingEnv(); const automatic = exactManager(e, { priceMode: "futbin", futbinPercent: 80, maxBuy: 1500 });
  assert.equal(e.internals.effectiveMaxBuy(automatic), 1500);
  automatic.maxBuy = 0; e.reference.price = 2099;
  assert.equal(e.internals.effectiveMaxBuy(automatic), 1600);
  e.reference.price = 0; assert.equal(e.internals.effectiveMaxBuy(automatic), 0);
  const fixed = e.filters.addFilter({ name: "player", player: { id: 12 }, maxBuy: 800 });
  const item = e.filters.addFilter(automatic);
  e.filters.setRotation({ enabled: true, every: 1 });
  const ctx = e.ctx();
  assert.equal(e.internals.nextFilter(ctx, e.settings).filter.id, fixed.id);
  e.reference.price = 2000; ctx.filterSearches = 1;
  assert.equal(e.internals.nextFilter(ctx, e.settings).filter.id, item.id);
});

test("non-player bids respect category, expiry window, explicit cap and frozen sale settings", async () => {
  const e = tradingEnv(); const f = exactManager(e, { maxBid: 900, sellMode: "fixed", sellPrice: 2000 });
  e.settings.bid.enabled = true; e.settings.bid.expiresWithin = "5M"; e.settings.bid.exact = false;
  const auction = (id, patch = {}) => ({ tradeId: String(id), buyNowPrice: 2000, startingBid: 500, expires: 30, ...patch });
  e.m.results = [e.item(1, 0, { _auction: auction(1) }), e.item(2, 0, { _auction: auction(2, { expires: 600 }) }),
    e.item(3, 0, { _auction: auction(3, { currentBid: 900 }) }), e.item(4, 0, { type: "player", _auction: auction(4) })];
  const ctx = e.ctx(); await e.internals.snipeCycle(ctx, f, 0, e.settings);
  assert.equal(e.calls.searches[0].type, "staff"); assert.equal(e.calls.searches[0].maxBid, 900);
  assert.equal(e.calls.bids.length, 1); assert.equal(e.calls.bids[0].price, 500);
  f.sellPrice = 400; e.settings.sell.duration = "3H";
  assert.equal(ctx.bids.get("1").filter.sellPrice, 2000); assert.equal(ctx.bids.get("1").sell.duration, "1H");
});

test("reference relisting touches only enabled matching expired targets and leaves missing prices unchanged", async () => {
  const e = tradingEnv(); e.filters.addFilter(exactManager(e, { sellMode: "futbin" }));
  e.filters.addFilter(exactManager(e, { enabled: false, definitionId: 9999, sellMode: "futbin" }));
  const expired = (id, definitionId) => e.item(id, 2000, { definitionId, _auction: { tradeId: String(id), expires: -1, isExpired: () => true } });
  e.m.transferItems = [expired(1, 9001), expired(2, 9999), e.item(3)];
  const ctx = e.ctx(); await e.internals.relistAtFutbin(ctx, e.m.transferItems);
  assert.equal(e.calls.listings.length, 1); assert.equal(e.calls.listings[0].item.id, 1); assert.equal(e.calls.listings[0].price, 1900);
  e.reference.price = 0; await e.internals.relistAtFutbin(ctx, e.m.transferItems);
  assert.equal(e.calls.listings.length, 1);
});

test("bulk preview matches selected criteria and skips active, sold, untradeable, unknown cost and missing prices", async () => {
  const e = tradingEnv(); const bulk = e.load("app/core/bulkSell.js");
  const available = e.item(1, 0, { _auction: null });
  const expired = e.item(2, 2000, { _auction: { tradeId: "2", expires: -1, isExpired: () => true } });
  const sold = e.item(3, 2000, { _auction: { tradeId: "3", expires: -1, isSold: () => true } });
  const untradeable = e.item(4, 0, { _auction: null, tradable: false });
  const other = e.item(5, 0, { _auction: null, definitionId: 9999 });
  const f = exactManager(e, { sellMode: "fixed", sellPrice: 2000 });
  e.m.transferItems = [available, expired, e.item(6), sold, untradeable, other];
  const preview = await bulk.previewMatchingItems({ filter: f, token: e.ctx().token });
  assert.equal(preview.rows.length, 2); assert.equal(e.calls.listings.length, 0);
  f.sellPrice = 400;
  const report = await bulk.listMatchingPreview({ preview, token: e.ctx().token });
  assert.equal(report.listed, 2); assert.equal(e.calls.listings[0].price, 2000);
  e.settings.sell.minProfit = 100;
  const unknownCost = await bulk.previewMatchingItems({ filter: preview.filter, token: e.ctx().token });
  assert.ok(unknownCost.rows.every((r) => /cost unknown/.test(r.reason)));
  e.settings.sell.minProfit = 0; e.reference.price = 0;
  const missing = await bulk.previewMatchingItems({ filter: exactManager(e, { sellMode: "futbin" }), token: e.ctx().token });
  assert.ok(missing.rows.every((r) => r.reason));
  const broad = await bulk.previewMatchingItems({ filter: exactManager(e, { definitionId: 0, sellMode: "futbin" }), token: e.ctx().token });
  assert.ok(broad.rows.every((r) => /fixed/.test(r.reason)));
  const untargeted = await bulk.previewMatchingItems({ filter: e.filters.normalizeFilter({ sellMode: "fixed", sellPrice: 2000 }), token: e.ctx().token });
  assert.equal(untargeted.ok, false); assert.equal(untargeted.rows.length, 0);
});

test("bulk execution rechecks active state, stale references, cancellation and changed EA limits", async () => {
  const e = tradingEnv(); const bulk = e.load("app/core/bulkSell.js"); const token = e.ctx().token;
  const available = e.item(1, 0, { _auction: null }); e.m.transferItems = [available];
  let preview = await bulk.previewMatchingItems({ filter: exactManager(e, { sellMode: "futbin" }), token });
  preview.rows[0].quote.fetchedAt = Date.now() - 61000; e.reference.price = 3000;
  assert.equal((await bulk.listMatchingPreview({ preview, token })).listed, 0);
  preview = await bulk.previewMatchingItems({ filter: exactManager(e, { sellMode: "fixed", sellPrice: 2000 }), token });
  available._auction = { tradeId: "1", expires: 1000 };
  assert.equal((await bulk.listMatchingPreview({ preview, token })).listed, 0);
  available._auction = null; e.m.fetchPriceLimits = async () => ({ min: 150, max: 1500 });
  assert.equal((await bulk.listMatchingPreview({ preview, token })).listed, 0);
  token.cancel(); assert.equal((await bulk.listMatchingPreview({ preview, token })).listed, 0);
});

test("external references preserve cache age, platform separation and specific-item restriction", async () => {
  let platform = "console"; let futbinRequests = 0;
  const e = env({
    "app/prices/futbinClient.js": { futbinYear: () => "27", fetchFutbinText: async () => { futbinRequests += 1; return { ok: true, text: chemistryHtml }; } },
    "app/prices/priceService.js": { pricePlatform: () => platform },
  });
  const quotes = e.load("app/prices/nonPlayerQuotes.js");
  const f = hunterFilter(e);
  const first = await quotes.requestItemQuote(f); assert.equal(first.source, "FUTBIN chemistry style");
  await quotes.requestItemQuote(f); assert.equal(futbinRequests, 1);
  first.fetchedAt -= 61000;
  assert.equal(quotes.currentItemQuote(f, 60000), null); assert.ok(quotes.currentItemQuote(f));
  const refreshed = await quotes.requestItemQuote(f, { maxAge: 60000 }); assert.ok(refreshed.fetchedAt > first.fetchedAt);
  platform = "pc"; assert.equal(quotes.currentItemQuote(f), null);
  assert.equal((await quotes.requestItemQuote(f)).price, 3400);
  const broad = await quotes.requestItemQuote(exactManager(e, { definitionId: 0 }));
  assert.equal(broad.price, 0);
  const restricted = exactManager(e, { selectedItem: e.targets.targetIdentity(e.item()), league: 13 });
  assert.equal((await quotes.requestItemQuote(restricted)).price, 0);
  assert.equal(futbinRequests, 1, "league-modified manager skips grouped FUTBIN reference");
});

test("a native Hunter choice fetches FUTBIN without a result, separates styles/platforms and rejects broad choices", async () => {
  let platform = "console"; let reads = 0;
  const e = env({
    "app/prices/futbinClient.js": { futbinYear: () => "27", fetchFutbinText: async (url) => {
      assert.equal(url, "https://www.futbin.com/consumables"); reads += 1; return { ok: true, text: chemistryHtml };
    } },
    "app/prices/priceService.js": { pricePlatform: () => platform },
  });
  const quotes = e.load("app/prices/nonPlayerQuotes.js"); const f = hunterFilter(e);
  assert.equal(f.definitionId, 0); assert.equal(f.selectedItem, null);
  assert.equal(e.targets.hasExactTarget(f), false); assert.equal(e.targets.hasReferenceTarget(f), true);
  const quote = await quotes.requestItemQuote(f);
  assert.equal(quote.price, 2000); assert.equal(quote.source, "FUTBIN chemistry style"); assert.equal(quote.referenceIdentity, "style:Hunter");
  const anchor = hunterFilter(e, { playStyle: 250 });
  assert.equal(quotes.currentItemQuote(anchor), null);
  assert.equal((await quotes.requestItemQuote(anchor)).price, 1000); assert.equal(reads, 1, "styles share the fetched table, never the reference");
  platform = "pc"; assert.equal(quotes.currentItemQuote(f), null);
  assert.equal((await quotes.requestItemQuote(f)).price, 3400);
  for (const patch of [{ playStyle: -1 }, { playStyle: 999 }, { category: "managerLeague" }, { type: "development" }]) {
    const invalid = hunterFilter(e, patch);
    assert.equal(e.targets.hasReferenceTarget(invalid), false);
    assert.equal((await quotes.requestItemQuote(invalid)).price, 0);
  }
  assert.equal(reads, 1);
});

test("failed external references never search EA, including retries, unsupported items and cancellation", async () => {
  for (const failure of [{ ok: false, status: 403 }, { ok: false, status: 429 }, { ok: false, status: 503 }, { ok: false, status: 0 },
    { ok: true, text: "<h1>EA FC 26 Chemistry Styles</h1>" }]) {
    let searches = 0; let externalReads = 0;
    const e = env({
      "app/prices/futbinClient.js": { futbinYear: () => "27", fetchFutbinText: async () => { externalReads += 1; return failure; } },
      "app/prices/priceService.js": { pricePlatform: () => "console" },
      "app/core/market.js": { searchMarket: async () => { searches += 1; throw Error("EA lookup must never run"); } },
    });
    const quotes = e.load("app/prices/nonPlayerQuotes.js"); const f = hunterFilter(e);
    assert.equal((await quotes.requestItemQuote(f)).price, 0);
    await quotes.requestItemQuote(f); assert.equal(externalReads, 1, "unavailable references are cached");
    await quotes.requestItemQuote(f, { force: true });
    assert.equal((await quotes.requestItemQuote(exactManager(e, { selectedItem: e.targets.targetIdentity(e.item()) }))).price, 0);
    const unsupported = exactManager(e, { selectedItem: e.targets.targetIdentity(e.item()), league: 13 });
    assert.match((await quotes.requestItemQuote(unsupported)).reason, /EA price lookup is disabled/);
    assert.equal((await quotes.requestItemQuote(f, { force: true, token: { cancelled: true } })).reason, "cancelled");
    assert.equal(searches, 0);
  }
});

test("Hunter percentage pricing passes preflight and read-only preview, and still waits for a missing quote", async () => {
  const e = tradingEnv(); const native = e.page.getPage(); native.UTSearchCriteriaDTO = function () { this.defId = []; };
  native.services.Item = {};
  const f = e.filters.addFilter(hunterFilter(e, { sellMode: "futbin", sellPercent: "95" }));
  assert.equal(e.internals.preflight(), null); assert.equal(e.internals.effectiveMaxBuy(f), 1600);
  const preview = await e.internals.runPreviewSearch(f, e.ctx().token);
  assert.equal(preview.ok, true); assert.equal(e.calls.searches[0].playStyle, 251); assert.equal(e.calls.searches[0].maxBuy, 1600);
  assert.equal(e.calls.bids.length, 0);
  const bulk = e.load("app/core/bulkSell.js");
  const resale = await bulk.matchingListingPrice(e.item(1, 1000, { type: "training", subtype: 251 }), f, e.settings.sell, e.ctx().token);
  assert.equal(resale.price, 1900, "a specific style permits reference resale using the owned item's exact identity");
  assert.equal(e.calls.listings.length, 0, "price calculation never lists an item");
  e.reference.price = 0;
  assert.equal(e.internals.effectiveMaxBuy(f), 0);
  assert.match((await e.internals.runPreviewSearch(f, e.ctx().token)).message, /Reference unavailable/);
  e.filters.updateFilter(f.id, { playStyle: -1 });
  assert.match(e.internals.preflight(), /specific item/);
});

test("chemistry selection clears an old exact item, displays its quote and makes unavailable references retryable", async () => {
  const e = env({
    "app/core/engine.js": { isRunning: () => false },
    "app/prices/futbinClient.js": { futbinYear: () => "27", fetchFutbinText: async () => ({ ok: true, text: chemistryHtml }) },
    "app/prices/priceService.js": { pricePlatform: () => "console", currentPrice: () => 0, getPriceRecord: () => null, onPriceUpdate: () => () => {}, trackPrice: () => () => {} },
  });
  e.context.setInterval = () => 0;
  const f = e.filters.addFilter(hunterFilter(e, { definitionId: 9001, selectedItem: e.targets.targetIdentity(e.item(1, 1000, { type: "training", subtype: 250 })) }));
  const target = e.load("app/ui/pages/target.js"); const fields = e.load("app/ui/fields.js");
  fields.testWriteBound("f:playStyleChoice", "251");
  const active = e.filters.getActiveFilter();
  assert.equal(active.definitionId, 0); assert.equal(active.selectedItem, null); assert.equal(active.priceMode, "futbin");
  const quotes = e.load("app/prices/nonPlayerQuotes.js"); await quotes.requestItemQuote(active);
  assert.match(target.targetPageHtml(), /style:Hunter/); assert.match(target.targetPageHtml(), /max buy <b>1,600/);
  fields.testWriteBound("f:playStyleChoice", "250");
  assert.doesNotMatch(target.targetPageHtml(), /style:Hunter/);
  fields.testWriteBound("f:playStyleChoice", "-1");
  assert.match(target.targetPageHtml(), /Choose a specific chemistry style/);
  e.dp.getPlayStyleDP = () => [{ id: 252, value: "252", label: "Unknown localized style" }];
  e.filters.updateFilter(f.id, { playStyle: 252 });
  const unavailable = await quotes.requestItemQuote(e.filters.getActiveFilter());
  assert.equal(unavailable.price, 0); assert.match(quotes.itemQuoteRecord(e.filters.getActiveFilter()).reason, /no usable price/);
  assert.match(target.targetPageHtml(), /no usable price/); assert.match(target.targetPageHtml(), /Refresh reference/);
});

test("target controls reset dependent criteria and reject a Test search completed after target changes", async () => {
  let finish;
  const e = env({
    "app/core/engine.js": { isRunning: () => false, previewSearch: () => new Promise((resolve) => { finish = resolve; }) },
    "app/prices/priceService.js": { currentPrice: () => 0, getPriceRecord: () => null, onPriceUpdate: () => () => {}, trackPrice: () => () => {} },
    "app/prices/nonPlayerQuotes.js": { currentItemQuote: () => null, itemQuoteRecord: () => null, onItemQuote: () => () => {} },
  });
  e.context.setInterval = () => 0;
  const f = e.filters.addFilter(exactManager(e, { level: "gold", league: 13, club: 20, rarities: [1] }));
  const target = e.load("app/ui/pages/target.js"); const fields = e.load("app/ui/fields.js");
  fields.testWriteBound("f:leagueChoice", "-1"); assert.equal(e.filters.getActiveFilter().club, -1);
  fields.testWriteBound("f:levelChoice", "bronze"); assert.equal(e.filters.getActiveFilter().rarities.length, 0);
  const elements = new Map(); const handlers = {};
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: "", hidden: true, value: "", addEventListener() {}, setAttribute() {} });
    return elements.get(selector);
  };
  const page = { querySelector: element, querySelectorAll: () => [], addEventListener: (name, fn) => { handlers[name] = fn; } };
  target.bindTargetPage(page, () => {});
  const button = { dataset: { targetAction: "preview" }, disabled: false };
  const pending = handlers.click({ target: { closest: (s) => s === "[data-target-action]" ? button : null } });
  assert.match(element("[data-preview]").innerHTML, /Searching/);
  e.filters.updateFilter(f.id, { nation: 52 });
  assert.equal(element("[data-preview]").innerHTML, "");
  finish({ ok: true, rows: [{ name: "Old result", target: { group: "managers" }, definitionId: 123, match: true }], latency: 1 });
  await pending;
  assert.equal(element("[data-preview]").innerHTML, "", "late completion never restores stale results");
  await handlers.click({ target: { closest: (s) => s === "[data-exact-result]" ? { dataset: { exactResult: "0" } } : null } });
  assert.equal(e.filters.getActiveFilter().definitionId, 9001, "a stale result button cannot change the exact target");
  const successful = handlers.click({ target: { closest: (s) => s === "[data-target-action]" ? button : null } });
  finish({ ok: true, rows: [{ name: "Current result", target: { group: "managers" }, definitionId: 9001, match: true }], latency: 1 });
  await successful;
  assert.match(element("[data-preview]").innerHTML, /Current result/);
  element("[data-preview]").__mbHtml = "";
  e.filters.updateFilter(f.id, { nation: 18 });
  assert.equal(element("[data-preview]").innerHTML, "", "previous empty render cache cannot keep old results visible");
  assert.equal(button.disabled, false); assert.equal(element('[data-target-action="stop-preview"]').hidden, true);
});

test("item groups recover when EA native providers load after the panel mounts", () => {
  const e = env({
    "app/core/engine.js": { isRunning: () => false },
    "app/prices/priceService.js": { currentPrice: () => 0, getPriceRecord: () => null, onPriceUpdate: () => () => {}, trackPrice: () => () => {} },
    "app/prices/nonPlayerQuotes.js": { currentItemQuote: () => null, itemQuoteRecord: () => null, onItemQuote: () => () => {} },
  });
  e.context.setInterval = () => 0;
  const readyPage = e.page.getPage();
  e.filters.addFilter({ name: "Saved player", player: { id: 12 }, maxBuy: 1000 });
  const saved = JSON.stringify(e.filters.getActiveFilter());
  e.page.setPageForTests({});
  const target = e.load("app/ui/pages/target.js");
  const elements = new Map(); let refreshes = 0;
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: "", hidden: true, value: "", addEventListener() {}, setAttribute() {} });
    return elements.get(selector);
  };
  const page = { querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const refreshRuntime = target.bindTargetPage(page, () => { refreshes += 1; });
  const select = element('[data-bind="f:itemGroupChoice"]');
  assert.match(select.innerHTML, /Players/); assert.doesNotMatch(select.innerHTML, /Managers/);
  e.page.setPageForTests(readyPage);
  refreshRuntime();
  assert.match(select.innerHTML, /Managers/); assert.match(select.innerHTML, /Club items/); assert.match(select.innerHTML, /Consumables/);
  assert.equal(JSON.stringify(e.filters.getActiveFilter()), saved, "hydration preserves the saved player target and prices");
  const refreshed = refreshes; refreshRuntime(); assert.equal(refreshes, refreshed, "unchanged native providers do not rebuild the form");
  e.filters.updateFilter(e.filters.getActiveFilter().id, e.targets.switchGroupPatch("consumables"));
  refreshRuntime(); assert.match(element("[data-category-fields]").innerHTML, /Chemistry style/);
});
