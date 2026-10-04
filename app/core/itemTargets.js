import { pageGlobal, services, repositories } from "./page";

export const GROUP_LABELS = { players: "Players", managers: "Managers", club: "Club items", consumables: "Consumables" };
const eq = (a, b) => a != null && b != null && String(a) === String(b);
export const callBool = (target, method) => {
  try { return !!(target && typeof target[method] === "function" && target[method]()); } catch (e) { return false; }
};
export const groupForType = (type) => {
  const t = pageGlobal("SearchType") || {};
  if (eq(type, t.PLAYER) || type === "player") return "players";
  if (eq(type, t.STAFF)) return "managers";
  if ([t.CONSUMABLES, t.CONSUMABLES_TRAINING, t.CONSUMABLES_DEVELOPMENT].some((v) => eq(type, v))) return "consumables";
  if ([t.CLUB_INFO, t.STADIUM, t.BALL, t.VANITY].some((v) => eq(type, v))) return "club";
  return "unsupported";
};
export const groupOfItem = (item) => {
  try {
    if (typeof item.getSearchType === "function") return groupForType(item.getSearchType());
  } catch (e) {}
  if (callBool(item, "isPlayer")) return "players";
  const types = pageGlobal("ItemType") || {};
  if (eq(item && item.type, types.MANAGER)) return "managers";
  if ([types.HEALTH, types.TRAINING].some((v) => eq(item && item.type, v))) return "consumables";
  if ([types.BADGE, types.KIT, types.BALL, types.STADIUM, types.VANITY].some((v) => eq(item && item.type, v))) return "club";
  return "unsupported";
};

export const providerEntries = (method, ...args) => {
  try {
    const Factory = pageGlobal("UTDataProviderFactory");
    const repo = repositories() || {};
    const svc = services() || {};
    const factories = pageGlobal("factories");
    const factory = factories && factories.DataProvider || (typeof Factory === "function" ? new Factory(svc.Localization, repo.Squad, repo.TeamConfig) : null);
    const values = factory && typeof factory[method] === "function" ? factory[method](...args) : [];
    return Array.from(values || []).filter((v) => v && v.value != null && v.label != null);
  } catch (e) { return []; }
};
export const categoryChoices = (group) => {
  const t = pageGlobal("SearchType") || {};
  const c = pageGlobal("SearchCategory") || {};
  const out = [];
  const add = (entries, typeFor) => entries.forEach((entry) => {
    const type = typeFor(entry);
    if (type != null && entry.value !== c.ANY && entry.value !== "any" && !out.some((v) => eq(v.category, entry.value))) {
      out.push({ category: entry.value, type, label: entry.label, subtype: entry.id });
    }
  });
  if (group === "managers") add(providerEntries("getStaffTypeDP"), () => t.STAFF);
  if (group === "consumables") add(providerEntries("getConsumableTypeDP"), (v) =>
    eq(v.value, c.HEALING) ? t.CONSUMABLES_DEVELOPMENT : t.CONSUMABLES_TRAINING);
  if (group === "club") {
    ["getClubVanityTypesDP", "getStadiumVanityTypesDP", "getCosmeticsVanityTypesDP", "getPitchVanityTypesDP", "getStandsVanityTypesDP", "getTrophiesVanityTypesDP"].forEach((method) =>
      add(providerEntries(method), (v) => eq(v.value, c.KIT) || eq(v.value, c.BADGE) ? t.CLUB_INFO :
        eq(v.value, c.BALL) ? t.BALL : eq(v.value, c.STADIUM) ? t.STADIUM : t.VANITY));
  }
  return out;
};
export const availableGroups = () => Object.keys(GROUP_LABELS).filter((group) => group === "players" || categoryChoices(group).length);

export const targetIdentity = (item) => {
  const group = groupOfItem(item);
  let type = null;
  try { type = item.getSearchType(); } catch (e) {}
  const data = (item && typeof item.getStaticData === "function" && item.getStaticData()) || item._staticData || {};
  const style = callBool(item, "isStyleModifier");
  const styleChoice = style ? providerEntries("getPlayStyleDP").find((v) => eq(v.id, item.subtype)) : null;
  const itemName = styleChoice ? styleChoice.label : "";
  return {
    group, type, definitionId: Number(item.definitionId) || 0,
    itemType: item.type, subtype: item.subtype,
    amount: Number(item.amount) || 0,
    name: String(itemName || data.name || data.knownAs || data.lastName || "Item"),
    nation: Number(item.nationId) || -1, league: Number(item.leagueId) || -1,
    level: callBool(item, "isBronzeRating") ? "bronze" : callBool(item, "isSilverRating") ? "silver" : callBool(item, "isGoldRating") ? "gold" : "any",
    rarity: item.rareflag,
  };
};
export const hasExactTarget = (filter) => !!(filter && (filter.definitionId || (filter.selectedItem && filter.selectedItem.definitionId) ||
  (filter.itemGroup === "players" && filter.player && filter.player.id)));

