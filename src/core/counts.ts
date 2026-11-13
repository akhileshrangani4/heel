import type { CliFields, HttpFields } from "./call.ts";
import type { CompiledRule } from "./rules/compile.ts";
import { plainMatch } from "./rules/evaluate.ts";
import type { RuleFacts } from "./rules/facts.ts";
import { RUN_RETENTION_MS } from "./run-id.ts";

/**
 * Count math (spec: Counts and state checks, "Item counts"). Pure: the store
 * reads the window's events, and these functions decide which of them a
 * rule's count condition sums.
 */

export const HOUR_MS = 60 * 60 * 1000;

/** Count events are kept 7 days (I-04); per-run counts live 7 days past the run's last call. */
export const COUNT_RETENTION_MS = RUN_RETENTION_MS;

/**
 * What a count event stores of a call: every fact a plain condition can
 * read, so a later rule can re-check history against any field (account,
 * action, repo, `args.*`, …). Items and the run id have their own columns.
 */
export type StoredFacts = Omit<RuleFacts, "items" | "runId">;

export interface CountEvent {
  runId: string | null;
  facts: StoredFacts;
  items: number;
}

export function storedFacts(facts: RuleFacts): StoredFacts {
  const { items: _items, runId: _runId, ...stored } = facts;
  return stored;
}

/** Pure: the start of the sliding hour ending at `now`; events strictly after it count. */
export function hourWindowStart(now: Date): Date {
  return new Date(now.getTime() - HOUR_MS);
}

/**
 * Pure: the events of a run that still count, given all of its events oldest
 * first. A run's counts last until it has been idle for the retention, so an
 * idle gap that long ends the run: events before it never count again, even
 * if the agent reuses the run id and the pruner hasn't deleted them yet.
 */
export function currentRunSpan<T extends { at: Date }>(events: readonly T[], now: Date): T[] {
  let start = 0;
  let previous: T | undefined;
  for (const [i, event] of events.entries()) {
    if (
      previous !== undefined &&
      event.at.getTime() - previous.at.getTime() >= COUNT_RETENTION_MS
    ) {
      start = i;
    }
    previous = event;
  }
  if (previous === undefined || now.getTime() - previous.at.getTime() >= COUNT_RETENTION_MS) {
    return [];
  }
  return events.slice(start);
}

/**
 * Pure: the items of past events that satisfy `rule`'s plain conditions
 * (I-24). The caller passes only this agent's events in the window, and the
 * evaluator adds the current call's items. State checks are not replayed
 * against history, and an event whose facts can't be judged (an address that
 * no longer parses) doesn't count.
 */
export function sumMatching(rule: CompiledRule, events: Iterable<CountEvent>): number {
  let total = 0;
  for (const event of events) {
    const facts: RuleFacts = {
      ...event.facts,
      items: event.items,
      ...(event.runId !== null && { runId: event.runId }),
    };
    if (plainMatch(rule, facts) === true) total += event.items;
  }
  return total;
}

/**
 * Pure: reads stored facts back from the JSON column. heel wrote them, so a
 * row that doesn't have their shape means the database was edited by hand or
 * is corrupt; the caller denies rather than count it as something else.
 */
export function parseStoredFacts(value: unknown): StoredFacts | null {
  if (!isRecord(value)) return null;
  const { agent, account, provider, tool, action, kind, recipients, repo, cli, http, persistence } =
    value;
  if (typeof agent !== "string" || typeof account !== "string") return null;
  if (!optional(provider, isString) || !optional(tool, isString) || !optional(action, isString)) {
    return null;
  }
  if (!optional(kind, (k) => k === "read" || k === "write")) return null;
  if (!optional(recipients, isStringArray) || !optional(repo, isString)) return null;
  if (!optional(cli, isCliFields) || !optional(http, isHttpFields)) return null;
  if (!optional(persistence, (p) => typeof p === "boolean")) return null;
  return {
    agent,
    account,
    ...(typeof provider === "string" && { provider }),
    ...(typeof tool === "string" && { tool }),
    ...(Object.hasOwn(value, "args") && { args: value["args"] }),
    ...(typeof action === "string" && { action }),
    ...((kind === "read" || kind === "write") && { kind }),
    ...(isStringArray(recipients) && { recipients }),
    ...(typeof repo === "string" && { repo }),
    ...(isCliFields(cli) && { cli }),
    ...(isHttpFields(http) && { http }),
    ...(typeof persistence === "boolean" && { persistence }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function isCliFields(value: unknown): value is CliFields {
  if (!isRecord(value)) return false;
  const { command, verb, subcommand, flags, argv } = value;
  return (
    typeof command === "string" &&
    optional(verb, isString) &&
    optional(subcommand, isString) &&
    isRecord(flags) &&
    Object.values(flags).every((flag) => typeof flag === "string" || flag === true) &&
    isStringArray(argv)
  );
}

function isHttpFields(value: unknown): value is HttpFields {
  if (!isRecord(value)) return false;
  const { method, path, pathTemplate, query } = value;
  return (
    typeof method === "string" &&
    typeof path === "string" &&
    optional(pathTemplate, isString) &&
    isRecord(query) &&
    Object.values(query).every((entry) => isString(entry) || isStringArray(entry))
  );
}
