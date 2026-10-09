import { fixedTransferPrices, listAvailableAtFixedPrice, previewMatchingItems, listMatchingPreview } from "../../core/bulkSell";
import { getActiveFilter } from "../../core/filters";
import { setRequestToken } from "../../core/requestQueue";
import { isRunning } from "../../core/engine";
import * as market from "../../core/market";
import { log } from "../../core/logger";
import { notifyEvent, requestDesktopPermission, sound } from "../../core/notify";
import { formatCoins } from "../../core/prices";
import { TIMING_PRESETS, applyTimingPreset, getSettings, setSetting } from "../../core/settings";
import { getState, updateState } from "../../core/state";
import { beginTask, cancelTask, currentTask, endTask } from "../../core/tasks";
import { escapeHtml, qs, setHtml } from "../dom";
import {
  grid,
  numberField,
  priceField,
  rangeField,
  section,
  selectField,
  textField,
  toggleField,
} from "../fields";

// ------------------------------------------------------------------- Buy

export const buyPageHtml = () => `
  ${section(
    "Buy Now",
    grid(
      numberField({ bind: "s:buy.maxPerSearch", label: "Max purchases per search", min: 1, max: 5, hint: "1 recommended: the cheapest card is bought first." }),
      numberField({ bind: "s:buy.stopAfterPurchases", label: "Stop after", placeholder: "unlimited", hint: "purchases (0 = unlimited)" }),
      priceField({ bind: "s:buy.coinsReserve", label: "Coin reserve", hint: "The bot never goes below this balance." }),
      numberField({ bind: "s:buy.maxResults", label: "Result threshold", placeholder: "disabled", hint: "Do not buy if the search returns more than N cards (max price too high)." }),
      toggleField({ bind: "s:buy.skipGk", label: "Skip goalkeepers", wide: true })
    )
  )}
  <div class="mb-note">To buy at a percentage of the FUTBIN price (tracked live while the bot runs), choose “% of FUTBIN price” in the Target tab's Price section for each filter.</div>
  ${section(
    "Bids",
    grid(
      toggleField({ bind: "s:bid.enabled", label: "Also place bids", wide: true, hint: "Standard targets: bid up to the Target tab's amount. Bids-only targets are enabled separately and use their own ending window." }),
      rangeField({ bind: "s:bid.expiresWithin", label: "If ending within", unit: "M", placeholder: "5M", hint: "S, M, or H (e.g. 90S, 5M)" }),
      numberField({ bind: "s:bid.maxPerSearch", label: "Bids per search", min: 1, max: 5 }),
      numberField({ bind: "s:bid.searchEvery", label: "Search for bids every", min: 2, max: 20, hint: "searches, when the filter also has a max buy price" }),
      numberField({ bind: "s:bid.maxActive", label: "Max active bids", min: 1, max: 50 }),
      toggleField({ bind: "s:bid.exact", label: "Bid the maximum directly", hint: "Standard targets only. Bids-only targets always bid their exact amount." }),
      toggleField({ bind: "s:bid.rebid", label: "Rebid when outbid" }),
      toggleField({ bind: "s:bid.clearLost", label: "Remove lost bids from watch list", wide: true })
    )
  )}
`;

// ------------------------------------------------------------------- Sell

