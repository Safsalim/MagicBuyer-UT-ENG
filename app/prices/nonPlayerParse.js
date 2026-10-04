import { parseCoinsInput, maxPrice } from "../core/prices";

// Strict adapters for the current public tables. Unknown layouts are unavailable.
const attr = (tag, name) => {
  const match = String(tag).match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return match ? match[1] : "";
};
const text = (value) => String(value).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
const valid = (value) => value >= 150 && value <= maxPrice() ? value : 0;
const editionMatches = (html, edition) => {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return !!(heading && new RegExp(`\\b(?:FC|UT)\\s+${edition}\\b`, "i").test(text(heading[1])));
};
export const parseManagerTable = (html, { edition, platform, nation, level }) => {
  if (!["console", "pc"].includes(platform) || !editionMatches(html, edition)) return 0;
  const table = html.match(/<table\b[^>]*class=["'][^"']*manager-prices-table[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return 0;
  const headers = Array.from(table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)).slice(1);
  const levels = headers.map((h) => (h[1].match(/\/cards\/tiny\/\d+_(bronze|silver|gold)\.png/i) || [])[1]);
  if (levels.length !== 3 || levels.some((v) => !v)) return 0;
  const index = levels.indexOf(level);
  if (index < 0) return 0;
  for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const country = row[1].match(/\/nation\/(\d+)\.png/i);
    if (!country || Number(country[1]) !== Number(nation)) continue;
    const cells = Array.from(row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)).filter((cell) => {
      const classes = attr(cell[1], "class");
      return /\bmanager-price\b/.test(classes) && (/\bno-price\b/.test(classes) || classes.includes(platform === "pc" ? "platform-pc-only" : "platform-ps-only"));
    });
    if (cells.length !== 3) return 0;
    return valid(parseCoinsInput(text(cells[index][2])));
  }
  return 0;
};
export const parseChemistryTable = (html, { edition, platform, name }) => {
  if (!["console", "pc"].includes(platform) || !editionMatches(html, edition)) return 0;
  const table = html.match(/<table\b[^>]*class=["'][^"']*consumables-table[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return 0;
  const hits = Array.from(table[1].matchAll(/<tr\b([^>]*)>/gi)).filter((r) => attr(r[1], "data-name").toLowerCase() === String(name || "").trim().toLowerCase());
  return hits.length === 1 ? valid(Number(attr(hits[0][1], platform === "pc" ? "data-price-pc" : "data-price-ps"))) : 0;
};
