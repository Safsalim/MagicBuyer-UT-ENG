// Local, synthetic EA providers for responsive UI verification. No trading service.
import { setPageForTests } from "../app/core/page";
import { addFilter } from "../app/core/filters";
import { openPanel, ensurePanel } from "../app/ui/panel";

const entry = (id, value, label) => ({ id, value, label });
const dp = {
  getStaffTypeDP: () => [entry(-1, "any", "All"), entry(0, "manager", "Managers")],
  getConsumableTypeDP: () => [entry(3, "playStyle", "Chemistry styles"), entry(4, "managerLeague", "Manager leagues"), entry(7, "healing", "Healing")],
  getClubVanityTypesDP: () => [entry(1, "kit", "Kits"), entry(2, "badge", "Badges"), entry(3, "ball", "Balls")],
  getStadiumVanityTypesDP: () => [entry(4, "stadium", "Stadiums"), entry(5, "theme", "Stadium theme")],
  getItemLevelDP: () => [entry(-1, "any", "All"), entry(0, "bronze", "Bronze"), entry(1, "silver", "Silver"), entry(2, "gold", "Gold")],
  getNationDP: () => [entry(-1, "-1", "All nations"), entry(18, "18", "France"), entry(52, "52", "Argentina")],
  getLeagueDP: () => [entry(-1, "-1", "All leagues"), entry(13, "13", "Premier League")],
  getTeamDP: () => [entry(-1, "-1", "All clubs"), entry(1, "1", "Arsenal")],
  getItemRarityDP: () => [entry(-1, -1, "All rarities"), entry(0, 0, "Common"), entry(1, 1, "Rare")],
  getVanityColorDP: () => [entry(-1, "any", "All colors"), entry(1, "RED", "Red")],
  getVanityAuthenticityDP: () => [entry(-1, "any", "All"), entry(1, "authentic", "Authentic"), entry(0, "inauthentic", "Custom")],
  getPlayStyleDP: () => [entry(-1, "-1", "All styles"), entry(250, "250", "Anchor"), entry(251, "251", "Hunter")],
};
const observable = (response) => ({ observe(scope, fn) { setTimeout(() => fn(this, response), 0); }, unobserve() {} });
const bidOnlyPreview = new URLSearchParams(window.location.search).has("bid-only");
const samplePlayers = [9001, 16786217].map((definitionId, index) => ({ id: 10 + index, definitionId, type: "player", rating: 81 + index,
  rareflag: index ? 3 : 1, getSearchType: () => "player", isPlayer: () => true,
  getStaticData: () => ({ name: index ? "Sample player · special version" : "Sample player · gold version" }),
  isGoldRating: () => true, isBronzeRating: () => false, isSilverRating: () => false, isSpecial: () => index > 0,
  getAuctionData: () => ({ tradeId: `sample-player-${index}`, expires: 45 + index * 60, buyNowPrice: 2000, startingBid: 150, currentBid: 500 }),
}));
const sampleItem = { id: 1, definitionId: 9001, type: "manager", subtype: 0, nationId: 18, leagueId: 13, rating: 80, amount: 0,
  tradable: true, getSearchType: () => "staff", getStaticData: () => ({ name: "Sample manager" }),
  isGoldRating: () => true, isBronzeRating: () => false, isSilverRating: () => false,
  getAuctionData: () => ({ tradeId: "sample", expires: 1000, buyNowPrice: 1000 }),
};
const fixturePage = {
  SearchType: { PLAYER: "player", STAFF: "staff", CLUB_INFO: "clubInfo", STADIUM: "stadium", BALL: "ball", VANITY: "vanity", CONSUMABLES_TRAINING: "training", CONSUMABLES_DEVELOPMENT: "development" },
  SearchCategory: { ANY: "any", MANAGER: "manager", KIT: "kit", BADGE: "badge", BALL: "ball", STADIUM: "stadium", PLAYSTYLE: "playStyle", MANAGER_LEAGUE: "managerLeague", HEALING: "healing" },
  ItemType: { MANAGER: "manager" }, factories: { DataProvider: dp },
  UTSearchCriteriaDTO: function () { Object.assign(this, { rarities: [], defId: [], category: "any", count: 21 }); },
  services: { User: { getUser: () => ({ coins: { amount: 10000 } }) }, Item: {
    clearTransferMarketCache() {}, searchTransferMarket: (criteria) => observable({ success: true, data: { items: bidOnlyPreview ?
      samplePlayers.filter((item) => !criteria.defId.length || criteria.defId.includes(item.definitionId)) : [sampleItem] } }),
    requestTransferItems: () => observable({ success: true, response: { items: [] } }),
    bid() { throw new Error("Trading is disabled in this synthetic fixture"); },
    list() { throw new Error("Trading is disabled in this synthetic fixture"); },
  } },
};
const delayedProviders = new URLSearchParams(window.location.search).has("late-providers");
// Exercise the real quote/parser/UI flow using fixture prices, without external requests.
if (new URLSearchParams(window.location.search).has("chemistry-quotes")) {
  window.GM_xmlhttpRequest = (options) => {
    const html = '<h1>EA FC 27 Chemistry Styles</h1><table class="consumables-table"><tr class="consumableRow" data-name="Hunter" data-price-ps="2000" data-price-pc="3400"></tr><tr class="consumableRow" data-name="Anchor" data-price-ps="1000" data-price-pc="1500"></tr></table>';
    setTimeout(() => options.onload({ status: options.url === "https://www.futbin.com/consumables" ? 200 : 404, responseText: html }), 0);
  };
}
setPageForTests(delayedProviders ? {} : fixturePage);
if (bidOnlyPreview) {
  addFilter({ name: "Sample player · bid 700", itemGroup: "players", player: { id: 9001, name: "Sample player", rating: 81 },
    tradeMode: "bidOnly", maxBuy: 2000, maxBid: 700, bidExpiresWithin: "90S", sellMode: "fixed", sellPrice: 900 });
} else if (new URLSearchParams(window.location.search).has("player-ratings")) {
  addFilter({ name: "81 rated below 700", itemGroup: "players", level: "gold", minRating: 81, maxRating: 81,
    maxBuy: 700, buyBelow: true, sellMode: "fixed", sellPrice: 900 });
} else {
  addFilter({ name: "Manager target", itemGroup: "managers", type: "staff", category: "manager", maxBuy: 1000, sellMode: "fixed", sellPrice: 2000 });
}
openPanel();
if (delayedProviders) setTimeout(() => { setPageForTests(fixturePage); ensurePanel(); }, 1500);
