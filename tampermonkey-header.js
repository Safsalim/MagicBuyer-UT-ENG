module.exports = {
  headers: {
    name: "MagicBuyer-UT",
    namespace: "http://tampermonkey.net/",
    version: "5.1.2",
    description: "Sniper / autobuyer for the EA FC 27 Ultimate Team web app",
    author: "AMINE1921",
    match: [
      "https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app*",
      "https://www.ea.com/ea-sports-fc/ultimate-team/web-app*",
      "https://www.futbin.com/*",
      "https://futbin.com/*",
    ],
    "run-at": "document-start",
    sandbox: "JavaScript",
    // Violentmonkey can use its content context if FUTBIN's CSP blocks page injection.
    "inject-into": "auto",
    grant: ["GM_xmlhttpRequest", "GM_getValue", "GM_setValue", "GM_addValueChangeListener", "GM_removeValueChangeListener", "unsafeWindow"],
    connect: [
      "ea.com",
      "futbin.com",
      "www.futbin.com",
      "discord.com",
      "discordapp.com",
      "api.telegram.org",
    ],
    updateURL:
      "https://github.com/AMINE1921/MagicBuyer-UT/releases/latest/download/fut-auto-buyer.user.js",
    downloadURL:
      "https://github.com/AMINE1921/MagicBuyer-UT/releases/latest/download/fut-auto-buyer.user.js",
  },
};
