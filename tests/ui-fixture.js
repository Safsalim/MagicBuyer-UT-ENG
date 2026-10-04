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
    clearTransferMarketCache() {}, searchTransferMarket: () => observable({ success: true, data: { items: [sampleItem] } }),
    requestTransferItems: () => observable({ success: true, response: { items: [] } }),
    bid() { throw new Error("Trading is disabled in this synthetic fixture"); },
    list() { throw new Error("Trading is disabled in this synthetic fixture"); },
  } },
};
const delayedProviders = new URLSearchParams(window.location.search).has("late-providers");
setPageForTests(delayedProviders ? {} : fixturePage);
addFilter({ name: "Manager target", itemGroup: "managers", type: "staff", category: "manager", maxBuy: 1000, sellMode: "fixed", sellPrice: 2000 });
openPanel();
if (delayedProviders) setTimeout(() => { setPageForTests(fixturePage); ensurePanel(); }, 1500);
