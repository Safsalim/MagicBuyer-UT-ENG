import { log } from "../../core/logger";
import { formatCoins } from "../../core/prices";
import { fetchFutbinPrice, futbinRequestCount, resolveFutbinLink } from "../../prices/futbinClient";
import { clearFutbinCache, getFutbinStatus, pricePlatform } from "../../prices/priceService";
import { escapeHtml, qs, setHtml } from "../dom";
import { grid, numberField, rangeField, section, selectField, toggleField } from "../fields";

// FUTBIN tab: access test, refresh frequency, card badges, SBCs.

const TEST_CARD = { definitionId: 231747, name: "Mbappé", rating: 0 };

const STATE_TEXT = {
  idle: "ready",
  fetching: "fetching",
  queued: "queued",
  blocked: "throttled (FUTBIN blocking)",
};

const ago = (timestamp) => {
  if (!timestamp) {
    return "jamais";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
};

const statusHtml = () => {
  const status = getFutbinStatus();
  const cell = (label, value) => `<div>${label}<b>${value}</b></div>`;
  const blocked = status.blockedUntil > Date.now();
  return `<div class="mb-stats-list">
      ${cell("Status", escapeHtml(STATE_TEXT[status.state] || status.state))}
      ${cell("Platform", pricePlatform() === "pc" ? "PC" : "Console")}
      ${cell("Tracked cards", status.tracked)}
      ${cell("Pending", status.queue)}
      ${cell("Last price fetched", ago(status.lastSuccessAt))}
      ${cell("FUTBIN requests", futbinRequestCount())}
    </div>${
      status.lastError || blocked
        ? `<div class="mb-note is-warn" style="margin-top:8px">${escapeHtml(status.lastError || "FUTBIN throttled")}${
            blocked ? ` · resuming in ${Math.ceil((status.blockedUntil - Date.now()) / 1000)} s` : ""
          }</div>`
        : ""
    }`;
};

export const futbinPageHtml = () => `
  ${section(
    "FUTBIN access",
    `<div data-futbin-status>${statusHtml()}</div>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-futbin-action="test">Test FUTBIN</button>
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-futbin-action="open">Open futbin.com</button>
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-futbin-action="clear">Clear price cache</button>
     </div>
     <div data-futbin-test></div>
     <p class="mb-hint">Prices are fetched from FUTBIN pages (as in your browser). Requests run one at a time, spaced out, with automatic throttling if FUTBIN blocks them.</p>`
  )}
  ${section(
    "Price refresh",
    grid(
      selectField({
        bind: "s:prices.platform",
        label: "Price platform",
        wide: true,
        options: [
          ["auto", "Automatic (your account platform)"],
          ["console", "Console (PlayStation / Xbox)"],
          ["pc", "PC"],
        ],
      }),
      numberField({ bind: "s:prices.hotInterval", label: "Bot targets and SBC purchases", min: 60, max: 120, hint: "refreshed every N seconds (60 to 120)" }),
      numberField({ bind: "s:prices.visibleInterval", label: "Displayed cards", min: 60, max: 600, hint: "seconds; less often if the price is unchanged" }),
      numberField({ bind: "s:prices.jumpGuard", label: "Suspicious price jump", min: 5, max: 90, hint: "% difference: rechecked before the bot uses it" }),
      numberField({ bind: "s:prices.minGap", label: "Request spacing", float: true, min: 0.8, max: 10, hint: "seconds between FUTBIN pages" }),
      toggleField({
        bind: "s:prices.iframeFallback",
        label: "Fallback: hidden FUTBIN page",
        wide: true,
        hint: "If FUTBIN rejects the direct request (Cloudflare), load the page in an invisible iframe.",
      })
    )
  )}
  ${section(
    "Display",
    grid(
      toggleField({
        bind: "s:ui.cardPrices",
        label: "FUTBIN prices on cards",
        wide: true,
        hint: "Small badge at the top of each player card (club, market, transfers, squads, SBCs). Click to open the card's FUTBIN page.",
      })
    )
  )}
  ${section(
    "SBCs: FUTBIN solutions",
    grid(
      numberField({ bind: "s:sbc.margin", label: "Margin above FUTBIN price", min: 0, max: 50, hint: "% added to the FUTBIN price for missing players' max buy prices" }),
      numberField({ bind: "s:sbc.triesPerPlayer", label: "Searches per player", min: 1, max: 30 }),
      rangeField({ bind: "s:sbc.wait", label: "Pause between searches", unit: "S", placeholder: "3-5", wide: true })
    ) +
      `<p class="mb-hint">In a challenge squad, click “⚡ FUTBIN Solution” (at the top of the screen) and paste the solution link. The challenge is never submitted automatically.</p>`
  )}
`;

export const refreshFutbinStatus = (body) => {
  const el = qs(body, "[data-futbin-status]");
  if (el) {
    setHtml(el, statusHtml());
  }
};

const runTest = async (out) => {
  const started = Date.now();
  out.innerHTML = `<div class="mb-note" style="margin-top:8px">Testing (search, then player page)…</div>`;
  // Explicit test: retry the direct request even if FUTBIN recently rejected it.
  const resolved = await resolveFutbinLink(TEST_CARD, { forceDirect: true });
  if (!resolved.ok) {
    const message = resolved.blocked
      ? "FUTBIN requires verification (Cloudflare). Click “Open futbin.com”, complete the verification if shown, then test again."
      : resolved.notFound
      ? "FUTBIN responds, but the test card cannot be found: the FUTBIN search format may have changed."
      : `FUTBIN is not responding${resolved.status ? ` (${resolved.status})` : ""}.`;
    out.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">✗ ${escapeHtml(message)}</div>`;
    log.warn(`FUTBIN test: ${message}`);
    return;
  }
  const platform = pricePlatform();
  const price = await fetchFutbinPrice(resolved.link, platform, { forceDirect: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1).replace(".", ",");
  if (!price.ok) {
    const message = price.blocked
      ? "the player page is blocked by Cloudflare"
      : price.noPrice
      ? "the player page was fetched but its price cannot be found (FUTBIN format changed?)"
      : `the player page is not responding${price.status ? ` (${price.status})` : ""}`;
    out.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">✗ Search OK, but ${escapeHtml(message)}.</div>`;
    log.warn(`Test FUTBIN : ${message}.`);
    return;
  }
  const via = price.via === "iframe" ? "hidden page (fallback)" : "direct request";
  const age = price.updatedAgoSec ? ` · updated by FUTBIN ${Math.round(price.updatedAgoSec / 60)} min ago` : "";
  out.innerHTML = `<div class="mb-note" style="margin-top:8px">✓ FUTBIN accessible (${escapeHtml(via)}) : ${escapeHtml(
    resolved.link.name || TEST_CARD.name
  )} = <b>${formatCoins(price.price)}</b> (${platform === "pc" ? "PC" : "console"})${age} · ${seconds} s</div>`;
  log.success(`FUTBIN test passed (${via}) : ${resolved.link.name || TEST_CARD.name} = ${formatCoins(price.price)}.`);
};

export const bindFutbinPage = (page) => {
  page.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-futbin-action]");
    if (!action) {
      return;
    }
    if (action.dataset.futbinAction === "open") {
      window.open("https://www.futbin.com/", "_blank", "noopener");
      return;
    }
    if (action.dataset.futbinAction === "clear") {
      if (window.confirm("Clear the FUTBIN price and link cache?")) {
        clearFutbinCache();
        log.info("FUTBIN cache cleared.");
        refreshFutbinStatus(page);
      }
      return;
    }
    if (action.dataset.futbinAction === "test") {
      action.disabled = true;
      try {
        await runTest(qs(page, "[data-futbin-test]"));
      } finally {
        action.disabled = false;
        refreshFutbinStatus(page);
      }
    }
  });
};
