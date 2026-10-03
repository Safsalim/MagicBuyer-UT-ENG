import { isFinalizing, isPaused, isRunning, isStopping, startBot, stopBot } from "../core/engine";
import { formatDuration } from "../core/ranges";
import { STATUS_LABEL, getState, onStateChange } from "../core/state";
import { qs, setText } from "./dom";
import { togglePanel } from "./panel";

// Floating badge: bot status, panel access, and quick Start/Stop.

let hud = null;
let timer = null;

const paint = () => {
  if (!hud) {
    return;
  }
  const state = getState();
  const status = isPaused() ? "paused" : state.status;
  if (hud.dataset.status !== status) {
    hud.dataset.status = status;
  }
  const running = isRunning();
  const stats = state.stats;
  setText(qs(hud, "[data-hud-label]"), running ? STATUS_LABEL[status] || "Sniping" : "MagicBuyer");
  const elapsed = state.startedAt && running ? formatDuration(Date.now() - state.startedAt) : "";
  setText(
    qs(hud, "[data-hud-detail]"),
    running || stats.searches
      ? `🔎 ${stats.searches} · ✅ ${stats.won}${elapsed ? ` · ${elapsed}` : ""}`
      : "Open sniper"
  );
  const action = qs(hud, "[data-hud-action]");
  action.disabled = isStopping() && !isFinalizing();
  setText(action, running ? "■" : "▶");
  action.setAttribute("aria-label", running ? "Stop bot" : "Start bot");
  action.title = running ? "Stop" : "Start";
};

export const ensureHud = () => {
  if (hud && document.body && document.body.contains(hud)) {
    return hud;
  }
  if (!document.body) {
    return null;
  }
  hud = document.getElementById("mb-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "mb-hud";
    hud.dataset.status = "idle";
    hud.innerHTML = `
      <button type="button" class="mb-hud-main" data-hud-toggle aria-label="Open MagicBuyer">
        <span class="mb-hud-logo">MB</span>
        <span class="mb-dot"></span>
        <span class="mb-hud-text"><b data-hud-label>MagicBuyer</b><small data-hud-detail>Open sniper</small></span>
      </button>
      <button type="button" class="mb-hud-action" data-hud-action aria-label="Start bot">▶</button>`;
    document.body.appendChild(hud);
    hud.addEventListener("click", (event) => {
      if (event.target.closest("[data-hud-action]")) {
        if (isRunning()) {
          stopBot("manual stop", { manual: true });
        } else if (!startBot()) {
          togglePanel();
        }
        paint();
        return;
      }
      if (event.target.closest("[data-hud-toggle]")) {
        togglePanel();
      }
    });
    onStateChange(paint);
    if (!timer) {
      timer = setInterval(paint, 1000);
    }
  }
  paint();
  return hud;
};