export const sellPageHtml = () => `
  ${section(
    "After a purchase",
    grid(
      selectField({
        bind: "s:sell.mode",
        label: "What should happen to the card?",
        wide: true,
        options: [
          ["list", "List it automatically"],
          ["transfer", "Send it to the transfer list"],
          ["none", "Leave it in unassigned items"],
        ],
      }),
      selectField({
        bind: "s:sell.duration",
        label: "Listing duration",
        options: [["1H", "1 hour"], ["3H", "3 hours"], ["6H", "6 hours"], ["12H", "12 hours"], ["1D", "1 day"], ["3D", "3 days"]],
      }),
      priceField({ bind: "s:sell.minProfit", label: "Minimum profit", hint: "After EA's 5% tax. Otherwise the card is not listed." }),
      numberField({ bind: "s:sell.maxRating", label: "Do not sell above this rating", placeholder: "disabled" })
    )
  )}
  ${section(
    "Sell price",
    grid(
      selectField({
        bind: "s:sell.priceMode",
        label: "Sell price",
        wide: true,
        options: [
          ["fixed", "Fixed price"],
          ["futbin", "% of purchased item's reference price"],
        ],
        hint: "Each filter can have its own setting (Target tab).",
      }),
      priceField({ bind: "s:sell.defaultPrice", label: "Default sell price", wide: true, showIf: "s:sell.priceMode=fixed" }),
      rangeField({
        bind: "s:sell.futbinPercent",
        label: "Sell reference % (players)",
        unit: null,
        placeholder: "99-100",
        wide: true,
        showIf: "s:sell.priceMode=futbin",
        hint: "Choose a random value within the range. Refresh the purchased version's FUTBIN price immediately after buying; without a FUTBIN price, send the card to the transfer list without listing it.",
      })
    )
  )}
  <div class="mb-note">Listing uses the EA service (the card is first moved to the transfer list). EA price limits are applied automatically.</div>
`;

// ------------------------------------------------------------------ Timing

const presetButtons = () =>
  Object.keys(TIMING_PRESETS)
    .map((key) => {
      const preset = TIMING_PRESETS[key];
      const active = getSettings().timing.preset === key;
      return `<button type="button" class="mb-preset${active ? " is-active" : ""}" data-preset="${key}">
        <b>${preset.label}</b><small>${preset.hint}</small>
      </button>`;
    })
    .join("");

export const timingPageHtml = () => `
  ${section("Profile", `<div class="mb-presets" data-presets>${presetButtons()}</div>`)}
  ${section(
    "Search pace",
    grid(
      rangeField({ bind: "s:timing.wait", label: "Delay between searches", unit: "S", placeholder: "5-9", key: true, wide: true, hint: "In seconds (decimals allowed, e.g. 4.5-7). Measured from one search to the next." }),
      numberField({ bind: "s:timing.maxPerMinute", label: "Max searches / minute", placeholder: "unlimited", hint: "Guard against rate limits." }),
      rangeField({ bind: "s:timing.afterBuy", label: "Delay after a purchase", unit: "S", optional: true, placeholder: "2-4S" })
    )
  )}
  ${section(
    "Pauses & stopping",
    grid(
      rangeField({ bind: "s:timing.pauseEvery", label: "Pause every", unit: null, optional: true, placeholder: "15-25", hint: "searches (empty = never)" }),
      rangeField({ bind: "s:timing.pauseFor", label: "Pause duration", unit: "S", optional: true, placeholder: "40-80S" }),
      rangeField({ bind: "s:timing.stopAfter", label: "Automatically stop after", unit: "H", optional: true, placeholder: "2-3H", hint: "empty = never", wide: true })
    )
  )}
  ${section(
    "Fresh results",
    grid(
      selectField({
        bind: "s:timing.cacheBuster",
        label: "EA cache busting",
        wide: true,
        options: [
          ["auto", "Automatic (recommended, no listings missed)"],
          ["minBuy", "Vary minimum buy price"],
          ["minBid", "Vary minimum bid"],
          ["off", "Disabled"],
        ],
        hint: "Each search is different so EA returns fresh results rather than a cached page.",
      }),
      numberField({ bind: "s:timing.maxPages", label: "Pages to search", min: 1, max: 5, hint: "1 is enough with a tight max price." }),
      priceField({ bind: "s:timing.cacheBusterMax", label: "Cache-busting cap", hint: "Minimum buy/bid modes." }),
      toggleField({ bind: "s:timing.keepAlive", label: "Keep tab active in the background", wide: true, hint: "Inaudible audio signal to prevent Chrome from throttling the bot (speaker icon on the tab)." })
    )
  )}
  ${section(
    "EA errors",
    grid(
      rangeField({ bind: "s:errors.cooldown", label: "Pause on EA rate limits (429/512/521)", unit: "M", placeholder: "4-8M", wide: true }),
      numberField({ bind: "s:errors.maxCooldowns", label: "Stop after N rate limits", min: 0, max: 20 }),
      numberField({ bind: "s:errors.maxConsecutiveFailures", label: "Stop after N failures", min: 1, max: 20 }),
      textField({ bind: "s:errors.stopCodes", label: "Custom stop codes", placeholder: "e.g. 470, 473", wide: true })
    ) +
      `<div class="mb-note is-warn" style="margin-top:8px">Captcha (458), expired session (401), and locked market (494) always stop the bot immediately.</div>`
  )}
`;

