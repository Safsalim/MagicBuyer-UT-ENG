const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const babel = require("babel-core");

// Two isolated userscript contexts sharing only Violentmonkey-style private storage.
function browser() {
  const values = new Map();
  const listeners = new Map();
  const timers = new Set();
  let nextListener = 0;
  const setValue = (key, value) => {
    values.set(key, structuredClone(value));
    for (const entry of listeners.values()) {
      if (entry.key === key) queueMicrotask(() => entry.callback(key, null, value, true));
    }
  };
  const tab = (url, overrides = {}) => {
    const location = new URL(url);
    const events = {};
    const window = { addEventListener: (name, callback) => { events[name] = callback; } };
    window.top = window;
    const context = vm.createContext({
      window, location, URL, crypto: webcrypto, Uint32Array, AbortController, console,
      GM_getValue: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
      GM_setValue: setValue,
      GM_addValueChangeListener: (key, callback) => {
        const id = ++nextListener;
        listeners.set(id, { key, callback });
        return id;
      },
      GM_removeValueChangeListener: (id) => listeners.delete(id),
      setTimeout: (callback, ms) => { const id = setTimeout(callback, ms); timers.add(id); return id; },
      setInterval: (callback, ms) => { const id = setInterval(callback, ms); timers.add(id); return id; },
      clearTimeout, clearInterval, ...overrides,
    });
    const modules = new Map();
    function load(path, dependencies = {}) {
      path = resolve(__dirname, "..", path);
      if (modules.has(path)) return modules.get(path);
      const module = { exports: {} };
      modules.set(path, module.exports);
      const code = babel.transform(readFileSync(path, "utf8"), {
        presets: [require.resolve("babel-preset-es2015")], babelrc: false,
      }).code;
      vm.runInContext(`(function (exports, require, module) { ${code}\n })`, context)(
        module.exports, (name) => {
          if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
          throw new Error(`Unexpected import ${name} in ${path}`);
        }, module,
      );
      return module.exports;
    }
    const bridge = () => load("app/ui/futbinTabBridge.js");
    const parse = () => load("app/prices/futbinParse.js");
    const client = (bridgeMock, iframe = () => null) => load("app/prices/futbinClient.js", {
      "../app.constants": { getFutShortYear: () => "27" },
      "../core/settings": { getSettings: () => ({ prices: { iframeFallback: true } }) },
      "../services/externalRequest": { sendExternalRequest: (options) => context.GM_xmlhttpRequest(options) },
      "../ui/futbinBridge": { fetchViaIframe: iframe },
      "../ui/futbinTabBridge": bridgeMock || bridge(),
      "./futbinParse": parse(),
    });
    return { context, events, load, bridge, parse, client };
  };
  const close = () => { for (const id of timers) { clearTimeout(id); clearInterval(id); } };
  return { tab, values, listeners, setValue, close };
}

test("normal Cloudflare JavaScript does not imply a verification challenge", () => {
  const env = browser();
  try {
    const parse = env.tab("https://www.ea.com/").parse();
    assert.equal(parse.looksBlocked('<title>FUTBIN</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'), false);
    assert.equal(parse.looksLikeVerification('<title>Just a moment...</title><form id="challenge-form"></form>'), true);
    assert.equal(parse.looksBlocked('<title>Just a moment...</title><script>const css="price-box"</script>'), true);
  } finally { env.close(); }
});

for (const [status, text, expectedVerification, wording] of [
  [403, "Forbidden", false, "denied"],
  [429, "Too many requests", false, "rate limiting"],
  [503, "Service unavailable", false, "temporarily unavailable"],
  [403, '<title>Just a moment...</title>', true, "verification page"],
  [0, "", false, "network error"],
]) {
  test(`preserves HTTP ${status} and reports its actual cause`, async () => {
    const env = browser();
    try {
      let frames = 0;
      const tab = env.tab("https://www.ea.com/", {
        GM_xmlhttpRequest: (options) => options.onload({ status, responseText: text }),
      });
      const client = tab.client(undefined, async () => { frames += 1; return null; });
      const result = await client.fetchFutbinText("https://www.futbin.com/players/search?query=231747");
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(result.verification, expectedVerification);
      const errors = tab.load("app/prices/futbinErrors.js");
      assert.match(errors.futbinErrorMessage(result), new RegExp(wording));
      if (status === 429 || status === 503) assert.equal(frames, 0);
      const paused = await client.fetchFutbinText("https://www.futbin.com/players/search", { allowIframe: false });
      assert.equal(paused.status, status, "a paused request retains the original status");
      assert.equal(paused.verification, expectedVerification);
    } finally { env.close(); }
  });
}

