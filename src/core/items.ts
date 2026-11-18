/**
 * Item expansion (spec: Counts and state checks, "Item expansion per
 * action"). `items` is what one call affects, never how many calls were
 * made: a 1,000-id `batchDelete` is 1,000 items, and a thread-level trash is
 * every message in the thread. Provider definitions expand their own calls
 * with these helpers; anything else is one item.
 */

export const SINGLE_ITEM = 1;

export type ItemExpansion = { ok: true; items: number } | { ok: false };

const UNCOUNTABLE: ItemExpansion = { ok: false };

/**
 * Pure: a batch call's items, the length of its id list (Gmail
 * `batchDelete`/`batchModify`). An empty list still counts as one item,
 * so a call can never be free. A list that isn't an array can't be counted,
 * and the definition must deny the call rather than guess.
 */
export function itemsFromIds(ids: unknown): ItemExpansion {
  if (!Array.isArray(ids)) return UNCOUNTABLE;
  return { ok: true, items: Math.max(SINGLE_ITEM, ids.length) };
}

/**
 * Pure: the items a container call affects, from heel's own read before
 * deciding (e.g. the messages in a thread from `threads.get(format=minimal)`).
 * Anything but a non-negative safe integer can't be counted.
 */
export function itemsFromCount(count: unknown): ItemExpansion {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return UNCOUNTABLE;
  return { ok: true, items: Math.max(SINGLE_ITEM, count) };
}

/** Pure: a call's `items` is usable only as a positive safe integer. */
export function isItemCount(items: unknown): items is number {
  return typeof items === "number" && Number.isSafeInteger(items) && items >= SINGLE_ITEM;
}