// ------------------------------------------------------ Transfer list

const transferStatsHtml = () => {
  const transfer = getState().transfer;
  if (!transfer) {
    return `<p class="mb-empty">Not loaded yet: click “Refresh”.</p>`;
  }
  const cell = (label, value) => `<div>${label}<b>${value}</b></div>`;
  return `<div class="mb-stats-list">
    ${cell("Selling", transfer.active)}
    ${cell("Sold", transfer.sold)}
    ${cell("Unsold", transfer.unsold)}
    ${cell("Available", transfer.available)}
    ${cell("Capacity used", `${transfer.total}${transfer.capacity ? ` / ${transfer.capacity}` : ""}`)}
    ${cell("Sold value", formatCoins(transfer.soldValue))}
  </div>`;
};

export const transferPageHtml = () => `
  ${section("Transfer list", `<div data-transfer-stats>${transferStatsHtml()}</div>
    <div class="mb-row" style="margin-top:8px">
      <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-transfer-action="refresh">Refresh</button>
      <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-transfer-action="relist">Relist unsold cards (same price)</button>
      <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-transfer-action="clear">Clear sold cards</button>
    </div>`)}
  ${section(
    "List all available cards",
    grid(priceField({ bind: "s:transfer.listPrice", label: "Buy Now price for all available cards", placeholder: "e.g. 1300", wide: true,
      hint: "Starting bid is always 100 coins lower. Uses the Sell tab's listing duration." })) +
    `<p class="mb-hint">Lists every tradeable Available item, regardless of the Target filter. Active, sold and unsold auctions are skipped. Cards outside EA price limits are skipped.</p>
     <div class="mb-row mb-fixed-list-actions">
       <button type="button" class="mb-btn mb-btn-primary" data-transfer-action="fixed-list">List all available cards</button>
       <button type="button" class="mb-btn mb-btn-danger" data-transfer-action="fixed-stop" hidden>Stop</button>
     </div>
     <div data-transfer-fixed role="status" aria-live="polite"></div>`
  )}
  ${section(
    "List matching items",
    `<p class="mb-hint">Preview available and expired items matching the selected Target filter. Prices follow that filter and the Sell tab. Active, sold, untradeable and unsupported items are skipped.</p>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-transfer-action="matching-preview">Preview matching items</button>
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-transfer-action="matching-list" hidden>List previewed items</button>
       <button type="button" class="mb-btn mb-btn-danger mb-btn-sm" data-transfer-action="futbin-stop" hidden>Stop</button>
     </div>
     <div data-transfer-futbin></div>`
  )}
  ${section(
    "Automatic while the bot runs",
    grid(
      toggleField({ bind: "s:transfer.relistExpired", label: "Relist unsold items", wide: true, hint: "Same price applies to all expired items. Reference mode only touches matching enabled filters." }),
      selectField({
        bind: "s:transfer.relistMode",
        label: "Relist price",
        wide: true,
        showIf: "s:transfer.relistExpired=true",
        options: [
          ["same", "At the same price"],
          ["futbin", "Matching filters at current reference prices"],
        ],
        hint: "References use external prices only. Missing references leave existing prices unchanged. Broad filters and unsupported items require fixed prices.",
      }),
      numberField({ bind: "s:transfer.clearSoldAt", label: "Clear sold cards after", placeholder: "never", hint: "sold cards (0 = never)" }),
      numberField({ bind: "s:transfer.checkEvery", label: "Check every", min: 1, max: 100, hint: "searches" }),
      toggleField({ bind: "s:transfer.stopWhenFull", label: "Stop if the list is full", wide: true })
    )
  )}
`;

