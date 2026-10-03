import { isRunning } from "../core/engine";
import { errorMessage, log } from "../core/logger";
import { pageGlobal } from "../core/page";
import { floorPrice, formatCoins, parseCoinsInput } from "../core/prices";
import {
  applySession,
  buyMissing,
  entryPrice,
  formationLabel,
  loadSolution,
  maxPriceFor,
  priceStatus,
  releaseSession,
  sessionSummary,
} from "../core/sbc";
import { beginTask, cancelTask, currentTask, endTask } from "../core/tasks";
import { onPriceUpdate } from "../prices/priceService";
import { escapeHtml, qs } from "./dom";
import { injectStyles } from "./panel";

// SBC squad screen: FUTBIN Solution button → paste link, preview players
// (club / storage / to buy), place them in the squad, buy missing players at the FUTBIN price.
// Intercept only two EA methods without superclass() calls (initWithSBCSet and
// getNavigationTitle): the controller's other methods cannot be wrapped.

let activeCtrl = null;
let hooked = false;
let fab = null;
let modal = null;
let session = null;
let running = null;
let loading = false;
let unwatchPrices = null;
let repaintTimer = null;
const lastUrls = new Map();

const STATE_LABEL = {
  owned: "In your club",
  missing: "To buy",
  searching: "Searching…",
  bought: "Purchased",
  failed: "Failed",
};

const ctrlAlive = (ctrl) => {
  try {
    if (!ctrl || !ctrl._challenge) {
      return false;
    }
    const root = ctrl.getView().getRootElement();
    return !!(root && root.isConnected);
  } catch (e) {
    return false;
  }
};

const challengeKey = (ctrl) => {
  try {
    return String(ctrl._challenge.id);
  } catch (e) {
    return "";
  }
};

// ------------------------------------------------------------------ interception

export const hookSbc = () => {
  if (hooked) {
    return true;
  }
  const Ctrl = pageGlobal("UTSBCSquadOverviewViewController");
  if (typeof Ctrl !== "function" || !Ctrl.prototype) {
    return false;
  }
  const proto = Ctrl.prototype;
  if (!proto.__mbSbc) {
    ["initWithSBCSet", "getNavigationTitle"].forEach((name) => {
      const original = proto[name];
      if (typeof original !== "function") {
        return;
      }
      proto[name] = function () {
        activeCtrl = this;
        return original.apply(this, arguments);
      };
    });
    proto.__mbSbc = true;
  }
  hooked = true;
  return true;
};

// --------------------------------------------------------------- floating button

const ensureFab = () => {
  if (fab && fab.isConnected) {
    return fab;
  }
  fab = document.createElement("button");
  fab.type = "button";
  fab.id = "mb-sbc-fab";
  fab.textContent = "⚡ FUTBIN Solution";
  fab.title = "Import a FUTBIN solution into this challenge (MagicBuyer)";
  ["pointerdown", "mousedown", "touchstart", "touchend", "mouseup", "pointerup"].forEach((type) =>
    fab.addEventListener(type, (event) => event.stopPropagation())
  );
  fab.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openModal();
  });
  document.body.appendChild(fab);
  return fab;
};

export const tickSbc = () => {
  hookSbc();
  const visible = ctrlAlive(activeCtrl);
  if (!visible && !modal) {
    if (fab) {
      fab.hidden = true;
    }
    return;
  }
  if (!document.body) {
    return;
  }
  injectStyles();
  const button = ensureFab();
  button.hidden = !visible || !!modal;
};

// -------------------------------------------------------------------- dialog

const modalHtml = (title) => `
  <div class="mb-sbc-backdrop" data-sbc-close></div>
  <div class="mb-sbc-dialog" role="dialog" aria-modal="true" aria-label="FUTBIN Solution">
    <header class="mb-sbc-head">
      <div><strong>⚡ FUTBIN Solution</strong><small>${escapeHtml(title || "Challenge")}</small></div>
      <button type="button" class="mb-sbc-x" data-sbc-close aria-label="Close">×</button>
    </header>
    <div class="mb-sbc-url">
      <input type="url" data-sbc-url placeholder="https://www.futbin.com/27/squad/…" autocomplete="off" spellcheck="false" aria-label="FUTBIN link" />
      <button type="button" class="mb-sbc-btn is-primary" data-sbc-load>Load</button>
    </div>
    <p class="mb-sbc-status" data-sbc-status>Paste the FUTBIN link to a solution for this challenge (squad page), then click “Load”.</p>
    <div class="mb-sbc-body" data-sbc-body></div>
    <footer class="mb-sbc-foot">
      <span class="mb-sbc-summary" data-sbc-summary></span>
      <button type="button" class="mb-sbc-btn" data-sbc-apply disabled>Place in squad</button>
      <button type="button" class="mb-sbc-btn is-primary" data-sbc-buy disabled>Buy missing players</button>
      <button type="button" class="mb-sbc-btn is-danger" data-sbc-stop hidden>Stop</button>
    </footer>
  </div>`;

