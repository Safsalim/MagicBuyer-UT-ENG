import { startKeepAlive, stopKeepAlive, unlockAudio } from "./audio";
import { bidPriceForAuction, bidProblem, bidRulesForFilter, bidsOnly, exactCardId } from "./bidding";
import { selectRatingTarget, usesRatingRotation } from "./ratingTargets";
import { createCancelToken, sleep, withTimeout } from "./async";
import { KIND, classify, isFatal, parseCodeList } from "./errors";
import {
  buildCriteria,
  buyCeilingForFilter,
  cacheBusterPrices,
  describeFilter,
  filterHasTarget,
  futbinKeyForFilter,
  getRotation,
  runnableFilters,
  ratingProblem,
  getFilters,
} from "./filters";
import { hasReferenceTarget, matchesItem, targetIdentity } from "./itemTargets";
import { currentItemQuote, requestItemQuote } from "../prices/nonPlayerQuotes";
import { resetRequestQueue, setRequestToken } from "./requestQueue";
import { previewMatchingItems, listMatchingPreview } from "./bulkSell";
import { errorMessage, log } from "./logger";
import * as market from "./market";
import { notifyEvent, sound } from "./notify";
import { getCoins, getUser, isAppReady, itemService } from "./page";
import {
  durationSeconds,
  fixedSellPriceFor,
  futbinSellPrice,
  prepareListing,
  sellModeFor,
  sellPercentFor,
} from "./listing";
import { afterTax, floorPrice, formatCoins, profitFor, toInt } from "./prices";
import { formatDuration, parseRange, pickInt, pickSeconds, randomBetween } from "./ranges";
import { currentPrice, getPriceRecord, onPriceUpdate, requestPrice, trackPrice } from "../prices/priceService";
import { getSettings } from "./settings";
import { currentTask, beginTask, endTask } from "./tasks";
import {
  STATUS,
  bumpStat,
  getState,
  recordSearch,
  recordTransaction,
  resetStats,
  updateState,
} from "./state";

const RELIST_MIN_GAP = 5 * 60 * 1000;
const CLEAR_MIN_GAP = 60 * 1000;
const REFERENCE_WAIT_MAX = 2 * 60 * 1000;
const MAX_SELL_DEFERRALS = 6;
// Maximum wait for a purchased card's FUTBIN price before sending it to the transfer list without listing.
const SELL_PRICE_WAIT = 90 * 1000;
// Maximum usable FUTBIN price age: 5 minutes for purchases (refreshed every ≤ 2 minutes), 10 minutes for sales.
const BUY_PRICE_MAX_AGE = 5 * 60 * 1000;
const SELL_PRICE_MAX_AGE = 10 * 60 * 1000;
const RELIST_RETRY = 90 * 1000;
const RELIST_BATCH = 5;
const RELIST_FALLBACK_AFTER = 3 * 60 * 1000;

let run = null;

export const isRunning = () => !!run;
export const isPaused = () => !!(run && run.paused);
export const isStopping = () => !!(run && run.stopping);
// Listings for cards purchased just before stopping (Stop interrupts them).
export const isFinalizing = () => !!(run && run.finalToken && !run.finalToken.cancelled);

// ------------------------------------------------------------ utilities

const safeCall = (target, method) => {
  try {
    return !!(target && typeof target[method] === "function" && target[method]());
  } catch (e) {
    return false;
  }
};

// Wait interrupted by Stop (run token) or Pause/Resume (one-off token).
const idle = async (ctx, ms) => {
  if (ctx.token.cancelled) {
    return false;
  }
  const interrupt = createCancelToken();
  ctx.interrupt = interrupt;
  const onStop = () => interrupt.cancel();
  ctx.token.on(onStop);
  const completed = await sleep(ms, interrupt);
  ctx.token.off(onStop);
  if (ctx.interrupt === interrupt) {
    ctx.interrupt = null;
  }
  return completed && !ctx.token.cancelled;
};

// Not before: next allowed search time. A manual pause never shortens
// a wait (search delay, automatic pause, or safety pause).
const setNotBefore = (ctx, at, kind) => {
  const now = Date.now();
  if (at >= ctx.notBefore || ctx.notBefore <= now) {
    ctx.notBefore = at;
    ctx.waitKind = kind;
    ctx.waitStartedAt = now;
  }
};

const inCooldown = (ctx) => ctx.waitKind === "cooldown" && ctx.notBefore > Date.now();
const blocked = (ctx) => ctx.token.cancelled || inCooldown(ctx);

const sessionAlive = () => !!(itemService() && getUser());

const futbinHint = (filter) => ({
  name: filter.player ? filter.player.name : "",
  rating: filter.player ? filter.player.rating : 0,
});

// Effective max buy price: fixed, or X% of FUTBIN price (capped by the fixed price when set).
// In FUTBIN mode, the filter waits without a recent price (< 5 minutes): never buy using an outdated price.
const effectiveMaxBuy = (filter) => {
  if (bidsOnly(filter)) return 0;
  if (filter.priceMode !== "futbin") {
    return buyCeilingForFilter(filter);
  }
  const key = futbinKeyForFilter(filter);
  const quote = filter.itemGroup !== "players" ? currentItemQuote(filter) : null;
  const reference = quote ? quote.price : key ? currentPrice(key, BUY_PRICE_MAX_AGE, "buy") : 0;
  if (!reference) {
    return 0;
  }
  return buyCeilingForFilter(filter, reference);
};

const referencePending = (filter) =>
  !bidsOnly(filter) && filter.priceMode === "futbin" && hasReferenceTarget(filter) && !effectiveMaxBuy(filter);

// Priority tracking (≤ 2 minutes) of FUTBIN prices used by the running bot.
const trackHot = (ctx, key, hint) => {
  if (!key || ctx.tracked.has(key)) {
    return;
  }
  ctx.tracked.set(key, trackPrice(key, hint, "hot"));
};

const releaseTracking = (ctx) => {
  ctx.tracked.forEach((untrack) => untrack());
  ctx.tracked.clear();
  if (ctx.unwatchPrices) {
    ctx.unwatchPrices();
    ctx.unwatchPrices = null;
  }
};

// Log changes to target FUTBIN prices (max buy price recalculated on each update).
const watchFutbinPrices = (ctx) => {
  const lastPrices = new Map();
  ctx.unwatchPrices = onPriceUpdate((definitionId, record) => {
    if (!record || !ctx.tracked.has(definitionId) || ctx.token.cancelled) {
      return;
    }
    const filter = runnableFilters().find(
      (entry) => entry.priceMode === "futbin" && futbinKeyForFilter(entry) === definitionId
    );
    if (!filter) {
      return;
    }
    if (record.suspect && !ctx.warned.has(`suspect:${definitionId}:${record.suspect.price}`)) {
      ctx.warned.add(`suspect:${definitionId}:${record.suspect.price}`);
      log.warn(
        `FUTBIN price ${filter.name} : abnormal jump to ${formatCoins(record.suspect.price)}, keeping the previous price pending confirmation.`
      );
      return;
    }
    const previous = lastPrices.get(definitionId);
    lastPrices.set(definitionId, record.price);
    if (previous && previous !== record.price && record.price) {
      log.info(
        `FUTBIN price ${filter.name} : ${formatCoins(previous)} → ${formatCoins(record.price)} · max buy ${formatCoins(effectiveMaxBuy(filter))}.`
      );
    }
  });
};

const matchesTarget = (item, filter) => matchesItem(item, filter, { fromSearch: true });

const purchaseLimitReached = (settings) => {
  const maxBuys = toInt(settings.buy.stopAfterPurchases);
  return !!(maxBuys && getState().stats.won >= maxBuys);
};

// --------------------------------------------------------------- startup

