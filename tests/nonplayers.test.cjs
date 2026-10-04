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
    if (filename.endsWith("engine.js")) source += '\nexport const testInternals = { effectiveMaxBuy, preflight, nextFilter, analyzeResults, attemptBuy, snipeCycle, sellJob, queueSale, relistAtFutbin };';
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
    getPlayStyleDP: () => [entry(-1, "-1", "All"), entry(250, "250", "Anchor")],
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
    isStyleModifier() { return this.type === "training" && this.subtype === 250; },
    isManagerLeagueModifier() { return this.type === "training" && this.subtype === 300; },
    isInjuryHealing() { return this.type === "health" && this.subtype === 400; },
    getStaticData: () => ({ name: "Manager" }),
    _auction: { tradeId: String(id), buyNowPrice: price, expires: 1000, tradeOwner: false },
  }, opts);
  return { load, context, page, filters, targets, prices, item, dp, mocks, root };
}

const exactManager = (e, patch = {}) => e.filters.normalizeFilter(Object.assign({ itemGroup: "managers", type: "staff", category: "manager", definitionId: 9001 }, patch));

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

test("EA discovery finds third cheapest beyond arbitrary expensive first pages, deduplicates and excludes own", async () => {
  const e = env({ "app/core/market.js": { auctionOf: (i) => i._auction, marketPageSize: () => 20, searchMarket: () => { throw Error("must mock search"); } } });
  const discover = e.load("app/prices/eaQuote.js").discoverEaQuote;
  const items = [e.item(1, 800), e.item(1, 800), e.item(2, 900), e.item(3, 1000), e.item(4, 150, { _auction: { tradeId: "4", buyNowPrice: 150, expires: 100, tradeOwner: true } }), ...Array.from({ length: 100 }, (_, i) => e.item(100 + i, 10000 + i * 250))].reverse();
  const caps = [];
  const result = await discover(exactManager(e), { search: async (criteria, page) => {
    caps.push(criteria.maxBuy);
    const hits = items.filter((i) => i._auction.buyNowPrice <= criteria.maxBuy);
    return { ok: true, items: hits.slice((page - 1) * 20, page * 20 + 1) };
  } });
  assert.equal(result.price, 1000); assert.ok(result.requests <= 20); assert.equal(result.status, "available");
  assert.equal(caps[caps.length - 1], 1000); assert.equal(caps[caps.length - 2], 1000);
});

test("EA sparse, unstable, exhausted and cancelled discovery is unavailable", async () => {
  const e = env({ "app/core/market.js": { auctionOf: (i) => i._auction, marketPageSize: () => 20 } });
  const discover = e.load("app/prices/eaQuote.js").discoverEaQuote;
  const searchFor = (items) => async (c) => ({ ok: true, items: items.filter((i) => i._auction.buyNowPrice <= c.maxBuy) });
  assert.equal((await discover(exactManager(e), { search: searchFor([e.item(1), e.item(2)]) })).price, 0);
  assert.equal((await discover(exactManager(e), { search: searchFor([e.item(1), e.item(2), e.item(3)]), budget: 2 })).price, 0);
  let calls = 0;
  const unstable = await discover(exactManager(e), { search: async (c) => {
    calls += 1;
    const items = [e.item(1), e.item(2), e.item(calls > 14 ? calls : 3)];
    return searchFor(items)(c);
  } });
  assert.equal(unstable.price, 0);
  const token = { cancelled: false };
  const cancelled = await discover(exactManager(e), { token, search: async () => { token.cancelled = true; return { ok: true, items: [e.item(1), e.item(2), e.item(3)] }; } });
  assert.equal(cancelled.price, 0); assert.equal(cancelled.requests, 1);
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
  const reference = { price: 2000, status: "available", fetchedAt: Date.now(), source: "EA third-cheapest BIN" };
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

test("non-player quote fallback, cache age, platform separation and specific-item restriction", async () => {
  let platform = "console"; let eaRequests = 0; let futbinRequests = 0;
  const e = env({
    "app/prices/futbinClient.js": { futbinYear: () => "27", fetchFutbinText: async () => { futbinRequests += 1; return { ok: false, status: 403 }; } },
    "app/prices/priceService.js": { pricePlatform: () => platform },
    "app/prices/eaQuote.js": { discoverEaQuote: async () => { eaRequests += 1; return { status: "available", price: 2000, source: "EA third-cheapest BIN", fetchedAt: Date.now() }; } },
  });
  const quotes = e.load("app/prices/nonPlayerQuotes.js");
  const f = exactManager(e, { selectedItem: e.targets.targetIdentity(e.item()) });
  const first = await quotes.requestItemQuote(f); assert.equal(first.source, "EA third-cheapest BIN");
  await quotes.requestItemQuote(f); assert.equal(eaRequests, 1); assert.equal(futbinRequests, 1);
  first.fetchedAt -= 61000;
  assert.equal(quotes.currentItemQuote(f, 60000), null); assert.ok(quotes.currentItemQuote(f));
  await quotes.requestItemQuote(f, { maxAge: 60000 }); assert.equal(eaRequests, 2);
  platform = "pc"; assert.equal(quotes.currentItemQuote(f), null);
  await quotes.requestItemQuote(f); assert.equal(eaRequests, 3);
  const broad = await quotes.requestItemQuote(exactManager(e, { definitionId: 0 }));
  assert.equal(broad.price, 0); assert.equal(eaRequests, 3);
  const restricted = exactManager(e, { selectedItem: e.targets.targetIdentity(e.item()), league: 13 });
  await quotes.requestItemQuote(restricted); assert.equal(futbinRequests, 3, "league-modified manager skips grouped FUTBIN reference");
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