// ------------------------------------------------------------------ Alerts

export const alertsPageHtml = () => `
  ${section(
    "Sound & desktop",
    grid(
      toggleField({ bind: "s:notify.sound", label: "Sounds", hint: "Purchase, captcha, stop." }),
      numberField({ bind: "s:notify.volume", label: "Volume (0 to 1)", float: true, min: 0, max: 1 }),
      toggleField({ bind: "s:notify.desktop", label: "Browser notifications", wide: true, hint: "Useful when the tab is in the background." })
    ) +
      `<div class="mb-row" style="margin-top:8px">
        <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-sound="buy">Test: purchase</button>
        <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-sound="alert">Test: alert</button>
      </div>`
  )}
  ${section(
    "Discord & Telegram",
    grid(
      textField({ bind: "s:notify.discordWebhook", label: "Discord webhook", placeholder: "https://discord.com/api/webhooks/…", secret: true, wide: true }),
      textField({ bind: "s:notify.telegramToken", label: "Telegram bot token", placeholder: "123456:ABC…", secret: true, wide: true }),
      textField({ bind: "s:notify.telegramChatId", label: "Telegram chat ID", placeholder: "e.g. 123456789", wide: true })
    ) +
      `<div class="mb-row" style="margin-top:8px"><button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-notify-test>Send test notification</button><span class="mb-hint" data-notify-result></span></div>`
  )}
  ${section(
    "When to notify?",
    grid(
      toggleField({ bind: "s:notify.onBuy", label: "Successful purchase" }),
      toggleField({ bind: "s:notify.onFail", label: "Missed purchase" }),
      toggleField({ bind: "s:notify.onList", label: "Listing" }),
      toggleField({ bind: "s:notify.onStop", label: "Bot stopped" })
    ) + `<p class="mb-hint">Captchas and EA blocks are always reported.</p>`
  )}
`;

// ------------------------------------------------------------------ bindings

export const bindSettingsPages = (body, refreshAll) => {
  body.addEventListener("click", async (event) => {
    const target = event.target;
    const preset = target.closest("[data-preset]");
    if (preset) {
      applyTimingPreset(preset.dataset.preset);
      setHtml(qs(body, "[data-presets]"), presetButtons());
      refreshAll();
      return;
    }
    const soundBtn = target.closest("[data-sound]");
    if (soundBtn) {
      const previous = getSettings().notify.sound;
      if (!previous) {
        setSetting("notify.sound", true);
      }
      sound(soundBtn.dataset.sound);
      if (!previous) {
        setSetting("notify.sound", false);
      }
      return;
    }
    if (target.closest("[data-notify-test]")) {
      const result = qs(body, "[data-notify-result]");
      result.textContent = "sending…";
      const sent = await notifyEvent("test", "🔔 MagicBuyer test: notifications are working.");
      const ok = sent.filter(Boolean).length;
      result.textContent = ok ? `${ok} channel(s) OK` : "no channel configured or sending rejected";
      return;
    }
    const action = target.closest("[data-transfer-action]");
    if (action) {
      if (["futbin-stop", "fixed-stop"].includes(action.dataset.transferAction)) {
        cancelTask();
        return;
      }
      if (isRunning() && action.dataset.transferAction !== "refresh") {
        log.warn("The bot is already managing the transfer list: stop it to act manually.");
        return;
      }
      if (["matching-preview", "matching-list"].includes(action.dataset.transferAction)) {
        await runMatchingListing(body, action.dataset.transferAction === "matching-list");
        return;
      }
      if (action.dataset.transferAction === "fixed-list") {
        await runFixedListing(body);
        return;
      }
      if (currentTask() && action.dataset.transferAction !== "refresh") {
        log.warn("Another manual task is in progress. Stop it before changing the transfer list.");
        return;
      }
      action.disabled = true;
      try {
        await runTransferAction(action.dataset.transferAction);
      } finally {
        action.disabled = false;
        setHtml(qs(body, "[data-transfer-stats]"), transferStatsHtml());
      }
    }
  });
  body.addEventListener("click", (event) => {
    const toggle = event.target.closest && event.target.closest('[data-bind="s:notify.desktop"]');
    if (!toggle) {
      return;
    }
    // After fields.js toggles the setting: request permission if enabled.
    setTimeout(async () => {
      if (!getSettings().notify.desktop) {
        return;
      }
      const permission = await requestDesktopPermission();
      if (permission !== "granted") {
        setSetting("notify.desktop", false);
        log.warn("Browser notifications denied by Chrome.");
        refreshAll();
      }
    }, 0);
  });
};

