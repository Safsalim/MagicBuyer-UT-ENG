# Non-player trading in 5.2.0

## Target setup

Choose Players, Managers, Club items or Consumables in Target. The group and subtype choices come
from the loaded EA web app's native search enums and data providers. A group or criterion missing
from the running app is hidden; identifiers are not inferred from player searches.

Group changes clear incompatible criteria and the exact target. Non-player groups expose their
available quality, rarity, nation, league, club, authenticity, colors or chemistry-style controls.
Changing League clears Club; changing Quality clears Rarity. Position, rating and goalkeeper rules
apply only to players. Saved player filters retain their previous defaults.

Set a fixed Buy Now price and run **Test search (without buying)**. Click a matching result's name
to select its exact definition and native item identity. Imported EA searches preserve category,
definition and restrictive criteria; imports without identity metadata use EA for automatic pricing.
**Stop test** cancels queued discovery/search work. Changing the filter also cancels a running test
and invalidates its results, including late responses.

Broad targets need fixed buy and sell prices. Exact non-player targets can use percentage pricing:
the initial buy percentage is 80%, sell is 95%, and both remain editable. A fixed buy price caps the
percentage ceiling. A missing or stale reference produces no automatic Buy Now ceiling. Explicit
bidding caps continue to use the existing bid expiry, reserve and active-bid rules.

## Reference sources

| Target | First source | Fallback |
| --- | --- | --- |
| Selected manager with country/quality metadata and no league, club or rarity modifier | FUTBIN country/quality group | EA exact target |
| Selected chemistry style | FUTBIN chemistry-style row | EA exact target |
| Other selected managers, club items and consumables | EA exact target | No guessed price |
| Broad criterion/subtype | Fixed price | Automatic pricing unavailable |

FUTBIN manager references are grouped country/quality prices, rather than an individual manager's
valuation. The UI displays that source explicitly. The adapters read the public
[FC 27 manager table](https://www.futbin.com/27/manager-prices) and
[consumable table](https://www.futbin.com/consumables), require the matching edition and console/PC
column, and reject absent prices. Unsupported markup or access failure falls back to EA.

EA discovery searches only the exact target and its criteria. It finds the lowest native price tier
containing at least three distinct matching Buy Now auctions, excluding your own listings and expired
auctions. It paginates saturated results, sorts locally and requires two complete matching scans at
that ceiling to agree. The reference is their third-cheapest price. Discovery stops after 20 requests;
sparse, unstable, incomplete, cancelled or budget-exhausted results return unavailable.

References are keyed by edition, platform, group, native type/subtype, exact identity and criteria.
Buy references expire after five minutes. Resale and matching listing request references no older
than one minute. Concurrent requests share the same quote; unavailable quotes retry after one minute.
The cache is in memory and resets on page reload.

All EA requests share one queue. Reads obey configured search spacing, max requests per minute,
pauses, cancellation and EA cooldowns. Purchases take priority over queued reads and skip ordinary
search spacing. An already-running request must finish first; purchases still respect cooldowns and
fatal session/captcha/market errors. Public FUTBIN reads retain the existing separate transport.

## Selling and transfers

Purchase and bid jobs retain a deep snapshot of their target and sell settings. Changing the panel
after buying does not change a queued sale. Non-player resale refreshes the purchased identity's
reference before listing; an unavailable reference sends it to transfers without listing. EA price
tiers, native min/max limits, the 5% tax, minimum profit and transfer-list capacity remain enforced.

**Transfers → List matching items** previews only eligible available or expired tradable items
matching the active configured filter. Preview rows show reference source and proposed Buy Now price.
**List previewed items** refetches the transfer list, verifies identity and state, refreshes stale
references and checks limits again. It skips rows whose price changed instead of silently listing
at a different price. Sold, active, untradeable, unmatched or unpriceable items remain untouched.

Reference relisting applies enabled configured filters, in batches of at most five matching expired
items. Missing references leave items unchanged. The separate same-price relist option is retained.

Owned items sometimes lack color metadata even though native market search can filter by color.
Market results can rely on the native filtered response; transfer listing requires local proof and
skips an item when its restrictive metadata cannot be verified. If minimum profit is greater than
zero, existing transfer items whose purchase cost is unknown are skipped. Newly purchased jobs have
a known cost and use the normal after-tax profit check.

## Validation

`npm test` runs the existing FUTBIN transport tests and category, parser, discovery, request queue,
purchase, bid, resale, relist, bulk preview and UI state regressions. Fixtures are synthetic and never
send trading requests. The production userscript is rebuilt in `dist/fut-auto-buyer.user.js`.

The public EA scripts and FUTBIN markup were inspected for native/provider and table structure.
The actual panel was exercised locally using synthetic EA data providers at desktop and mobile
sizes. A signed-in Chrome/Violentmonkey EA session was unavailable in this environment. Live EA
search responses, actual quote discovery and extension installation remain unverified; no real
purchases, bids, listings or relists were performed.

For a read-only check in your signed-in browser:

1. Install the local rebuilt userscript and reload EA. Verify version 5.2.0 and existing player filters.
2. Choose each exposed non-player group. Check native subtype options and dependent criteria resets.
3. Run Test search with a fixed ceiling. Select a matching result and verify its exact ID and group.
4. Change a criterion during another test; the old results must clear. Test Stop test as well.
5. For an exact target, inspect the automatic reference source, identity, platform and age. A missing
   reference must leave the automatic ceiling unavailable. Keep the bot stopped during this check.
6. Preview matching transfer items and verify source, prices and skipped rows. Do not click the final
   listing action during read-only validation.
