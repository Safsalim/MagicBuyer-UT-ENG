import { createCancelToken, sleep } from "./async";
import { isFatal, KIND } from "./errors";
import { getSettings } from "./settings";
import { pickSeconds } from "./ranges";

// All EA requests share this lane, including read-only price discovery.
const pending = [];
let busy = false;
let nextAt = 0;
let cooldownAt = 0;
let halted = null;
let defaultToken = null;
let gate = () => false;
let wake = null;
const cancelled = () => ({ ok: false, response: null, error: { kind: "cancelled", code: 0, label: "request cancelled" } });
export const setRequestToken = (token, blocked = () => false) => { defaultToken = token; gate = blocked; };
export const resetRequestQueue = () => { halted = null; nextAt = 0; cooldownAt = 0; };
export const queueError = () => halted;

const pump = async () => {
  if (busy) return;
  busy = true;
  try {
    while (pending.length) {
      pending.sort((a, b) => Number(b.urgent) - Number(a.urgent));
      const entry = pending[0];
      if (halted || entry.token && entry.token.cancelled) {
        pending.shift().resolve(halted ? { ok: false, response: null, error: halted } : cancelled());
        continue;
      }
      const wait = gate() ? 250 : Math.max(0, (entry.urgent ? cooldownAt : Math.max(nextAt, cooldownAt)) - Date.now());
      if (wait) {
        wake = createCancelToken();
        const onCancel = () => wake && wake.cancel();
        if (entry.token && entry.token.on) entry.token.on(onCancel);
        await sleep(wait, wake);
        if (entry.token && entry.token.off) entry.token.off(onCancel);
        wake = null;
        continue;
      }
      pending.shift();
      const settings = getSettings();
      const timing = settings.timing;
      nextAt = Date.now() + Math.max(900, (pickSeconds(timing.wait, "S") || 5) * 1000,
        timing.maxPerMinute > 0 ? 60000 / timing.maxPerMinute : 0);
      try {
        const result = await entry.run();
        const error = result && result.error;
        if (error && isFatal(error.kind)) halted = error;
        if (error && [KIND.RATE, KIND.BLOCKED].includes(error.kind)) {
          cooldownAt = Date.now() + (pickSeconds(settings.errors.cooldown, "M") || 300) * 1000;
        }
        entry.resolve(result);
      } catch (e) { entry.reject(e); }
    }
  } finally { busy = false; }
};
export const enqueueEa = (run, token = defaultToken, urgent = false) => new Promise((resolve, reject) => {
  pending.push({ run, token, urgent, resolve, reject });
  if (urgent && wake) wake.cancel();
  pump();
});