const preflight = () => {
  if (!isAppReady()) {
    return "The EA web app is not ready yet: wait for the home screen, then try again.";
  }
  if (!getUser()) {
    return "Log in to the EA web app before starting.";
  }
  const task = currentTask();
  if (task) {
    return `A task is in progress (${task.label}): wait for it to finish or stop it before starting the bot.`;
  }
  const settings = getSettings();
  const filters = runnableFilters().filter(filterHasTarget);
  const invalidRating = runnableFilters().map(ratingProblem).find(Boolean);
  if (invalidRating) return invalidRating;
  const invalidBid = runnableFilters().map((filter) => bidProblem(filter, settings)).find(Boolean);
  if (invalidBid) return invalidBid;
  if (!filters.length) {
    return "Choose a player (or at least one criterion: quality, rarity, rating…) in the Target tab.";
  }
  if (filters.some((filter) => ((!bidsOnly(filter) && filter.priceMode === "futbin") || (filter.itemGroup !== "players" && sellModeFor(filter, settings.sell) === "futbin")) && !hasReferenceTarget(filter))) {
    return "Automatic pricing requires a specific item. Choose a chemistry style or select a Test search result; use fixed buy and sell prices for broad filters.";
  }
  const usable = filters.filter(
    (filter) =>
      (!bidsOnly(filter) && filter.priceMode === "futbin" ? hasReferenceTarget(filter) : effectiveMaxBuy(filter)) ||
      (bidRulesForFilter(filter, settings).enabled && floorPrice(filter.maxBid))
  );
  if (!usable.length) {
    return "Enter a “Max buy price” or select “% of FUTBIN price” mode (with a player) for your target.";
  }
  if (!parseRange(settings.timing.wait, "S")) {
    return "The delay between searches is invalid (example: 5-9).";
  }
  return null;
};

export const startBot = () => {
  if (run) {
    if (run.stopping) {
      log.warn("Stopping (listing the last purchased cards): wait for completion or click Stop.");
      return false;
    }
    if (run.paused) {
      resumeBot();
    }
    return true;
  }
  unlockAudio();
  const problem = preflight();
  if (problem) {
    log.error(problem);
    updateState({ detail: problem });
    return false;
  }
  const settings = getSettings();
  const stopAfter = pickSeconds(settings.timing.stopAfter, "H");
  const ctx = {
    token: createCancelToken(),
    interrupt: null,
    paused: false,
    stopping: false,
    stopReason: "",
    stopAlert: false,
    manualStop: false,
    attempted: new Set(),
    retries: new Map(),
    bids: new Map(),
    userWatched: new Set(),
    sellQueue: [],
    errorCounts: new Map(),
    searchCount: 0,
    searchesSincePause: 0,
    pauseAfter: pickInt(settings.timing.pauseEvery),
    stopAt: stopAfter > 0 ? Date.now() + stopAfter * 1000 : 0,
    cycles: 0,
    consecutiveFailures: 0,
    unexpectedErrors: 0,
    cooldowns: 0,
    filterIndex: 0,
    filterSearches: 0,
    currentFilterId: null,
    bidSearchCounter: 0,
    page: 1,
    extraDelay: 0,
    notBefore: 0,
    waitKind: null,
    waitStartedAt: 0,
    transferDirty: true,
    fullStop: false,
    nextWatchCheck: 0,
    lastRelistAt: 0,
    lastClearAt: 0,
    referenceWaitSince: 0,
    relistPending: new Map(),
    tracked: new Map(),
    unwatchPrices: null,
    warned: new Set(),
  };
  run = ctx;
  resetRequestQueue();
  setRequestToken(ctx.token, () => ctx.paused || inCooldown(ctx));
  watchFutbinPrices(ctx);
  resetStats();
  updateState({
    status: STATUS.STARTING,
    detail: "",
    startedAt: Date.now(),
    stoppedAt: 0,
    nextSearchAt: 0,
    pauseUntil: 0,
    coins: getCoins(),
  });
  if (settings.timing.keepAlive) {
    startKeepAlive();
  }
  const filters = runnableFilters().filter(filterHasTarget);
  log.info(
    `Bot started · ${filters.length > 1 ? `${filters.length} filters in rotation` : describeFilter(filters[0])}` +
      ` · wait ${settings.timing.wait} s` +
      (ctx.pauseAfter ? ` · pause every ~${ctx.pauseAfter} searches` : "") +
      (ctx.stopAt ? ` · stop in ${formatDuration(ctx.stopAt - Date.now())}` : "")
  );
  mainLoop(ctx)
    .catch((e) => {
      log.error(`Unexpected engine error: ${errorMessage(e)}`);
      ctx.stopReason = ctx.stopReason || "internal error";
      ctx.stopAlert = true;
    })
    .finally(() => finalize(ctx));
  return true;
};

export const stopBot = (reason = "manual stop", { alert = false, manual = false } = {}) => {
  const ctx = run;
  if (!ctx) {
    return;
  }
  if (ctx.stopping) {
    // Stop during post-stop listings: interrupt them.
    if (ctx.finalToken && !ctx.finalToken.cancelled) {
      ctx.finalToken.cancel();
      log.warn("Post-stop listings interrupted.");
    }
    return;
  }
  ctx.stopping = true;
  ctx.stopReason = reason;
  ctx.stopAlert = alert;
  ctx.manualStop = manual;
  ctx.token.cancel();
  updateState({ status: STATUS.STOPPING, detail: reason, nextSearchAt: 0, pauseUntil: 0 });
};

export const pauseBot = () => {
  const ctx = run;
  if (!ctx || ctx.paused || ctx.stopping) {
    return;
  }
  ctx.paused = true;
  if (ctx.interrupt) {
    ctx.interrupt.cancel();
  }
  updateState({ status: STATUS.PAUSED, nextSearchAt: 0, pauseUntil: 0 });
  log.info("Manually paused: click Resume to continue.");
};

export const resumeBot = () => {
  const ctx = run;
  if (!ctx || !ctx.paused || ctx.stopping) {
    return;
  }
  ctx.paused = false;
  if (ctx.interrupt) {
    ctx.interrupt.cancel();
  }
  updateState({ status: STATUS.RUNNING });
  log.info(
    ctx.notBefore > Date.now()
      ? `Resuming bot (next search in ${Math.ceil((ctx.notBefore - Date.now()) / 1000)} s).`
      : "Bot resumed."
  );
};

const finalize = async (ctx) => {
  if (run !== ctx) {
    return;
  }
  stopKeepAlive();
  releaseTracking(ctx);
  // Cards purchased just before stopping are still processed (unless a blocking error occurs). The bot
  // remains in the stopping state during this time: another run cannot start in parallel.
  if (ctx.sellQueue.length && !ctx.stopAlert && sessionAlive()) {
    log.info(`Processing ${ctx.sellQueue.length} pending purchased card(s)… (Stop to interrupt)`);
    const detached = Object.assign({}, ctx, {
      token: createCancelToken(),
      notBefore: 0,
      waitKind: null,
      finalizing: true,
      halted: "",
    });
    ctx.finalToken = detached.token;
    setRequestToken(detached.token);
    updateState({ status: STATUS.STOPPING, detail: "listing purchased cards" });
    await processSellQueue(detached).catch((e) => log.error(`Post-stop selling: ${errorMessage(e)}`));
    if (detached.halted) {
      ctx.stopAlert = true;
      ctx.stopReason = `${ctx.stopReason || "stop"} then ${detached.halted}`;
    }
  }
  if (ctx.sellQueue.length) {
    log.warn(`${ctx.sellQueue.length} purchased card(s) not listed: they are in your unassigned items.`);
  }
  run = null;
  setRequestToken(null);
  const reason = ctx.stopReason || "stop";
  const stats = getState().stats;
  updateState({
    status: STATUS.STOPPED,
    detail: reason,
    stoppedAt: Date.now(),
    nextSearchAt: 0,
    pauseUntil: 0,
  });
  const summary = `${stats.searches} search(es), ${stats.won} purchase(s), ${formatCoins(stats.spent)} spent`;
  if (ctx.stopAlert) {
    log.error(`Bot stopped: ${reason} · ${summary}`);
  } else {
    log.info(`Bot stopped: ${reason} · ${summary}`);
  }
  if (ctx.manualStop && !ctx.stopAlert) {
    sound("stop");
  } else {
    notifyEvent(ctx.stopAlert ? "alert" : "stop", `⏹ MagicBuyer stopped: ${reason} (${summary})`, {
      toast: true,
      negative: ctx.stopAlert,
    });
  }
};