test("an open FUTBIN tab resolves the search when extension requests get 403", async () => {
  const env = browser();
  try {
    const requests = [];
    const data = JSON.stringify([{
      id: 123, name: "Mbappé", ratingSquare: { rating: 91 },
      location: { url: "/27/player/123/kylian-mbappe" },
      playerImage: { fixed: { url: { image1x: "https://cdn.futbin.com/players/231747.png" } } },
    }]);
    const futbin = env.tab("https://futbin.com/", {
      fetch: async (url, options) => { requests.push({ url, options }); return { status: 200, text: async () => data }; },
    });
    futbin.bridge().bootFutbinTabBridge();
    const ea = env.tab("https://www.ea.com/", {
      GM_xmlhttpRequest: (options) => options.onload({ status: 403, responseText: "Forbidden" }),
    });
    const result = await ea.client().resolveFutbinLink({ definitionId: 231747, name: "Mbappé" }, { forceDirect: true });
    assert.equal(result.ok, true);
    assert.equal(result.link.futbinId, 123);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/futbin\.com\/players\/search\?/);
    assert.equal(requests[0].options.credentials, "same-origin");
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(env.values.get("mb5.futbinTab.request"), null);
    assert.equal(env.values.get("mb5.futbinTab.response"), null);
  } finally { env.close(); }
});

test("tab requests are serialized and stale responses cannot complete a request", async () => {
  const env = browser();
  try {
    let active = 0;
    let peak = 0;
    const futbin = env.tab("https://www.futbin.com/", {
      fetch: async (url) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { status: 200, text: async () => url };
      },
    });
    futbin.bridge().bootFutbinTabBridge();
    env.setValue("mb5.futbinTab.response", { id: "stale", status: 200, text: "wrong" });
    const bridge = env.tab("https://www.ea.com/").bridge();
    const results = await Promise.all([
      bridge.fetchViaFutbinTab("https://www.futbin.com/27/player/1/one"),
      bridge.fetchViaFutbinTab("https://www.futbin.com/27/player/2/two"),
    ]);
    assert.equal(peak, 1);
    assert.match(results[0].text, /\/one$/);
    assert.match(results[1].text, /\/two$/);
  } finally { env.close(); }
});

test("the requester and worker refuse unrelated or unsafe URLs", async () => {
  const env = browser();
  try {
    let calls = 0;
    const futbin = env.tab("https://www.futbin.com/", { fetch: async () => { calls += 1; } });
    futbin.bridge().bootFutbinTabBridge();
    const bridge = env.tab("https://www.ea.com/").bridge();
    for (const url of ["https://evil.example/", "https://futbin.com.evil.example/", "http://www.futbin.com/", "https://user:pass@www.futbin.com/", "https://www.futbin.com:8443/"]) {
      assert.equal(await bridge.fetchViaFutbinTab(url), null);
      env.setValue("mb5.futbinTab.request", {
        id: url, worker: env.values.get("mb5.futbinTab.ready").id, url, expiresAt: Date.now() + 10000,
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(calls, 0);
  } finally { env.close(); }
});

test("timeouts clean up private storage and listeners", async () => {
  const env = browser();
  try {
    env.setValue("mb5.futbinTab.ready", { id: "sleeping-tab", seenAt: Date.now() });
    const bridge = env.tab("https://www.ea.com/").bridge();
    assert.equal(await bridge.fetchViaFutbinTab("https://www.futbin.com/players/search", { timeoutMs: 20 }), null);
    assert.equal(env.values.get("mb5.futbinTab.request"), null);
    assert.equal(env.listeners.size, 0);
    env.setValue("mb5.futbinTab.ready", { id: "stale-tab", seenAt: Date.now() - 90001 });
    assert.equal(bridge.futbinTabAvailable(), false);
  } finally { env.close(); }
});

test("only a normal FUTBIN tab advertises the helper", () => {
  const env = browser();
  try {
    const ea = env.tab("https://www.ea.com/");
    ea.bridge().bootFutbinTabBridge();
    const framed = env.tab("https://www.futbin.com/");
    framed.context.window.top = {};
    framed.bridge().bootFutbinTabBridge();
    const unrelated = env.tab("https://fake.futbin.com/");
    unrelated.bridge().bootFutbinTabBridge();
    assert.equal(env.values.has("mb5.futbinTab.ready"), false);
    const top = env.tab("https://www.futbin.com/");
    top.bridge().bootFutbinTabBridge();
    assert.equal(ea.bridge().futbinTabAvailable(), true);
    top.events.pagehide();
    assert.equal(ea.bridge().futbinTabAvailable(), false);
    top.bridge().bootFutbinTabBridge();
    assert.equal(ea.bridge().futbinTabAvailable(), true, "helper restarts after a cached page is restored");
  } finally { env.close(); }
});
