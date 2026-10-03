// Use the normal FUTBIN tab's browser session when extension requests are rejected.
// Only this userscript's private storage carries requests and public page responses.
const READY = "mb5.futbinTab.ready";
const REQUEST = "mb5.futbinTab.request";
const RESPONSE = "mb5.futbinTab.response";
const READY_TTL = 90000; // Background tabs may have their timers throttled by Chrome.
const REQUEST_TTL = 20000;

const read = (key) => {
  try {
    return typeof GM_getValue === "function" ? GM_getValue(key, null) : null;
  } catch (e) {
    return null;
  }
};
const write = (key, value) => {
  try {
    if (typeof GM_setValue !== "function") return false;
    GM_setValue(key, value);
    return true;
  } catch (e) {
    return false;
  }
};
const watch = (key, callback) => {
  try {
    if (typeof GM_addValueChangeListener === "function" && typeof GM_removeValueChangeListener === "function") {
      const id = GM_addValueChangeListener(key, callback);
      return () => GM_removeValueChangeListener(id);
    }
  } catch (e) {}
  const timer = setInterval(callback, 500);
  return () => clearInterval(timer);
};
const nonce = () => {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((value) => value.toString(16)).join("-");
};

const readyTab = () => {
  const ready = read(READY);
  return ready && typeof ready.id === "string" && ready.seenAt <= Date.now() && Date.now() - ready.seenAt < READY_TTL
    ? ready : null;
};
export const futbinTabAvailable = () => !!readyTab();

// Reject credentials, alternate ports, and unrelated destinations before any fetch.
const futbinUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^(www\.)?futbin\.com$/i.test(url.hostname) && !url.port && !url.username && !url.password
      ? url : null;
  } catch (e) {
    return null;
  }
};

let booted = false;
export const bootFutbinTabBridge = () => {
  if (booted || window.top !== window || !futbinUrl(location.href) || typeof GM_getValue !== "function" || typeof GM_setValue !== "function") return;
  booted = true;
  const id = nonce();
  let busy = false;
  let lastId = "";
  const serve = async () => {
    const request = read(REQUEST);
    if (busy || !request || request.worker !== id || request.id === lastId || typeof request.id !== "string" ||
        request.expiresAt <= Date.now() || request.expiresAt > Date.now() + REQUEST_TTL) return;
    const target = futbinUrl(request.url);
    if (!target) return;
    busy = true;
    lastId = request.id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, request.expiresAt - Date.now()));
    let response = { id: request.id, worker: id, status: 0, text: "" };
    try {
      // Both FUTBIN hostnames use this tab's origin, keeping cookies first-party.
      const res = await fetch(`${location.origin}${target.pathname}${target.search}`, {
        method: "GET", credentials: "same-origin", redirect: "error", signal: controller.signal,
        headers: { Accept: request.json ? "application/json, text/plain, */*" : "text/html, */*" },
      });
      response = Object.assign(response, { status: res.status, text: await res.text() });
    } catch (e) {}
    clearTimeout(timer);
    if (Date.now() < request.expiresAt && (read(REQUEST) || {}).id === request.id) {
      write(RESPONSE, response);
    }
    busy = false;
  };
  const heartbeat = () => {
    const ready = readyTab();
    if (!ready || ready.id === id) write(READY, { id, seenAt: Date.now() });
    const response = read(RESPONSE);
    const request = read(REQUEST);
    if (response && (!request || request.expiresAt <= Date.now())) write(RESPONSE, null);
    serve();
  };
  const unwatch = watch(REQUEST, serve);
  const timer = setInterval(heartbeat, 5000);
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    unwatch();
    if ((read(READY) || {}).id === id) write(READY, null);
    booted = false;
  }, { once: true });
  heartbeat();
};

let chain = Promise.resolve();
export const fetchViaFutbinTab = (url, { json = false, timeoutMs = 15000 } = {}) => {
  chain = chain.catch(() => null).then(() => new Promise((resolve) => {
    const worker = readyTab();
    if (!worker || !futbinUrl(url)) return resolve(null);
    const id = nonce();
    const expiresAt = Date.now() + Math.min(timeoutMs, REQUEST_TTL);
    let done = false;
    let sent = false;
    let unwatch = () => {};
    let poll;
    let timer;
    const finish = (response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      unwatch();
      if ((read(REQUEST) || {}).id === id) write(REQUEST, null);
      if ((read(RESPONSE) || {}).id === id) write(RESPONSE, null);
      resolve(response);
    };
    const receive = () => {
      const response = read(RESPONSE);
      if (response && response.id === id && response.worker === worker.id) {
        finish({ status: Number(response.status) || 0, text: String(response.text || "") });
      }
    };
    const send = () => {
      const pending = read(REQUEST);
      if (sent || (pending && pending.expiresAt > Date.now())) return;
      sent = true;
      if (!write(REQUEST, { id, worker: worker.id, url, json, expiresAt })) finish(null);
    };
    unwatch = watch(RESPONSE, receive);
    poll = setInterval(() => { receive(); send(); }, 500);
    timer = setTimeout(() => finish(null), Math.max(0, expiresAt - Date.now()));
    send();
    receive();
  }));
  return chain;
};
