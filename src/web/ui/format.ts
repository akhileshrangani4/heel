import type { PauseScope, RuleRef } from "../../core/call.ts";

/**
 * Pure formatting for the human plane. Every function takes the clock as an
 * argument, so a page renders the same bytes for the same props.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `2026-11-13 14:05 UTC`: absolute, unambiguous across approvers' time zones. */
export function formatUtc(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A coarse span such as `23 h 59 min` or `6 days 4 h`, for "expires in". */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE)) * MINUTE;
  if (total < MINUTE) return "under a minute";
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${plural(days, "day")} ${hours} h` : plural(days, "day");
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

/** `in 3 h`, or `4 min ago` once `at` has passed. */
export function formatRelative(at: Date, now: Date): string {
  const delta = at.getTime() - now.getTime();
  return delta >= 0 ? `in ${formatSpan(delta)}` : `${formatSpan(-delta)} ago`;
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Attachment sizes as the approval page lists them (Q-N4). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte");
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** `client-sends-ask (rules/alice.yaml:14)`; an unnamed rule shows its position only. */
export function formatRule(rule: RuleRef): string {
  const where = `${rule.file}:${rule.line}`;
  return rule.name === null ? where : `${rule.name} (${where})`;
}

/** What a pause covers, in words: `everything`, `agent inbox-bot`, … */
export function formatPauseScope(scope: PauseScope, target: string | null): string {
  if (scope === "global" || target === null) return "everything";
  if (scope === "owner") return `every agent ${target} owns`;
  return `${scope} ${target}`;
}

/**
 * The full arguments as indented JSON with object keys sorted, so the same
 * call always reads the same way however the agent ordered its keys. (Keys
 * that look like array indexes keep JavaScript's numeric order.) Nothing is
 * elided (I-57). Throws on a value JSON can't represent rather than showing
 * something other than what runs.
 */
export function formatArguments(args: unknown): string {
  const text = JSON.stringify(args, sortKeys, 2);
  if (text === undefined) throw new TypeError("call arguments are not representable as JSON");
  return text;
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries);
}
