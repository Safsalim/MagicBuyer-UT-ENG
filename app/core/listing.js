import * as market from "./market";
import { floorPrice, priceAbove, priceBelow, roundPrice, startPriceFor, toInt } from "./prices";
import { parseRange, randomBetween } from "./ranges";

// Shared listing utilities (bot, FUTBIN relisting, bulk actions, quick listing).

const LIST_DURATIONS = [3600, 10800, 21600, 43200, 86400, 259200];

// EA duration closest to the entered value (1H, 3H, 1D…).
export const durationSeconds = (value) => {
  const range = parseRange(value, "H");
  const wanted = range ? range.min : 3600;
  return LIST_DURATIONS.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best));
};

// Percentage range (95-100, 98) limited to 10–150%.
export const percentRange = (value, fallback = 100) => {
  const range = parseRange(value, null) || { min: fallback, max: fallback };
  const clamp = (n) => Math.min(150, Math.max(10, n));
  return { min: clamp(range.min), max: clamp(range.max) };
};

// Sell price from FUTBIN: choose a percentage in the range and round to an EA price tier.
export const futbinSellPrice = (reference, percentValue) => {
  const range = percentRange(percentValue);
  const percent = randomBetween(range.min, range.max);
  return { price: roundPrice((toInt(reference) * percent) / 100), percent };
};

// Filter sell mode: fixed or futbin (the filter may follow the Sell tab).
export const sellModeFor = (filter, sell) => {
  if (filter && filter.sellMode === "fixed") {
    return "fixed";
  }
  if (filter && filter.sellMode === "futbin") {
    return "futbin";
  }
  return sell.priceMode === "futbin" ? "futbin" : "fixed";
};

export const sellPercentFor = (filter, sell) =>
  filter && filter.sellPercent && (filter.sellMode === "futbin" || filter.itemGroup !== "players") ? filter.sellPercent : sell.futbinPercent;

export const fixedSellPriceFor = (filter, sell) =>
  roundPrice((filter && filter.sellMode === "fixed" && toInt(filter.sellPrice)) || toInt(sell.defaultPrice));

// Adjust the Buy Now price to the card's EA limits and calculate the starting bid.
export const prepareListing = async (item, price) => {
  let buyNow = roundPrice(price);
  const limits = await market.fetchPriceLimits(item);
  if (limits) {
    if (limits.max && buyNow > limits.max) {
      buyNow = floorPrice(limits.max);
    }
    if (limits.min && buyNow <= limits.min) {
      buyNow = priceAbove(limits.min);
    }
  }
  let start = startPriceFor(buyNow);
  if (limits && limits.min && start < limits.min) {
    start = limits.min;
  }
  if (start >= buyNow) {
    start = priceBelow(buyNow) || start;
  }
  return { buyNow, start, limits, valid: !!(buyNow >= 150 && start >= 150 && start < buyNow &&
    (!limits || (!limits.min || start >= limits.min) && (!limits.max || buyNow <= limits.max))) };
};