// Stop requested by an error: during post-stop selling, interrupt only those sales.
const haltRun = (ctx, reason, options = {}) => {
  if (ctx.finalizing) {
    if (!ctx.halted) {
      ctx.halted = reason;
      log.error(`Post-stop listings interrupted: ${reason}.`);
    }
    ctx.token.cancel();
    return;
  }
  stopBot(reason, options);
};

// ----------------------------------------------------------- main loop

const mainLoop = async (ctx) => {
  try {
    await initialSync(ctx);
  } catch (e) {
    log.warn(`Initial synchronization incomplete: ${errorMessage(e)}`);
  }
  if (ctx.token.cancelled) {
    return;
  }
  if (!ctx.paused) {
    updateState({ status: STATUS.RUNNING });
  }
  while (!ctx.token.cancelled) {
    // An unexpected error does not kill the bot: 3 consecutive errors stop it.
    try {
      const searched = await loopStep(ctx);
      if (searched) {
        ctx.unexpectedErrors = 0;
      }
    } catch (e) {
      ctx.unexpectedErrors += 1;
      log.error(`Error during cycle (${ctx.unexpectedErrors}/3) : ${errorMessage(e)}`);
      if (ctx.unexpectedErrors >= 3) {
        stopBot("repeated internal errors", { alert: true });
      } else {
        setNotBefore(ctx, Date.now() + 3000, "wait");
      }
    }
  }
};

// One loop step. Returns true if a search took place.
const loopStep = async (ctx) => {
  if (ctx.paused) {
    await idle(ctx, 1000);
    return false;
  }
  if (ctx.notBefore > Date.now()) {
    await waitForNextSlot(ctx);
    return false;
  }
  const settings = getSettings();
  const stopReason = checkStopConditions(ctx, settings);
  if (stopReason) {
    stopBot(stopReason);
    return false;
  }
  if (!sessionAlive()) {
    stopBot("EA session disconnected", { alert: true });
    return false;
  }
  if (ctx.pauseAfter > 0 && ctx.searchesSincePause >= ctx.pauseAfter) {
    await startScheduledPause(ctx, settings);
    return false;
  }
  const pick = nextFilter(ctx, settings);
  if (!pick) {
    handleNoFilter(ctx, settings);
    return false;
  }
  ctx.referenceWaitSince = 0;
  const cycleStart = Date.now();
  await snipeCycle(ctx, pick.filter, pick.maxBuy, settings);
  if (!ctx.token.cancelled) {
    await maintenance(ctx);
  }
  if (!ctx.token.cancelled) {
    setNotBefore(ctx, Date.now() + nextWait(ctx, cycleStart), "wait");
  }
  return true;
};

const waitForNextSlot = async (ctx) => {
  const kind = ctx.waitKind || "wait";
  const status =
    kind === "cooldown" ? STATUS.COOLDOWN : kind === "auto-pause" ? STATUS.AUTO_PAUSE : STATUS.RUNNING;
  const target = ctx.notBefore;
  updateState({
    status,
    nextSearchAt: target,
    waitStartedAt: ctx.waitStartedAt || Date.now(),
    pauseUntil: kind === "wait" ? 0 : target,
  });
  const planned = target - Date.now();
  const from = Date.now();
  const completed = await idle(ctx, planned);
  if (!completed) {
    return;
  }
  const overshoot = Date.now() - from - planned;
  if (kind === "wait" && overshoot > 20000 && !ctx.warned.has("throttle")) {
    ctx.warned.add("throttle");
    log.warn(
      "Chrome has throttled this tab (in the background): keep the web app visible or enable “Keep tab active” in Timing."
    );
  }
  if (kind === "cooldown") {
    log.info("Safety pause ended, resuming searches.");
  }
  ctx.waitKind = null;
  updateState({ status: STATUS.RUNNING, nextSearchAt: 0, pauseUntil: 0 });
};

const checkStopConditions = (ctx, settings) => {
  if (ctx.stopAt && Date.now() >= ctx.stopAt) {
    return "maximum runtime reached";
  }
  const maxBuys = toInt(settings.buy.stopAfterPurchases);
  if (purchaseLimitReached(settings)) {
    return `target of ${maxBuys} purchase(s) reached`;
  }
  if (ctx.fullStop && settings.transfer.stopWhenFull) {
    return "transfer list or unassigned items full";
  }
  return null;
};

const startScheduledPause = async (ctx, settings) => {
  const seconds = pickSeconds(settings.timing.pauseFor, "S");
  const done = ctx.searchesSincePause;
  ctx.searchesSincePause = 0;
  ctx.pauseAfter = pickInt(settings.timing.pauseEvery);
  if (!(seconds > 0)) {
    return;
  }
  const until = Date.now() + seconds * 1000;
  setNotBefore(ctx, until, "auto-pause");
  if (!ctx.paused) {
    updateState({ status: STATUS.AUTO_PAUSE, pauseUntil: until, nextSearchAt: until, waitStartedAt: Date.now() });
  }
  log.info(`Automatic pause of ${Math.round(seconds)} s after ${done} searches.`);
  // Use the pause to handle reselling and the transfer list.
  await maintenance(ctx, { force: true });
};

// Usable filters (target + price), rotated when enabled.
const nextFilter = (ctx, settings) => {
  const usable = [];
  runnableFilters()
    .filter(filterHasTarget)
    .forEach((filter) => {
      if (!bidsOnly(filter) && filter.priceMode === "futbin") {
        if (filter.itemGroup === "players") trackHot(ctx, futbinKeyForFilter(filter), futbinHint(filter));
        else if (!currentItemQuote(filter)) requestItemQuote(filter, { token: ctx.token }).then((quote) => {
          if (quote.error && !ctx.token.cancelled) handleFailure(ctx, quote.error, "search");
        });
      }
      const maxBuy = effectiveMaxBuy(filter);
      const bidOn = !bidProblem(filter, settings) && bidRulesForFilter(filter, settings).enabled && floorPrice(filter.maxBid) > 0;
      if (maxBuy || bidOn) {
        usable.push({ filter, maxBuy });
      }
    });
  if (!usable.length) {
    return null;
  }
  const rotation = getRotation();
  if (usable.length > 1 && rotation.enabled) {
    const every = Math.max(1, toInt(rotation.every) || 1);
    if (ctx.filterSearches >= every) {
      ctx.filterSearches = 0;
      if (rotation.random) {
        const choices = usable.map((_, index) => index).filter((i) => i !== ctx.filterIndex % usable.length);
        ctx.filterIndex = choices[Math.floor(Math.random() * choices.length)] || 0;
      } else {
        ctx.filterIndex += 1;
      }
    }
  } else {
    ctx.filterIndex = 0;
  }
  const pick = usable[ctx.filterIndex % usable.length];
  if (pick.filter.id !== ctx.currentFilterId) {
    if (ctx.currentFilterId) {
      log.info(`Next filter: ${pick.filter.name} (${describeFilter(pick.filter)})`);
    }
    ctx.currentFilterId = pick.filter.id;
    ctx.page = 1;
    updateState({ filterName: pick.filter.name });
  }
  return pick;
};

