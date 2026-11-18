/**
 * Rollout modes (A3; v1 design "Three modes"): how much of the rules heel
 * enforces, set per org and per owner and switchable live.
 *
 * - `enforce`: heel decides every call. The default.
 * - `shadow`: owner rules and the default deny are evaluated and logged as
 *   would-deny or would-ask, then the call runs. This is `heel serve
 *   --watch`, on the same code path.
 * - `record`: the same calls run as in shadow, but owner rules aren't
 *   evaluated at all. heel records traffic for a team that has no rules
 *   yet.
 *
 * No mode ever allows a call that `--watch` doesn't (I-71, I-13). Org rules,
 * hard denies, pause, hiding and fail-closed denies hold in every mode.
 */

export const MODES = ["enforce", "shadow", "record"] as const;
export type Mode = (typeof MODES)[number];

export function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value);
}

/** Pure: the strictest of several modes; with none, the fallback. Enforce beats shadow beats record. */
export function strictest(modes: readonly Mode[], fallback: Mode): Mode {
  if (modes.length === 0) return fallback;
  return modes.reduce((a, b) => (MODES.indexOf(a) <= MODES.indexOf(b) ? a : b));
}