let matchingPreview = null;
const runFixedListing = async (body) => {
  const out = qs(body, "[data-transfer-fixed]");
  const startBtn = qs(body, '[data-transfer-action="fixed-list"]');
  const stopBtn = qs(body, '[data-transfer-action="fixed-stop"]');
  const price = getSettings().transfer.listPrice;
  const prices = fixedTransferPrices(price);
  if (!prices.valid) { out.innerHTML = `<p class="mb-note is-warn">${escapeHtml(prices.reason)}</p>`; return; }
  const task = beginTask("Fixed transfer listing");
  if (!task) { out.innerHTML = `<p class="mb-note is-warn">Another task is in progress. Stop it before listing.</p>`; return; }
  startBtn.disabled = true;
  stopBtn.hidden = false;
  setRequestToken(task.token);
  const paint = (report) => {
    const summary = `${report.listed} listed · ${report.skipped} skipped · ${report.total} available` +
      (report.current ? ` · ${report.current}` : "") + (report.stopped ? ` · stopped: ${report.stopped}` : "");
    out.innerHTML = `<p class="mb-note">Buy Now ${formatCoins(prices.buyNow)} · starting bid ${formatCoins(prices.start)}<br>${escapeHtml(summary)}</p>`;
  };
  try {
    out.innerHTML = `<p class="mb-note">Loading available cards…</p>`;
    const report = await listAvailableAtFixedPrice({ price, token: task.token, onProgress: paint });
    paint(report);
    log.info(`Fixed transfer listing: ${report.listed} listed, ${report.skipped} skipped${report.stopped ? `; stopped: ${report.stopped}` : ""}.`);
  } catch (e) {
    out.innerHTML = `<p class="mb-note is-warn">${escapeHtml(e.message || e)}</p>`;
  } finally {
    endTask(task);
    setRequestToken(null);
    startBtn.disabled = false;
    stopBtn.hidden = true;
    await runTransferAction("refresh");
    setHtml(qs(body, "[data-transfer-stats]"), transferStatsHtml());
  }
};