const handleNoFilter = (ctx, settings) => {
  const waiting = runnableFilters()
    .filter(filterHasTarget)
    .some((filter) => referencePending(filter));
  if (!waiting) {
    stopBot("no usable filter (missing player/criterion or max buy price)");
    return;
  }
  const now = Date.now();
  if (!ctx.referenceWaitSince) {
    ctx.referenceWaitSince = now;
    log.info("Waiting for a market reference to calculate the max buy price…");
  } else if (now - ctx.referenceWaitSince > REFERENCE_WAIT_MAX) {
    stopBot("Market reference unavailable for 2 minutes: check the target or use fixed prices", { alert: true });
    return;
  }
  setNotBefore(ctx, now + 5000, "wait");
};

const nextWait = (ctx, cycleStart) => {
  const timing = getSettings().timing;
  const base = (pickSeconds(timing.wait, "S") || 5) * 1000;
  const extra = ctx.extraDelay || 0;
  ctx.extraDelay = 0;
  let target = cycleStart + base + extra;
  const perMinute = toInt(timing.maxPerMinute);
  if (perMinute > 0) {
    target = Math.max(target, cycleStart + 60000 / perMinute);
  }
  return Math.max(100, target - Date.now());
};

// ------------------------------------------------------------------- snipe

const snipeCycle = async (ctx, filter, maxBuy, settings) => {
  if (bidProblem(filter, settings)) return;
  const rated = await selectRatingTarget(ctx, filter);
  if (rated.cancelled) return;
  const current = getFilters().find((saved) => saved.id === filter.id);
  if (current && JSON.stringify(current) !== JSON.stringify(filter)) return;
  if (rated.error) {
    log.error(`${filter.name}: ${rated.error}`);
    stopBot(`Rating card list unavailable: ${rated.error}`, { alert: true });
    return;
  }
  if (rated.card) {
    filter = rated.filter;
    ctx.page = 1;
    updateState({ filterName: `${filter.name} · ${rated.card.name} ${rated.card.rating} (${rated.index + 1}/${rated.total})` });
    log.info(`Rating rotation ${rated.index + 1}/${rated.total}: ${rated.card.name} ${rated.card.rating} · version ${rated.card.definitionId}.`);
  }
  if (bidsOnly(filter)) maxBuy = 0;
  const bidOn = bidRulesForFilter(filter, settings).enabled && floorPrice(filter.maxBid) > 0;
  // With a max buy price, EA returns only listings below that price: bids
  // therefore use a dedicated search (every N searches).
  let bidSearch = false;
  if (bidOn && !maxBuy) {
    bidSearch = true;
  } else if (bidOn) {
    ctx.bidSearchCounter += 1;
    bidSearch = ctx.bidSearchCounter % Math.max(2, toInt(settings.bid.searchEvery) || 3) === 0;
  }
  const searchMaxBuy = bidSearch ? 0 : maxBuy;
  const bust = cacheBusterPrices(settings.timing.cacheBuster, ctx.searchCount, {
    maxBuy: searchMaxBuy,
    minBuy: toInt(filter.minBuy),
    maxBid: bidSearch ? toInt(filter.maxBid) : 0,
    cap: settings.timing.cacheBusterMax,
  });
  const criteria = buildCriteria(filter, {
    minBuy: bust.minBuy,
    maxBuy: searchMaxBuy,
    maxBid: bidSearch ? toInt(filter.maxBid) : bust.maxBid,
    minBid: bust.minBid,
  });
  const page = bidSearch ? 1 : ctx.page || 1;
  const result = await market.searchMarket(criteria, page);
  ctx.searchCount += 1;
  ctx.searchesSincePause += 1;
  ctx.filterSearches += 1;
  recordSearch(result.latency);
  if (ctx.token.cancelled) {
    return;
  }
  if (!result.ok) {
    await handleFailure(ctx, result.error || classify(result.response), "search");
    return;
  }
  ctx.consecutiveFailures = 0;
  const items = result.items;
  bumpStat("results", items.length);
  if (!bidSearch) {
    const maxPages = Math.max(1, Math.min(10, toInt(settings.timing.maxPages) || 1));
    ctx.page = items.length > market.marketPageSize() && page < maxPages ? page + 1 : 1;
  }

  const analysis = analyzeResults(ctx, items, filter, maxBuy, settings, bidOn);
  logSearch(filter, items.length, analysis, result.latency, page, maxBuy, bidSearch);
  bumpStat("deals", analysis.deals.length);

  const maxResults = toInt(settings.buy.maxResults);
  if (!bidSearch && maxResults && items.length > maxResults) {
    log.warn(
      `${items.length} results (threshold ${maxResults}): skipping purchases; your max price may be above market value.`
    );
    return;
  }
  // FUTBIN mode: a full page of listings below the max price means it is above
  // market value (incorrect/outdated FUTBIN price or percentage too high): do not buy and refresh the price.
  if (!bidSearch && filter.priceMode === "futbin" && items.length >= market.marketPageSize()) {
    const warnKey = `futbin-full:${filter.id}:${maxBuy}`;
    if (!ctx.warned.has(warnKey)) {
      ctx.warned.add(warnKey);
      log.warn(
        `${filter.name} : ${items.length} listings below ${formatCoins(maxBuy)} (full page): FUTBIN price is above market value (outdated or percentage too high), no purchase. Lower the percentage or set a cap.`
      );
      if (filter.itemGroup === "players") requestPrice(futbinKeyForFilter(filter), futbinHint(filter));
      else requestItemQuote(filter, { token: ctx.token, force: true });
    }
    return;
  }

  let attempts = 0;
  const perSearch = Math.max(1, toInt(settings.buy.maxPerSearch) || 1);
  for (const deal of analysis.deals) {
    if (attempts >= perSearch || blocked(ctx) || purchaseLimitReached(settings)) {
      break;
    }
    const coins = getCoins();
    const reserve = toInt(settings.buy.coinsReserve);
    if (coins && coins - reserve < deal.bin) {
      if (!ctx.warned.has(`coins:${deal.tradeId}`)) {
        ctx.warned.add(`coins:${deal.tradeId}`);
        log.warn(
          `${market.nameOf(deal.item)} at ${formatCoins(deal.bin)} : insufficient coins (${formatCoins(coins)}${reserve ? `, reserve ${formatCoins(reserve)}` : ""}).`
        );
      }
      continue;
    }
    attempts += 1;
    const outcome = await attemptBuy(ctx, deal, filter);
    if (outcome === "fatal") {
      return;
    }
  }
  if (bidOn && analysis.auctions.length && !blocked(ctx) && !purchaseLimitReached(settings)) {
    attempts += await placeBids(ctx, analysis.auctions, filter, settings);
  }
  if (attempts) {
    ctx.extraDelay = pickSeconds(settings.timing.afterBuy, "S") * 1000;
  }
};

const analyzeResults = (ctx, items, filter, maxBuy, settings, bidOn) => {
  const deals = [];
  const auctions = [];
  const counts = { own: 0, seen: 0, other: 0, rating: 0, gk: 0, above: 0 };
  items.forEach((item) => {
    const auction = market.auctionOf(item);
    const tradeId = auction ? String(auction.tradeId || "") : "";
    if (!auction || !tradeId || tradeId === "0") {
      return;
    }
    if (auction.tradeOwner) {
      counts.own += 1;
      return;
    }
    if (!matchesTarget(item, filter)) {
      counts.other += 1;
      return;
    }
    const rating = market.ratingOf(item);
    if (filter.itemGroup === "players" && ((filter.minRating && rating < filter.minRating) || (filter.maxRating && rating > filter.maxRating))) {
      counts.rating += 1;
      return;
    }
    if (filter.itemGroup === "players" && settings.buy.skipGk && market.isGoalkeeper(item)) {
      counts.gk += 1;
      return;
    }
    const bin = toInt(auction.buyNowPrice);
    if (!bidsOnly(filter) && bin && maxBuy && bin <= maxBuy) {
      if (ctx.attempted.has(tradeId)) {
        counts.seen += 1;
        return;
      }
      deals.push({ item, tradeId, bin, rating, expires: Number(auction.expires) || 0 });
      return;
    }
    counts.above += 1;
    if (bidOn) {
      auctions.push({ item, tradeId, auction, rating, bin, endsAt: Date.now() + Number(auction.expires) * 1000 });
    }
  });
  // Cheapest first; for equal prices, the most recent listing (more likely still available).
  deals.sort((a, b) => a.bin - b.bin || b.expires - a.expires);
  return { deals, auctions, counts };
};

