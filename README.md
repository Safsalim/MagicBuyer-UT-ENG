# MagicBuyer-UT — sniper for the EA FC 27 web app

A Tampermonkey script that adds a sniper / autobuyer to the **EA SPORTS FC 27 Ultimate Team** web app:
continuous transfer market searches, instant purchases below your maximum price (fixed or a percentage
of the live FUTBIN price), automatic listing at FUTBIN prices, FUTBIN prices on every card, importing
FUTBIN SBC solutions and buying missing players, and configurable pauses and stopping conditions.

> ⚠️ **Read before using.** Automating the web app violates EA's terms of service.
> EA may restrict transfer market access (soft ban), require captchas, or ban your account.
> Use this script at your own risk; the authors are not responsible for sanctions against your account.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome, Edge, or Brave.
   On recent Chrome versions, enable **“Allow user scripts”** in Tampermonkey's extension details.
2. Open `fut-auto-buyer.user.js` from the [latest release](https://github.com/AMINE1921/MagicBuyer-UT/releases/latest) and click **Install**.
3. Open the [FC 27 web app](https://www.ea.com/ea-sports-fc/ultimate-team/web-app/) and log in.

Your account must have transfer market access unlocked.

## Quick start

1. Click the **MagicBuyer** tab (EA navigation bar) or the **MB** badge in the bottom-right corner.
2. In the **Target** tab, enter the player's name and select them from the list.
3. Enter the **Max buy price** (Buy Now) and, if you want to resell, the **Sell price**
   (the panel shows the net proceeds after EA's 5% tax and the profit per card).
4. Click **Test search (without buying)** to see the market results (green shows what the bot would buy).
5. Click **▶ Start**. You can close the panel: the badge displays the status, searches, and purchases.

Alternatively, configure your search in EA's **Transfers → Transfer Market** (rarity, position, play style…)
and click **⚡ Snipe this search** to create a filter with exactly those criteria.

## FUTBIN prices

All pricing features use **FUTBIN** (pages fetched as in your browser, using the console or PC platform
for your account). In the **FUTBIN** tab, click **Test FUTBIN** to check access.

- **Buy at a percentage of FUTBIN price** (Target tab → Buy price → Mode): for example, 90%; the max buy
  price is recalculated on every price update. A fixed price can serve as an absolute cap.
  Without a recent FUTBIN price (less than 5 minutes old), the filter waits: never buy using an outdated price.
- **Sell at a percentage of FUTBIN price** (Sell tab, or per filter): the purchased version's price is refreshed
  immediately after buying. Without a FUTBIN price, the card goes to the transfer list without being listed.
- **Relist at FUTBIN prices** and the **List at FUTBIN prices** button (Transfers tab) for available and unsold cards.
- **Price badge** at the top of every player card (club, market, transfers, squads, SBCs); click to open its FUTBIN page.
- **EA's listing panel**: the card's FUTBIN price and a **Fill in** button (confirm with EA's button).

Smart refresh: bot targets and SBC purchases refresh every 60–120 seconds, displayed cards approximately
every 2 minutes (less often if the price stays the same). FUTBIN requests run one at a time, spaced out,
with automatic throttling if FUTBIN blocks them. An abnormal price jump is checked a second time before use.
FUTBIN does not push prices: they are fetched regularly while the card is being tracked.

If FUTBIN opens normally but **Test FUTBIN** fails, the site may be rejecting the userscript's request
while accepting your normal browser session. Install the updated `dist/fut-auto-buyer.user.js` in
Violentmonkey or Tampermonkey, reload the EA web app and FUTBIN, and keep a FUTBIN tab open in the
same browser profile with MagicBuyer enabled on both sites. The **FUTBIN tab** status should say
**connected**; test again to fetch through that tab. Complete verification only if FUTBIN shows it.
If the status stays disconnected, check that the extension has site access to FUTBIN and that Chrome
allows user scripts. A sleeping/discarded tab must be reloaded before it can help.

The optional “hidden FUTBIN page” fallback uses an invisible iframe, which FUTBIN or the browser may
block. A 403 access denial is reported separately from verification, a 429 rate limit, and a 503 outage.

## SBCs: FUTBIN solutions

1. Open a challenge squad (the pitch screen) and click **⚡ FUTBIN Solution** at the top of the screen.
2. Paste the FUTBIN solution link (squad page), then click **Load** to see the formation, 11 players,
   those in your club (and SBC storage, excluding loans and prioritizing untradeables), and those
   **to buy** with their FUTBIN prices.
3. **Place in squad** applies the formation and places players in positions they can play.
4. Check or adjust each missing player's **max price** (FUTBIN price + configurable margin), then click
   **Buy missing players**: exact version search, cheapest first, purchase, send to club, and place in the challenge.

The challenge is never submitted automatically: you click **Submit** yourself. Captchas, expired sessions,
and EA rate limits stop purchasing immediately; the **Stop** button interrupts it at any time.

## How the sniper avoids missing deals

- **Fresh results on every search**: the web app cache is cleared and each request is different
  (automatic cache busting varies the max bid *above* your max buy price, so no purchasable listing is excluded).
- **Instant purchase** as soon as EA responds, without waiting for FUTBIN or any other request.
- **Cheapest first**, then most recent at equal prices; your own listings are ignored.
- **Reselling after purchases**, never during them: the next search is not delayed.
- **Keep tab active in the background**: Chrome throttles hidden tabs; the “Keep tab active” option prevents this
  (a speaker icon appears on the tab, but no sound is played).

## Settings

| Tab | Settings |
| --- | --- |
| **Target** | Saved filters, filter rotation, player, quality, position, min/max rating, buy price (fixed or live FUTBIN percentage, cap), sell price (Sell tab, fixed or FUTBIN percentage), max bid, advanced IDs (exact version, rarity, nation, league, club, style). |
| **Buy** | Max purchases per search, stop after N purchases, coin reserve, result threshold, skip goalkeepers, bidding (expiry window, rebidding, max active bids). |
| **Sell** | Automatic listing / send to transfer list / leave unassigned, fixed price or FUTBIN percentage, duration, minimum profit. |
| **Timing** | Cautious / Normal / Fast profiles, search delay, max searches per minute, pause every N searches, pause duration, automatic stop, delay after buying, cache busting, pages to search, safety pause on EA rate limits. |
| **Transfers** | List status, relist unsold cards (same price or FUTBIN price), bulk listing at FUTBIN prices, clear sold cards, stop if the list is full. |
| **FUTBIN** | Access test, price platform, refresh frequency, price jump guard, card badges, SBC purchasing settings. |
| **Alerts** | Sounds, browser notifications, Discord webhook, Telegram bot, and event selection. |

Accepted duration formats: `5-9` (seconds), `4.5-7`, `40-80S`, `5M`, `1-2H`, `1D`.
All values are saved automatically in Tampermonkey storage.

### Timing profiles

| Profile | Between searches | Max / minute | Pause | Automatic stop |
| --- | --- | --- | --- | --- |
| Cautious | 8–14 seconds | 6 | 60–120 seconds every 12–18 searches | 1–2 hours |
| Normal (default) | 5–9 seconds | 10 | 40–80 seconds every 15–25 searches | 2–3 hours |
| Fast | 3–5 seconds | 15 | 30–60 seconds every 20–30 searches | 1–1.5 hours |

Faster searches cause EA to trigger captchas and rate limits more frequently.

### Safety

- **Captcha (458)**, **expired session (401)**, **locked market (494)**, **blocked account**: stop immediately and notify.
- **Too many requests (429) / temporary block (512, 521)**: safety pause (4–8 minutes by default), stop if repeated.
- **3 consecutive failed searches**: stop.
- Custom error codes: Timing tab → EA errors.

The script never solves captchas: solve them yourself in the web app, then restart.

## Build from source

```bash
npm install
npm run build:prod
```

The script is generated at `dist/fut-auto-buyer.user.js` (Tampermonkey header in `tampermonkey-header.js`).

## What's new in 5.1.1

- SBCs: fixed FUTBIN solution parsing (the squad is read from page data rather than the rendered display):
  formation, each player's exact FUTBIN position, locked challenge positions respected, page prices used immediately.

## What's new in 5.1.0

- Buy at a per-filter percentage of the FUTBIN price, tracked live while the bot runs (optional cap).
- Sell and relist at a percentage of the FUTBIN price.
- FUTBIN price badge on every player card and a **Fill in** button in EA's listing panel.
- SBCs: import FUTBIN solutions (formation + club players), buy missing players at an editable FUTBIN price.
- New FUTBIN tab (access test, smart refresh, card badges, SBCs).
- FUTWIZ removed: FUTBIN is the sole price source. Old “reference price” settings are converted automatically.

## What's new in 5.0.0

Complete engine and interface rewrite for FC 27:

- Snipe engine rewritten around the real FC 27 web app APIs (`UTSearchCriteriaDTO`, `services.Item`), without URL rewriting or fragile hooks.
- Fixed the bot getting stuck after the first purchase, missing captcha stops, FUTBIN prices replacing max prices,
  cache busting disabled for targeted players, settings never saved, and the CPU-heavy render loop.
- New side panel (the web app remains usable), floating badge, filterable log, CSV export, search test without buying,
  EA search import, multi-filter rotation, timing profiles, bidding, and Discord/Telegram notifications.
