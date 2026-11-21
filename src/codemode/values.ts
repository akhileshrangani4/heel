/**
 * Python values as they leave Monty, turned into plain JSON values (D6b).
 * Monty hands dicts over as `Map`s, which `JSON.stringify` would silently
 * turn into `{}`, so what a rule checked would differ from what the script
 * wrote. Pure.
 *
 * - A dict becomes an object; a key that isn't a string is refused.
 * - An int past JavaScript's safe range is refused in arguments (it can't
 *   be sent as the script wrote it) and shown as a string in output.
 * - Anything else that isn't JSON (sets, bytes, objects) is refused.
 * - A `__proto__` key is refused rather than dropped, so a rule never checks
 *   less than the script sent.
 * - A value bigger than `MAX_VALUE_SIZE` is refused as it is walked. A list
 *   holding the same string 450 times is small inside Monty but 450 copies
 *   here, so the size is counted on the way, not checked at the end.
 */

export class ValueError extends Error {
  override readonly name = "ValueError";
}

const MAX_DEPTH = 64;
/** Roughly the bytes one value may take once sent: characters, plus a little per item. */
export const MAX_VALUE_SIZE = 8 * 1024 * 1024;
const PER_ITEM = 8;

export function plainValue(
  value: unknown,
  mode: "argument" | "output",
  depth = 0,
  budget = { left: MAX_VALUE_SIZE },
): unknown {
  if (depth > MAX_DEPTH) throw new ValueError("the value is nested too deeply");
  budget.left -= typeof value === "string" ? value.length + PER_ITEM : PER_ITEM;
  if (budget.left < 0) throw new ValueError("the value is too large to send");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValueError("the value isn't a finite number");
    return value;
  }
  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    if (mode === "output") return value.toString();
    throw new ValueError("an int argument is too large to send");
  }
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => plainValue(v, mode, depth + 1, budget));
  const entries: [unknown, unknown][] =
    value instanceof Map
      ? [...value.entries()]
      : typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))
        ? Object.entries(value as Record<string, unknown>)
        : (() => {
            throw new ValueError("the value can't be sent as JSON");
          })();
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, v] of entries) {
    if (typeof key !== "string") throw new ValueError("a dict key isn't a string");
    if (key === "__proto__") throw new ValueError("a dict key can't be __proto__");
    budget.left -= key.length;
    out[key] = plainValue(v, mode, depth + 1, budget);
  }
  // A plain object again, so callers see an ordinary record (the null prototype only guarded the writes).
  return { ...out };
}