const logSearch = (filter, total, analysis, latency, page, maxBuy, bidSearch) => {
  const { deals, counts } = analysis;
  const extras = [];
  if (counts.own) {
    extras.push(`${counts.own} owned by you`);
  }
  if (counts.seen) {
    extras.push(`${counts.seen} already attempted`);
  }
  if (counts.other) {
    extras.push(`${counts.other} other card(s)`);
  }
  if (counts.rating) {
    extras.push(`${counts.rating} outside rating range`);
  }
  if (counts.gk) {
    extras.push(`${counts.gk} goalkeeper(s)`);
  }
  const text =
    `${filter.name}${bidSearch ? " (bids)" : ""} · ${total} result${total > 1 ? "s" : ""}` +
    (page > 1 ? ` (page ${page})` : "") +
    (deals.length ? ` · ${deals.length} deal${deals.length > 1 ? "s" : ""} ≤ ${formatCoins(maxBuy)}` : "") +
    (extras.length ? ` · ${extras.join(", ")}` : "") +
    ` · ${Math.round(latency)} ms`;
  log.search(text);
};

const attemptBuy = async (ctx, deal, filter) => {
  const name = market.nameOf(deal.item);
  bumpStat("attempts");
  const result = await market.bidOnItem(deal.item, deal.bin);
  if (result.ok) {
    ctx.attempted.add(deal.tradeId);
    bumpStat("won");
    bumpStat("spent", deal.bin);
    updateState({ coins: getCoins() });
    log.buy(`Purchased: ${name} ${deal.rating} for ${formatCoins(deal.bin)} (${Math.round(result.latency)} ms)`, {
      definitionId: deal.item.definitionId,
    });
    recordTransaction({ type: "purchase", name, rating: deal.rating, price: deal.bin, filter: filter.name });
    notifyEvent("buy", `✅ Purchase: ${name} ${deal.rating} for ${formatCoins(deal.bin)} coins`);
    queueSale(ctx, { item: deal.item, buyPrice: deal.bin, filter, name, rating: deal.rating });
    return "won";
  }
  const error = result.error || classify(result.response);
  if (error.kind === KIND.GONE) {
    ctx.attempted.add(deal.tradeId);
    bumpStat("missed");
    log.warn(`Missed: ${name} at ${formatCoins(deal.bin)}, already bought by someone else (${error.code}).`);
    recordTransaction({ type: "missed", name, rating: deal.rating, price: deal.bin, filter: filter.name });
    notifyEvent("fail", `❌ Missed: ${name} ${deal.rating} at ${formatCoins(deal.bin)}`);
    return trackStopCode(ctx, error) ? "fatal" : "missed";
  }
  // Temporary error: allow only one retry on this listing.
  const tries = (ctx.retries.get(deal.tradeId) || 0) + 1;
  ctx.retries.set(deal.tradeId, tries);
  if (tries >= 2 || isFatal(error.kind)) {
    ctx.attempted.add(deal.tradeId);
  }
  await handleFailure(ctx, error, "buy", name);
  return ctx.token.cancelled ? "fatal" : "error";
};

// ---------------------------------------------------------------- bids

const placeBids = async (ctx, auctions, filter, settings) => {
  const rules = bidRulesForFilter(filter, settings);
  const perSearch = Math.max(1, toInt(settings.bid.maxPerSearch) || 1);
  const maxActive = Math.max(1, toInt(settings.bid.maxActive) || 10);
  let placed = 0;
  const sorted = auctions
    .filter((entry) => bidPriceForAuction(entry.auction, rules) > 0)
    .sort((a, b) => (Number(a.auction.expires) || 0) - (Number(b.auction.expires) || 0));
  for (const entry of sorted) {
    if (placed >= perSearch || ctx.bids.size >= maxActive || blocked(ctx)) {
      break;
    }
    if (ctx.userWatched.has(entry.tradeId) || ctx.bids.has(entry.tradeId)) {
      continue;
    }
    const auction = entry.auction;
    const expires = (entry.endsAt - Date.now()) / 1000;
    const price = bidPriceForAuction(auction, rules, expires);
    if (!price || !matchesTarget(entry.item, filter)) {
      continue;
    }
    const coins = getCoins();
    if (coins && coins - toInt(settings.buy.coinsReserve) < price) {
      continue;
    }
    placed += 1;
    const name = market.nameOf(entry.item);
    const result = await market.bidOnItem(entry.item, price);
    if (result.ok) {
      bumpStat("bids");
      ctx.bids.set(entry.tradeId, {
        item: entry.item,
        price,
        filter: JSON.parse(JSON.stringify(filter)),
        sell: Object.assign({}, settings.sell),
        name,
        rating: entry.rating,
        endsAt: entry.endsAt,
      });
      log.info(`Bid placed: ${name} ${entry.rating} at ${formatCoins(price)} (ends in ${Math.round(expires)} s).`);
      continue;
    }
    const error = result.error || classify(result.response);
    if (error.kind === KIND.GONE) {
      log.warn(`Bid rejected on ${name} (outbid or expired).`);
      if (trackStopCode(ctx, error)) {
        break;
      }
    } else {
      await handleFailure(ctx, error, "bid", name);
    }
  }
  return placed;
};

const checkBids = async (ctx, force) => {
  if (!ctx.bids.size) {
    return;
  }
  const now = Date.now();
  const dueEnd = Array.from(ctx.bids.values()).some((bid) => bid.endsAt && bid.endsAt <= now);
  if (!force && !dueEnd && now < ctx.nextWatchCheck) {
    return;
  }
  ctx.nextWatchCheck = now + 20000;
  const settings = getSettings();
  const result = await market.fetchWatchList();
  if (!result.ok) {
    await handleFailure(ctx, result.error, "watch");
    return;
  }
  const tracked = [];
  const seen = new Set();
  result.items.forEach((item) => {
    const auction = market.auctionOf(item);
    const tradeId = auction ? String(auction.tradeId) : "";
    if (tradeId && ctx.bids.has(tradeId) && !seen.has(tradeId)) {
      seen.add(tradeId);
      tracked.push(item);
    }
  });
  const active = tracked.filter((item) => safeCall(market.auctionOf(item), "isActiveTrade"));
  if (active.length) {
    const refreshed = await market.refreshAuctions(active);
    if (!refreshed.ok) {
      await handleFailure(ctx, refreshed.error, "watch");
      if (blocked(ctx)) {
        return;
      }
    }
  }
  const release = [];
  for (const item of tracked) {
    if (blocked(ctx)) {
      break;
    }
    const auction = market.auctionOf(item);
    const tradeId = String(auction.tradeId);
    const bid = ctx.bids.get(tradeId);
    if (!bid) {
      continue;
    }
    if (safeCall(auction, "isWon")) {
      ctx.bids.delete(tradeId);
      const price = toInt(auction.currentBid) || bid.price;
      bumpStat("bidsWon");
      bumpStat("won");
      bumpStat("spent", price);
      log.buy(`Bid won: ${bid.name} ${bid.rating} for ${formatCoins(price)}.`);
      recordTransaction({ type: "bid won", name: bid.name, rating: bid.rating, price, filter: bid.filter.name });
      notifyEvent("buy", `🏆 Bid won: ${bid.name} for ${formatCoins(price)} coins`);
      queueSale(ctx, { item, buyPrice: price, filter: bid.filter, sell: bid.sell, name: bid.name, rating: bid.rating });
    } else if (
      safeCall(auction, "isExpired") ||
      (safeCall(auction, "isClosedTrade") && !safeCall(auction, "isWon"))
    ) {
      ctx.bids.delete(tradeId);
      release.push(item);
      log.info(`Bid lost: ${bid.name}.`);
    } else if (safeCall(auction, "isOutbid")) {
      const rules = bidRulesForFilter(bid.filter, settings);
      const next = bidPriceForAuction(auction, rules);
      const maxBid = floorPrice(bid.filter.maxBid);
      const coins = getCoins();
      const affordable = !coins || coins - toInt(settings.buy.coinsReserve) >= next;
      if (settings.bid.rebid && next && affordable) {
        const rebid = await market.bidOnItem(item, next);
        if (rebid.ok) {
          bid.price = next;
          bumpStat("bids");
          log.info(`Higher bid: ${bid.name} at ${formatCoins(next)}.`);
        } else if (rebid.error && rebid.error.kind !== KIND.GONE) {
          await handleFailure(ctx, rebid.error, "bid", bid.name);
        }
      } else {
        ctx.bids.delete(tradeId);
        release.push(item);
        log.info(`Outbid on ${bid.name}: no eligible bid within your amount (${formatCoins(maxBid)}) and ending window.`);
      }
    }
  }
  Array.from(ctx.bids.keys()).forEach((tradeId) => {
    const bid = ctx.bids.get(tradeId);
    if (!seen.has(tradeId) && bid && bid.endsAt < now - 60000) {
      ctx.bids.delete(tradeId);
    }
  });
  if (release.length && settings.bid.clearLost && !blocked(ctx)) {
    const cleared = await market.untargetItems(release);
    if (!cleared.ok) {
      await handleFailure(ctx, cleared.error, "watch");
    }
  }
};