const runMatchingListing = async (body, execute) => {
  const out = qs(body, "[data-transfer-futbin]");
  const startBtn = qs(body, '[data-transfer-action="matching-preview"]');
  const listBtn = qs(body, '[data-transfer-action="matching-list"]');
  const stopBtn = qs(body, '[data-transfer-action="futbin-stop"]');
  const task = beginTask(execute ? "Matching listing" : "Listing preview");
  if (!task) {
    const other = currentTask();
    out.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">Another task is in progress (${other ? other.label : "?"}).</div>`;
    return;
  }
  startBtn.disabled = true;
  listBtn.disabled = true;
  stopBtn.hidden = false;
  setRequestToken(task.token);
  const paint = (report) => {
    out.innerHTML = `<div class="mb-note" style="margin-top:8px">${report.listed} listed out of ${report.total}${
      report.skipped ? ` · ${report.skipped} skipped` : ""
    }${report.current ? ` · in progress: ${report.current}` : ""}</div>`;
  };
  try {
    if (!execute) {
      matchingPreview = null;
      listBtn.hidden = true;
      out.innerHTML = `<div class="mb-note" role="status">Preparing external reference prices… Stop cancels remaining work.</div>`;
      const preview = await previewMatchingItems({ filter: getActiveFilter(), token: task.token });
      if (task.token.cancelled) { out.innerHTML = `<div class="mb-note">Preview cancelled.</div>`; return; }
      if (!preview.ok) { out.innerHTML = `<div class="mb-note is-warn">${escapeHtml(preview.error.label)}</div>`; return; }
      matchingPreview = preview;
      out.innerHTML = `<p class="mb-hint">${escapeHtml(preview.filter.name)} · ${preview.rows.length} matching item(s)</p>
        <div class="mb-preview"><table><thead><tr><th>Item</th><th>Reference</th><th>Proposed BIN</th></tr></thead><tbody>${preview.rows.map((row) =>
          `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.reason || row.quote.source)}${row.quote.reference ? ` · ${formatCoins(row.quote.reference)}` : ""}</td><td>${row.reason ? "Skipped" : formatCoins(row.buyNow)}</td></tr>`).join("")}</tbody></table></div>
        <p class="mb-hint">Changed references or price limits are skipped when listing. Preview again to review new prices.</p>`;
      listBtn.hidden = !preview.rows.some((row) => !row.reason);
    } else if (matchingPreview) {
      const preview = matchingPreview;
      matchingPreview = null;
      listBtn.hidden = true;
      const report = await listMatchingPreview({ preview, token: task.token, onProgress: paint });
      const summary = `${report.listed} listed · ${report.skipped} skipped${report.stopped ? ` · stopped: ${report.stopped}` : ""}`;
      out.innerHTML = `<div class="mb-note" role="status">${escapeHtml(summary)}</div>`;
      log.info(summary);
    }
  } catch (e) {
    out.innerHTML = `<div class="mb-note is-warn">${escapeHtml(e.message || e)}</div>`;
  } finally {
    endTask(task);
    setRequestToken(null);
    startBtn.disabled = false;
    listBtn.disabled = false;
    stopBtn.hidden = true;
    await runTransferAction("refresh");
    setHtml(qs(body, "[data-transfer-stats]"), transferStatsHtml());
  }
};

export const refreshTransferStats = (body) => {
  const el = qs(body, "[data-transfer-stats]");
  if (el) {
    setHtml(el, transferStatsHtml());
  }
};

const runTransferAction = async (action) => {
  if (action === "refresh") {
    const result = await market.fetchTransferList();
    if (result.ok) {
      const summary = market.summarizeTransferList(result.items);
      updateState({ transfer: Object.assign({ capacity: market.pileCapacity("TRANSFER") }, summary) });
    } else {
      log.warn(`Transfer list unavailable: ${result.error.label}.`);
    }
    return;
  }
  if (action === "relist") {
    const result = await market.relistExpired();
    if (result.ok) {
      log.success("Unsold cards relisted.");
    } else {
      log.warn(`Cannot relist: ${result.error.label}.`);
    }
  }
  if (action === "clear") {
    const result = await market.clearSold();
    if (result.ok) {
      log.success("Sold cards removed from the list.");
      await market.refreshCoins();
    } else {
      log.warn(`Cannot clear sold cards: ${result.error.label}.`);
    }
  }
  await runTransferAction("refresh");
};