// A native chemistry-style choice identifies the consumable without a market result.
export const chemistryStyleTarget = (filter) => {
  const c = pageGlobal("SearchCategory") || {};
  if (!filter || filter.itemGroup !== "consumables" || !eq(filter.category, c.PLAYSTYLE) ||
    !categoryChoices("consumables").some((v) => eq(v.category, filter.category) && eq(v.type, filter.type))) return null;
  const selected = filter.selectedItem;
  const subtype = filter.playStyle > 0 ? filter.playStyle : selected && selected.subtype;
  if (!(subtype > 0) || selected && !eq(selected.subtype, subtype)) return null;
  return providerEntries("getPlayStyleDP").find((v) => eq(v.id, subtype) && eq(v.value, subtype)) || null;
};
export const hasReferenceTarget = (filter) => hasExactTarget(filter) || !!chemistryStyleTarget(filter);

// Changing category must never carry an exact item or pricing reference with it.
export const switchGroupPatch = (group) => {
  const choice = categoryChoices(group)[0];
  return { itemGroup: group, type: group === "players" ? (pageGlobal("SearchType") || {}).PLAYER || "player" : choice ? choice.type : null,
    category: choice ? choice.category : "any", selectedItem: null, player: null, definitionId: 0,
    level: "any", rarities: [], nation: -1, league: -1, club: -1, playStyle: -1,
    position: "any", zone: -1, minRating: 0, maxRating: 0, authenticity: "any", primaryColor: -1, secondaryColor: -1,
    futbinPercent: group === "players" ? 90 : 80, sellPercent: group === "players" ? "" : "95", priceMode: "fixed" };
};

export const matchesItem = (item, filter, { fromSearch = false } = {}) => {
  if (!item || !filter || groupOfItem(item) !== filter.itemGroup) return false;
  let type;
  try { type = item.getSearchType(); } catch (e) {}
  if (filter.itemGroup !== "players" && !eq(type, filter.type)) return false;
  const selected = filter.selectedItem;
  const exact = filter.definitionId || (selected && selected.definitionId);
  if (exact && Number(item.definitionId) !== Number(exact)) return false;
  if (selected && (!eq(item.type, selected.itemType) || !eq(item.subtype, selected.subtype))) return false;
  if (selected && selected.amount != null && Number(item.amount || 0) !== Number(selected.amount)) return false;
  if (filter.player && (Number(item.definitionId) & 0xffffff) !== filter.player.id) return false;
  const choices = categoryChoices(filter.itemGroup);
  const category = choices.find((v) => eq(v.category, filter.category));
  if (filter.itemGroup !== "players" && filter.category !== "any") {
    if (!category) return false;
    if (filter.itemGroup === "club" && !eq(item.subtype, category.subtype)) return false;
    const c = pageGlobal("SearchCategory") || {};
    if (eq(filter.category, c.PLAYSTYLE) && !callBool(item, "isStyleModifier")) return false;
    if (eq(filter.category, c.MANAGER_LEAGUE) && !callBool(item, "isManagerLeagueModifier")) return false;
    if (eq(filter.category, c.HEALING) && !callBool(item, "isInjuryHealing")) return false;
  }
  for (const [key, property] of [["nation", "nationId"], ["league", "leagueId"], ["club", "teamId"], ["primaryColor", "primaryColor"], ["secondaryColor", "secondaryColor"]]) {
    if (filter[key] > 0 && !eq(item[property], filter[key])) {
      // EA does not expose colors on every owned entity. Native search is authoritative
      // for these fields; bulk selling requires observable matching metadata.
      if (!(fromSearch && ["primaryColor", "secondaryColor"].includes(key) && item[property] == null)) return false;
    }
  }
  if (filter.rarities.length && !filter.rarities.some((v) => eq(v, item.rareflag))) return false;
  if (filter.level !== "any") {
    const method = { bronze: "isBronzeRating", silver: "isSilverRating", gold: "isGoldRating", SP: "isSpecial" }[filter.level];
    if (!method || !callBool(item, method)) return false;
  }
  if (filter.playStyle > 0 && !eq(filter.itemGroup === "consumables" ? item.subtype : item.playStyle, filter.playStyle)) return false;
  if (filter.authenticity !== "any" && !!item.authenticity !== (filter.authenticity === "authentic")) return false;
  if (filter.itemGroup === "players") {
    const rating = Number(item.rating) || 0;
    if ((filter.minRating && rating < filter.minRating) || (filter.maxRating && rating > filter.maxRating)) return false;
    const positions = pageGlobal("PlayerPosition") || {};
    if (filter.position !== "any" && !eq(item.preferredPosition, positions[filter.position]) && !eq(item.preferredPosition, filter.position) && !eq(item.preferredPositionName, filter.position)) return false;
    if (filter.zone > 0) {
      const method = { 130: "prefersDefensePosition", 131: "prefersMidfieldPosition", 132: "prefersAttackerPosition" }[filter.zone];
      if (!callBool(item, method)) return false;
    }
  }
  return true;
};