// ----------------------------------------------------------------- reselling

const sellKey = (job) => Number(job.item && job.item.definitionId) || 0;

// Request the purchased version's FUTBIN price (unless it is less than a minute old).
const requestSellPrice = (job, token) => {
  if (job.filter.itemGroup !== "players") {
    return requestItemQuote(job.filter, { token, maxAge: 60000 });
  }
  const key = sellKey(job);
  if (!key || currentPrice(key, 60 * 1000, "sell")) {
    return Promise.resolve(null);
  }
  job.requestedAt = Date.now();
  return requestPrice(key, { name: job.name, rating: job.rating });
};

const queueSale = (ctx, job) => {
  const entry = Object.assign({ deferrals: 0, requestedAt: 0, queuedAt: Date.now() }, job, {
    filter: JSON.parse(JSON.stringify(job.filter)), sell: Object.assign({}, job.sell || getSettings().sell),
  });
  if (entry.filter.itemGroup !== "players") {
    entry.filter.selectedItem = targetIdentity(entry.item);
    entry.filter.definitionId = Number(entry.item.definitionId);
  }
  ctx.sellQueue.push(entry);
  // Request the FUTBIN price immediately in the background while the cycle finishes.
  const sell = entry.sell;
  if (sell.mode === "list" && sellModeFor(entry.filter, sell) === "futbin") {
    requestSellPrice(entry, ctx.token);
  }
};

const moveToTransferList = async (ctx, job) => {
  if (market.isPileFull("TRANSFER")) {
    log.warn(`${job.name} left in unassigned items: transfer list full.`);
    ctx.fullStop = true;
    return;
  }
  const result = await market.moveItem(job.item, "TRANSFER");
  if (result.ok) {
    ctx.transferDirty = true;
    log.info(`${job.name} sent to the transfer list.`);
    return;
  }
  log.warn(`${job.name} could not be moved: ${result.error.label}.`);
  if (result.error.kind === KIND.FULL) {
    ctx.fullStop = true;
  } else {
    await handleFailure(ctx, result.error, "move", job.name);
  }
};

// Sell price: fixed (filter or Sell tab) or a percentage of the purchased version's FUTBIN price.
// Returns null until the FUTBIN price arrives (defer the sale to the next cycle).
const sellPriceFor = async (ctx, job, sell) => {
  if (sellModeFor(job.filter, sell) !== "futbin") {
    const price = fixedSellPriceFor(job.filter, sell);
    return { price, reason: price ? "" : "no sell price (filter or Sell tab)" };
  }
  if (job.filter.itemGroup !== "players") {
    const quote = await requestItemQuote(job.filter, { token: ctx.token, maxAge: 60000 });
    if (quote.error) await handleFailure(ctx, quote.error, "transfer", job.name);
    if (!quote.price || ctx.token.cancelled) return { price: 0, reason: "market reference unavailable" };
    const { price } = futbinSellPrice(quote.price, sellPercentFor(job.filter, sell));
    log.info(`${job.name}: ${quote.source} ${formatCoins(quote.price)} → sell ${formatCoins(price)}.`);
    return { price, reason: "" };
  }
  const key = sellKey(job);
  let reference = key ? currentPrice(key, SELL_PRICE_MAX_AGE, "sell") : 0;
  if (!reference && key && ctx.finalizing) {
    // After stopping there is no next cycle: wait for the FUTBIN response (20 seconds max).
    await withTimeout(requestSellPrice(job), 20000);
    reference = currentPrice(key, SELL_PRICE_MAX_AGE, "sell");
  }
  if (reference) {
    const { price, percent } = futbinSellPrice(reference, sellPercentFor(job.filter, sell));
    log.info(
      `FUTBIN price ${job.name} : ${formatCoins(reference)} → sell at ${Math.round(percent)} % = ${formatCoins(price)}.`
    );
    return { price, reason: "" };
  }
  const waiting = job.deferrals < MAX_SELL_DEFERRALS || Date.now() - (job.queuedAt || 0) < SELL_PRICE_WAIT;
  if (key && !ctx.finalizing && waiting) {
    if (!job.requestedAt || Date.now() - job.requestedAt > 30000) {
      requestSellPrice(job);
    }
    return null;
  }
  return { price: 0, reason: "FUTBIN price unavailable" };
};

// Returns deferred if the sale should be retried on the next cycle.
const sellJob = async (ctx, job) => {
  const sell = job.sell || getSettings().sell;
  if (sell.mode === "none") {
    return "done";
  }
  if (job.filter.itemGroup === "players" && sell.maxRating && job.rating > toInt(sell.maxRating)) {
    log.info(`${job.name} (${job.rating}) kept: rating above the sell threshold.`);
    return "done";
  }
  if (sell.mode === "transfer") {
    await moveToTransferList(ctx, job);
    return "done";
  }
  const plan = await sellPriceFor(ctx, job, sell);
  if (plan === null) {
    return "deferred";
  }
  if (!plan.price) {
    log.warn(`${job.name} : ${plan.reason}, sent to the transfer list without listing.`);
    await moveToTransferList(ctx, job);
    return "done";
  }
  if (market.isPileFull("TRANSFER")) {
    log.warn(`${job.name} left in unassigned items: transfer list full.`);
    ctx.fullStop = true;
    return "done";
  }
  const listing = await prepareListing(job.item, plan.price);
  if (!listing.valid) {
    log.warn(`${job.name}: EA price limits prevent listing, sent to the transfer list.`);
    await moveToTransferList(ctx, job);
    return "done";
  }
  const price = listing.buyNow;
  const profit = profitFor(job.buyPrice, price);
  const minProfit = toInt(sell.minProfit);
  if (minProfit && profit < minProfit) {
    log.warn(
      `${job.name} : profit ${formatCoins(profit)} < minimum ${formatCoins(minProfit)}, not listed (sent to the transfer list).`
    );
    await moveToTransferList(ctx, job);
    return "done";
  }
  const start = listing.start;
  const duration = durationSeconds(sell.duration);
  const result = await market.listOnMarket(job.item, start, price, duration);
  if (result.ok) {
    ctx.transferDirty = true;
    bumpStat("listed");
    bumpStat("estProfit", profit);
    log.success(
      `Listed: ${job.name} at ${formatCoins(price)} (starting bid ${formatCoins(start)}) · estimated profit ${formatCoins(profit)}.`
    );
    recordTransaction({ type: "listing", name: job.name, rating: job.rating, price, profit, filter: job.filter.name });
    notifyEvent("list", `📤 ${job.name} listed at ${formatCoins(price)} (profit ${formatCoins(profit)})`);
    return "done";
  }
  const error = result.error || classify(result.response);
  log.error(`Listing ${job.name} failed: ${error.label}.`);
  if (error.kind === KIND.FULL) {
    ctx.fullStop = true;
  } else {
    await handleFailure(ctx, error, "list", job.name, { quiet: true });
  }
  return "done";
};