const setStatus = (text, kind = "") => {
  if (!modal) {
    return;
  }
  const el = qs(modal, "[data-sbc-status]");
  el.textContent = text;
  el.dataset.kind = kind;
};

const rowHtml = (entry, index) => {
  const editable = entry.state === "missing" || entry.state === "failed";
  const price = entryPrice(entry);
  const auto = maxPriceFor(Object.assign({}, entry, { manual: false }));
  const player = entry.player;
  const link = player.url ? ` <a href="${escapeHtml(player.url)}" target="_blank" rel="noopener" title="FUTBIN page">↗</a>` : "";
  return `<tr data-sbc-row="${index}" class="is-${entry.state}">
    <td class="mb-sbc-pos">${escapeHtml(entry.slotLabel || player.position || "—")}</td>
    <td><b>${escapeHtml(player.name || `#${player.eaId}`)}</b> <span class="mb-sbc-rating">${player.rating || ""}</span>${link}
      <small data-sbc-note>${escapeHtml(entry.note || (entry.source && entry.state === "owned" ? entry.source : ""))}</small></td>
    <td data-sbc-state>${STATE_LABEL[entry.state] || entry.state}</td>
    <td class="is-num"><span data-sbc-price>${price ? formatCoins(price) : "—"}</span><small data-sbc-age>${escapeHtml(priceStatus(entry))}</small></td>
    <td class="is-num">${
      editable
        ? `<input class="mb-sbc-max" data-sbc-max="${index}" inputmode="text" autocomplete="off" value="${entry.manual ? entry.maxPrice : ""}" placeholder="${auto ? auto : "enter price"}" aria-label="Max price for ${escapeHtml(player.name)}" />`
        : entry.boughtPrice
        ? formatCoins(entry.boughtPrice)
        : ""
    }</td>
  </tr>`;
};

const renderTable = () => {
  if (!modal) {
    return;
  }
  const body = qs(modal, "[data-sbc-body]");
  if (!session) {
    body.innerHTML = "";
    return;
  }
  const formation = session.formation
    ? `Formation ${escapeHtml(session.futbinFormation || formationLabel(session.formation))} → ${escapeHtml(formationLabel(session.formation))}`
    : session.futbinFormation
    ? `FUTBIN formation ${escapeHtml(session.futbinFormation)} not found: keeping current formation`
    : "Keeping current formation";
  const title = session.challengeName ? `FUTBIN Solution “${escapeHtml(session.challengeName)}” · ` : "";
  body.innerHTML = `<p class="mb-sbc-meta">${title}${formation} · ${session.entries.length} player(s) · fetched via ${session.via === "iframe" ? "hidden FUTBIN page" : "direct request"}</p>
    <table class="mb-sbc-table">
      <thead><tr><th>Position</th><th>Player</th><th>Status</th><th class="is-num">FUTBIN</th><th class="is-num">Max</th></tr></thead>
      <tbody>${session.entries.map(rowHtml).join("")}</tbody>
    </table>`;
  paintSummary();
};

// Update a row without touching the field currently being edited.
const paintRow = (index) => {
  if (!modal || !session) {
    return;
  }
  const row = qs(modal, `[data-sbc-row="${index}"]`);
  const entry = session.entries[index];
  if (!row || !entry) {
    return;
  }
  const input = qs(row, "[data-sbc-max]");
  const editable = entry.state === "missing" || entry.state === "failed";
  if (!!input !== editable) {
    const fresh = document.createElement("tbody");
    fresh.innerHTML = rowHtml(entry, index);
    row.replaceWith(fresh.firstElementChild);
    paintSummary();
    return;
  }
  row.className = `is-${entry.state}`;
  qs(row, "[data-sbc-state]").textContent = STATE_LABEL[entry.state] || entry.state;
  qs(row, "[data-sbc-note]").textContent = entry.note || (entry.source && entry.state === "owned" ? entry.source : "");
  const price = entryPrice(entry);
  qs(row, "[data-sbc-price]").textContent = price ? formatCoins(price) : "—";
  qs(row, "[data-sbc-age]").textContent = priceStatus(entry);
  if (input && document.activeElement !== input) {
    const auto = maxPriceFor(Object.assign({}, entry, { manual: false }));
    input.placeholder = auto ? String(auto) : "enter price";
  }
  paintSummary();
};

const paintSummary = () => {
  if (!modal) {
    return;
  }
  const summaryEl = qs(modal, "[data-sbc-summary]");
  const applyBtn = qs(modal, "[data-sbc-apply]");
  const buyBtn = qs(modal, "[data-sbc-buy]");
  const stopBtn = qs(modal, "[data-sbc-stop]");
  if (!session) {
    summaryEl.textContent = "";
    applyBtn.disabled = true;
    buyBtn.disabled = true;
    return;
  }
  const summary = sessionSummary(session);
  summaryEl.innerHTML =
    `<b>${summary.placed}/${summary.total}</b> available · <b>${summary.missing}</b> to buy` +
    (summary.missing ? ` · max budget <b>${formatCoins(summary.budget)}</b>${summary.unknown ? ` (+${summary.unknown} without a price)` : ""}` : "") +
    (summary.coins ? ` · you have ${formatCoins(summary.coins)}` : "");
  summaryEl.classList.toggle("is-short", !!(summary.coins && summary.budget > summary.coins));
  const busy = !!running;
  applyBtn.disabled = busy;
  buyBtn.disabled = busy || !summary.missing;
  stopBtn.hidden = !busy;
  qs(modal, "[data-sbc-load]").disabled = busy;
};

const schedulePaint = () => {
  if (repaintTimer) {
    return;
  }
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    if (session) {
      session.entries.forEach((_, index) => paintRow(index));
    }
  }, 250);
};

const closeModal = () => {
  if (running) {
    setStatus("Purchasing in progress: click Stop before closing.", "warn");
    return;
  }
  if (modal) {
    modal.remove();
    modal = null;
  }
  releaseSession(session);
  session = null;
  if (unwatchPrices) {
    unwatchPrices();
    unwatchPrices = null;
  }
};

const openModal = () => {
  if (modal) {
    return;
  }
  const ctrl = activeCtrl;
  if (!ctrlAlive(ctrl)) {
    return;
  }
  injectStyles();
  modal = document.createElement("div");
  modal.id = "mb-sbc";
  modal.innerHTML = modalHtml(ctrl._challenge && ctrl._challenge.name);
  ["pointerdown", "mousedown", "touchstart", "touchend", "mouseup", "pointerup", "keydown", "keyup"].forEach((type) =>
    modal.addEventListener(type, (event) => event.stopPropagation())
  );
  modal.addEventListener("click", onClick);
  modal.addEventListener("change", onChange);
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
    } else if (event.key === "Enter" && event.target.matches("[data-sbc-url]")) {
      load();
    } else if (event.key === "Enter" && event.target.matches("[data-sbc-max]")) {
      event.target.blur();
    }
  });
  document.body.appendChild(modal);
  modal.__ctrl = ctrl;
  const url = lastUrls.get(challengeKey(ctrl));
  const input = qs(modal, "[data-sbc-url]");
  if (url) {
    input.value = url;
  }
  input.focus();
  unwatchPrices = onPriceUpdate(() => schedulePaint());
  if (fab) {
    fab.hidden = true;
  }
};

// ---------------------------------------------------------------------- actions

const load = async () => {
  if (!modal || running || loading) {
    return;
  }
  const url = qs(modal, "[data-sbc-url]").value.trim();
  if (!url) {
    setStatus("Paste a FUTBIN link first.", "warn");
    return;
  }
  const ctrl = modal.__ctrl;
  lastUrls.set(challengeKey(ctrl), url);
  releaseSession(session);
  session = null;
  renderTable();
  setStatus("Fetching the FUTBIN page and searching your club…");
  qs(modal, "[data-sbc-load]").disabled = true;
  loading = true;
  try {
    const result = await loadSolution(ctrl, url);
    if (!modal) {
      if (result.session) {
        releaseSession(result.session);
      }
      return;
    }
    if (!result.ok) {
      setStatus(result.message, "error");
      return;
    }
    session = result.session;
    renderTable();
    if (session.ownedErrors.length) {
      setStatus(`Club search incomplete (${session.ownedErrors[0].label}): check the list, then click “Place in squad”.`, "warn");
      return;
    }
    // Solution read from FUTBIN JSON: reliable, fill the squad immediately. HTML parsing
    // (fallback): only if the entire squad was recognized.
    const open = (session.slots || []).filter((slot) => !slot.brick).length;
    const complete = session.source === "json" || session.entries.length >= Math.min(11, open || 11);
    if (!complete) {
      setStatus(`Only ${session.entries.length} player(s) found on the FUTBIN page: check the list, then click “Place in squad”.`, "warn");
      return;
    }
    // Complete solution: fill the challenge squad immediately with club players.
    setStatus("Placing your club players in the squad…");
    const placed = await applySession(session);
    if (!modal) {
      return;
    }
    renderTable();
    const summary = sessionSummary(session);
    if (!placed.ok) {
      setStatus(placed.message, "error");
    } else {
      setStatus(
        summary.missing
          ? `Squad filled: ${summary.placed}/${summary.total} players placed. Check the max prices for the ${summary.missing} missing player(s), then click “Buy missing players”.`
          : "Squad filled with your players. Check the requirements, then submit the challenge yourself.",
        "ok"
      );
    }
  } catch (e) {
    setStatus(`Error: ${errorMessage(e)}`, "error");
  } finally {
    loading = false;
    if (modal) {
      qs(modal, "[data-sbc-load]").disabled = false;
      paintSummary();
    }
  }
};

const apply = async () => {
  if (!session || running) {
    return;
  }
  setStatus("Placing players and saving the challenge…");
  const result = await applySession(session);
  if (!modal) {
    return;
  }
  renderTable();
  setStatus(result.ok ? "Squad saved. Check the requirements, then submit the challenge yourself." : result.message, result.ok ? "ok" : "error");
};

const buy = async () => {
  if (!session || running) {
    return;
  }
  if (isRunning()) {
    setStatus("Stop the bot first (MagicBuyer panel): only one automated task at a time.", "warn");
    return;
  }
  const summary = sessionSummary(session);
  if (summary.unknown) {
    setStatus("Some missing players have no live FUTBIN price: enter a max price for each (“enter price” field).", "warn");
    return;
  }
  if (summary.coins && summary.budget > summary.coins) {
    setStatus(`Max budget ${formatCoins(summary.budget)} exceeds your coins (${formatCoins(summary.coins)}): lower some max prices or free up coins.`, "warn");
    return;
  }
  const task = beginTask("SBC purchase");
  if (!task) {
    const other = currentTask();
    setStatus(`Another task is in progress (${other ? other.label : "?"}).`, "warn");
    return;
  }
  running = task;
  paintSummary();
  setStatus("Buying missing players… (you can stop at any time)");
  log.info(`SBC: buying ${summary.missing} missing player(s), max budget ${formatCoins(summary.budget)}.`);
  let report;
  try {
    // Place already owned players first: purchases complete the squad.
    await applySession(session);
    renderTable();
    report = await buyMissing(session, {
      token: task.token,
      onUpdate: (entry) => paintRow(session.entries.indexOf(entry)),
    });
  } catch (e) {
    report = { bought: 0, spent: 0, failed: 0, stopped: errorMessage(e) };
  } finally {
    endTask(task);
    running = null;
  }
  if (!modal) {
    return;
  }
  renderTable();
  const text =
    `${report.bought} purchased for ${formatCoins(report.spent)}` +
    (report.failed ? ` · ${report.failed} not found below your max price` : "") +
    (report.stopped ? ` · stopped: ${report.stopped}` : "") +
    ". Check the squad, then submit the challenge yourself.";
  setStatus(text, report.stopped || report.failed ? "warn" : "ok");
  log.info(`SBC completed: ${text}`);
};

function onClick(event) {
  const target = event.target;
  if (target.closest("[data-sbc-close]")) {
    closeModal();
  } else if (target.closest("[data-sbc-load]")) {
    load();
  } else if (target.closest("[data-sbc-apply]")) {
    apply();
  } else if (target.closest("[data-sbc-buy]")) {
    buy();
  } else if (target.closest("[data-sbc-stop]")) {
    cancelTask();
    setStatus("Stop requested: finishing the current request…", "warn");
  }
}

function onChange(event) {
  const input = event.target.closest("[data-sbc-max]");
  if (!input || !session) {
    return;
  }
  const entry = session.entries[Number(input.dataset.sbcMax)];
  if (!entry) {
    return;
  }
  const value = floorPrice(parseCoinsInput(input.value));
  entry.manual = value > 0;
  entry.maxPrice = value;
  input.value = value ? String(value) : "";
  paintSummary();
}

export const closeSbcModal = () => closeModal();
