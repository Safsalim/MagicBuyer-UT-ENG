const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
http.createServer((req, res) => {
  if (req.url === "/ui-fixture.js") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(fs.readFileSync(path.resolve(__dirname, "../.local-validation/ui-fixture.js")));
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MagicBuyer local UI fixture</title><body style="margin:0;background:#182233;color:#e9eef6;font:16px system-ui"><p style="padding:16px">Synthetic UI fixture · no live trading</p><script src="/ui-fixture.js"></script></body></html>');
  }
}).listen(4173, "127.0.0.1", () => console.log("UI fixture: http://127.0.0.1:4173"));