const processSellQueue = async (ctx) => {
  const jobs = ctx.sellQueue.splice(0);
  const later = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (ctx.token.cancelled || inCooldown(ctx)) {
      later.push(job);
      continue;
    }
    let outcome = "done";
    try {
      outcome = await sellJob(ctx, job);
      if (outcome === "deferred") {
        job.deferrals += 1;
        later.push(job);
      }
    } catch (e) {
      log.error(`Reselling ${job.name} : ${errorMessage(e)}`);
    }
    // Pause only between two EA actions (a deferred sale sent no request).
    if (outcome !== "deferred" && index < jobs.length - 1 && !ctx.token.cancelled) {
      await sleep(randomBetween(700, 1500), ctx.token);
    }
  }
  ctx.sellQueue.push(...later);
};

// ------------------------------------------------------- transfer list

const checkTransferList = async (ctx) => {
  const result = await market.fetchTransferList();
  if (!result.ok) {
    await handleFailure(ctx, result.error, "transfer", null, { quiet: true });
    return;
  }
  ctx.transferDirty = false;
  const summary = market.summarizeTransferList(result.items);
  const capacity = market.pileCapacity("TRANSFER");
  updateState({ transfer: Object.assign({ capacity }, summary), coins: getCoins() });
  const settings = getSettings().transfer;
  const now = Date.now();
  if (settings.relistExpired && summary.unsold > 0 && now - ctx.lastRelistAt > RELIST_MIN_GAP && !blocked(ctx)) {
    ctx.lastRelistAt = now;
    if (settings.relistMode === "futbin") {
      await relistAtFutbin(ctx, result.items);
    } else {
      await relistSamePrice(ctx, summary.unsold);
    }
  }
  const clearAt = toInt(settings.clearSoldAt);
  if (clearAt > 0 && summary.sold >= clearAt && now - ctx.lastClearAt > CLEAR_MIN_GAP && !blocked(ctx)) {
    ctx.lastClearAt = now;
    const cleared = await market.clearSold();
    if (cleared.ok) {
      const earned = afterTax(summary.soldValue);
      bumpStat("soldCount", summary.sold);
      bumpStat("soldValue", earned);
      ctx.transferDirty = true;
      log.success(`${summary.sold} sale(s) collected: +${formatCoins(earned)} coins.`);
      await market.refreshCoins();
      updateState({ coins: getCoins() });
    } else {
      await handleFailure(ctx, cleared.error, "transfer", null, { quiet: true });
    }
  }
  if (capacity && summary.total >= capacity && !ctx.warned.has("transfer-full")) {
    ctx.warned.add("transfer-full");
    log.warn(`Transfer list full (${summary.total}/${capacity}).`);
  }
};

const relistSamePrice = async (ctx, count) => {
  const relist = await market.relistExpired();
  if (relist.ok) {
    ctx.transferDirty = true;
    ctx.relistPending.clear();
    log.success(`${count} unsold card(s) relisted at the same price.`);
  } else {
    log.warn(`Cannot relist: ${relist.error.label}.`);
    await handleFailure(ctx, relist.error, "transfer", null, { quiet: true });
  }
};

// Reference relisting only touches configured matching targets. Missing prices stay unchanged.
const relistAtFutbin = async (ctx, items) => {
  const seen = new Set();
  let remaining = RELIST_BATCH;
  for (const filter of getFilters().filter((f) => f.enabled && filterHasTarget(f))) {
    if (!remaining || blocked(ctx)) break;
    const preview = await previewMatchingItems({ filter, token: ctx.token, items: items.filter((item) => !seen.has(String(item.id))), expiredOnly: true, limit: remaining,
      sell: Object.assign({}, getSettings().sell, { priceMode: "futbin" }) });
    if (!preview.ok) { await handleFailure(ctx, preview.error, "transfer"); break; }
    preview.rows.forEach((row) => seen.add(row.itemId));
    remaining -= preview.rows.length;
    if (blocked(ctx)) break;
    const report = await listMatchingPreview({ preview, token: ctx.token });
    if (report.listed) { ctx.transferDirty = true; log.success(`${report.listed} matching item(s) relisted.`); }
    if (report.stopped) break;
  }
};

const maintenance = async (ctx, { force = false } = {}) => {
  ctx.cycles += 1;
  if (ctx.sellQueue.length) {
    await processSellQueue(ctx);
  }
  if (blocked(ctx)) {
    return;
  }
  await checkBids(ctx, force);
  if (blocked(ctx)) {
    return;
  }
  const every = Math.max(1, toInt(getSettings().transfer.checkEvery) || 8);
  if (force || ctx.transferDirty || ctx.cycles % every === 0) {
    await checkTransferList(ctx);
  }
  updateState({ coins: getCoins() });
};

const initialSync = async (ctx) => {
  const settings = getSettings();
  if (settings.bid.enabled || runnableFilters().some(bidsOnly)) {
    const watched = await market.fetchWatchList();
    if (watched.ok) {
      watched.items.forEach((item) => {
        const auction = market.auctionOf(item);
        if (auction && auction.tradeId) {
          ctx.userWatched.add(String(auction.tradeId));
        }
      });
      if (ctx.userWatched.size) {
        log.info(`${ctx.userWatched.size} card(s) already on your watch list: the bot will leave them alone.`);
      }
    } else {
      await handleFailure(ctx, watched.error, "watch", null, { quiet: true });
    }
  }
  if (ctx.token.cancelled) {
    return;
  }
  await checkTransferList(ctx);
  const futbinFilters = runnableFilters()
    .filter(filterHasTarget)
    .filter((filter) => !bidsOnly(filter) && filter.priceMode === "futbin" && futbinKeyForFilter(filter));
  if (!futbinFilters.length || ctx.token.cancelled) {
    return;
  }
  await withTimeout(
    Promise.all(
      futbinFilters.map((filter) => {
        const key = futbinKeyForFilter(filter);
        trackHot(ctx, key, futbinHint(filter));
        const ready = currentPrice(key, BUY_PRICE_MAX_AGE)
          ? Promise.resolve()
          : requestPrice(key, futbinHint(filter));
        return ready.then(() => {
          const price = currentPrice(key, BUY_PRICE_MAX_AGE, "buy");
          if (price) {
            const record = getPriceRecord(key);
            const age = record && record.updatedAgoSec != null ? Math.round(record.updatedAgoSec / 60) : null;
            log.info(
              `FUTBIN price ${filter.name} : ${formatCoins(price)} → max buy ${formatCoins(effectiveMaxBuy(filter))} (${filter.futbinPercent} %${filter.maxBuy ? `, cap ${formatCoins(filter.maxBuy)}` : ""})` +
                (age != null ? ` · FUTBIN price updated ${age} min ago.` : ".")
            );
          } else {
            const record = getPriceRecord(key);
            log.warn(
              `FUTBIN price for ${filter.name} unavailable${record && record.status === "miss" ? " (card not found on FUTBIN)" : ""} : the filter will wait.`
            );
          }
        });
      })
    ),
    25000
  );
};

// ------------------------------------------------------------------ errors

// Custom stop codes (Timing tab). Returns true if the bot was stopped.
const trackStopCode = (ctx, error) => {
  const custom = parseCodeList(getSettings().errors.stopCodes);
  if (!error || !error.code || !custom.has(error.code)) {
    return false;
  }
  const count = (ctx.errorCounts.get(error.code) || 0) + 1;
  ctx.errorCounts.set(error.code, count);
  const limit = Math.max(1, toInt(getSettings().errors.maxConsecutiveFailures) || 3);
  if (count >= limit) {
    haltRun(ctx, `error code ${error.code} received ${count} times`, { alert: true });
    return true;
  }
  return false;
};

const LABELS = {
  buy: "purchase",
  bid: "bid",
  list: "listing",
  move: "move",
  watch: "watch list",
  transfer: "transfer list",
};

const handleFailure = async (ctx, error, where, subject, { quiet = false } = {}) => {
  if (!error || ctx.token.cancelled) {
    return;
  }
  bumpStat("errors");
  if (trackStopCode(ctx, error)) {
    return;
  }
  const prefix = subject ? `${subject} : ` : "";
  switch (error.kind) {
    case KIND.CAPTCHA:
      haltRun(ctx, "EA captcha: open the web app, solve the captcha, then restart", { alert: true });
      return;
    case KIND.AUTH:
      haltRun(ctx, "EA session expired: log back in to the web app", { alert: true });
      return;
    case KIND.BANNED:
      haltRun(ctx, "account blocked by EA", { alert: true });
      return;
    case KIND.LOCKED:
      haltRun(ctx, "transfer market locked by EA (soft ban)", { alert: true });
      return;
    case KIND.RATE:
    case KIND.BLOCKED:
      if (ctx.finalizing) {
        haltRun(ctx, `${error.label} (${error.code})`, { alert: true });
      } else {
        startCooldown(ctx, error);
      }
      return;
    case KIND.FULL:
      ctx.fullStop = true;
      log.warn(`${prefix}${error.label}.`);
      return;
    case KIND.FUNDS:
      log.warn(`${prefix}insufficient coins.`);
      return;
    default:
      break;
  }
  if (where === "search") {
    ctx.consecutiveFailures += 1;
    const limit = Math.max(1, toInt(getSettings().errors.maxConsecutiveFailures) || 3);
    if (ctx.consecutiveFailures >= limit) {
      stopBot(`${ctx.consecutiveFailures} consecutive failed searches (${error.label})`, { alert: true });
    } else {
      log.warn(`Search failed: ${error.label} (${ctx.consecutiveFailures}/${limit}).`);
    }
    return;
  }
  if (!quiet) {
    log.error(`${prefix}${LABELS[where] || where} failed (${error.label}).`);
  }
};

// Safety pause for 429 / 512 / 521: no requests until it ends (even after Pause/Resume).
const startCooldown = (ctx, error) => {
  if (inCooldown(ctx)) {
    return;
  }
  ctx.cooldowns += 1;
  const settings = getSettings().errors;
  const maxCooldowns = Math.max(0, toInt(settings.maxCooldowns));
  if (ctx.cooldowns > maxCooldowns) {
    stopBot(`EA is rate-limiting requests (${error.code}) repeatedly`, { alert: true });
    return;
  }
  const seconds = pickSeconds(settings.cooldown, "M") || 300;
  const until = Date.now() + seconds * 1000;
  setNotBefore(ctx, until, "cooldown");
  log.warn(
    `${error.label} (${error.code}): safety pause of ${seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`} (${ctx.cooldowns}/${maxCooldowns}).`
  );
  notifyEvent("fail", `⚠️ ${error.label} (${error.code}): safety pause`);
  if (!ctx.paused) {
    updateState({ status: STATUS.COOLDOWN, pauseUntil: until, nextSearchAt: until, waitStartedAt: Date.now() });
  }
};

// --------------------------------------------------------- test search

// A single search without purchasing to check a filter and see market prices.
const previewRatingCursors = new Map();
const runPreviewSearch = async (filter, token) => {
  if (ratingProblem(filter)) return { ok: false, message: ratingProblem(filter) };
  const settings = getSettings();
  const problem = bidProblem(filter, settings, { preview: true });
  if (problem) return { ok: false, message: problem };
  const only = bidsOnly(filter);
  if (run) {
    return { ok: false, message: "Stop the bot before running a test search." };
  }
  if (!isAppReady() || !getUser()) {
    return { ok: false, message: "Log in to the EA web app first." };
  }
  if (!filterHasTarget(filter)) return { ok: false, message: "Choose a subtype or a restrictive criterion first." };
  if (usesRatingRotation(filter) && filter.priceMode === "futbin") return { ok: false, message: "Use a fixed buy price for a rating card list, or select one exact card for automatic pricing." };
  const rated = await selectRatingTarget({ token, ratingCursors: previewRatingCursors }, filter);
  if (rated.cancelled) return { ok: false, message: "Test search cancelled." };
  if (rated.error) return { ok: false, message: rated.error };
  filter = rated.filter;
  if (!only && filter.priceMode === "futbin" && !hasReferenceTarget(filter)) return { ok: false, message: "Choose a chemistry style, select a specific Test search result, or use fixed prices." };
  if (!only && filter.itemGroup !== "players" && filter.priceMode === "futbin") {
    const quote = await requestItemQuote(filter, { token });
    if (!quote.price) return { ok: false, message: `Reference unavailable: ${quote.reason || "no usable price"}. Use fixed prices to browse.` };
  }
  const key = !only && filter.priceMode === "futbin" ? futbinKeyForFilter(filter) : 0;
  if (key && !effectiveMaxBuy(filter)) {
    await withTimeout(requestPrice(key, futbinHint(filter)), 20000);
    if (!effectiveMaxBuy(filter)) {
      return { ok: false, message: "FUTBIN price unavailable: check access in the FUTBIN tab (Test button)." };
    }
  }
  const maxBuy = effectiveMaxBuy(filter);
  const rules = bidRulesForFilter(filter, settings);
  const criteria = buildCriteria(filter, { maxBuy, maxBid: only ? rules.maxBid : 0 });
  const result = await market.searchMarket(criteria, 1, token);
  if (!result.ok) {
    return { ok: false, message: `Search rejected: ${result.error.label} (${result.error.code})` };
  }
  const rows = result.items
    .map((item) => {
      const auction = market.auctionOf(item) || {};
      return {
        name: market.nameOf(item),
        rating: market.ratingOf(item),
        definitionId: Number(item.definitionId) || 0,
        target: targetIdentity(item),
        bin: toInt(auction.buyNowPrice),
        bid: toInt(auction.currentBid) || toInt(auction.startingBid),
        expires: Number(auction.expires) || 0,
        own: !!auction.tradeOwner,
        match: matchesTarget(item, filter),
        bidAmount: only && exactCardId(filter) && matchesTarget(item, filter) ? bidPriceForAuction(auction, rules) : 0,
      };
    })
    .sort((a, b) => only ? a.expires - b.expires : a.bin - b.bin);
  return { ok: true, rows, latency: result.latency, maxBuy, ratingTarget: rated.card,
    ratingTargetIndex: rated.index, ratingTargetCount: rated.total, bidOnly: only, bidAmount: rules.maxBid,
    bidWindowSeconds: rules.windowSeconds, needsExactCard: only && !exactCardId(filter),
    futbinPrice: key ? currentPrice(key, BUY_PRICE_MAX_AGE) : 0 };
};

export const previewSearch = async (filter) => {
  if (run) return { ok: false, message: "Stop the bot before running a test search." };
  const task = beginTask("Test search");
  if (!task) return { ok: false, message: "Another task is in progress. Wait for it or stop it first." };
  setRequestToken(task.token);
  try { return await runPreviewSearch(filter, task.token); }
  finally { endTask(task); setRequestToken(null); }
};
