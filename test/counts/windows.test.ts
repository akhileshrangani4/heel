import { describe, expect, it } from "vitest";
import {
  COUNT_RETENTION_MS,
  type CountEvent,
  currentRunSpan,
  HOUR_MS,
  hourWindowStart,
  parseStoredFacts,
  type StoredFacts,
  storedFacts,
  sumMatching,
} from "../../src/core/counts.ts";
import { isItemCount, itemsFromCount, itemsFromIds, SINGLE_ITEM } from "../../src/core/items.ts";
import type { CompiledRule } from "../../src/core/rules/compile.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import { compileRules } from "../helpers/pipeline.ts";

/** Count math and item expansion: pure, no store (spec: Counts and state checks). */

function firstRule(yaml: string): CompiledRule {
  const rule = compileRules({ owner: yaml }).owners.get(LOCAL_OWNER_NAME)?.rules[0];
  if (rule === undefined) throw new Error("no rule compiled");
  return rule;
}

const REMOVALS_ON_WORK = firstRule(`rules:
  - match: { action: email.remove, account: gmail-work, items: { over: 20, per: run } }
    then: ask
`);

function event(
  facts: Partial<StoredFacts>,
  items: number,
  runId: string | null = null,
): CountEvent {
  return { runId, facts: { agent: "inbox-bot", account: "gmail-work", ...facts }, items };
}

describe("item expansion", () => {
  it("I-24: a batch is as many items as it has ids, up to the 1,000 Gmail allows", () => {
    expect(itemsFromIds(Array.from({ length: 1000 }, (_, i) => `m${i}`))).toEqual({
      ok: true,
      items: 1000,
    });
    expect(itemsFromIds(["m1", "m2", "m3"])).toEqual({ ok: true, items: 3 });
  });

  it("never makes a call free: an empty batch or an empty thread is still one item", () => {
    expect(itemsFromIds([])).toEqual({ ok: true, items: SINGLE_ITEM });
    expect(itemsFromCount(0)).toEqual({ ok: true, items: SINGLE_ITEM });
    expect(itemsFromCount(37)).toEqual({ ok: true, items: 37 });
  });

  it("refuses to guess at a batch or a count it can't read", () => {
    for (const ids of ["m1,m2", { 0: "m1" }, null, undefined, 3]) {
      expect(itemsFromIds(ids)).toEqual({ ok: false });
    }
    for (const count of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "12", null]) {
      expect(itemsFromCount(count)).toEqual({ ok: false });
    }
  });

  it("accepts only a positive safe integer as a call's items", () => {
    expect([1, 1000].map(isItemCount)).toEqual([true, true]);
    expect([0, -3, 2.5, Number.POSITIVE_INFINITY, "1"].map(isItemCount)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("windows", () => {
  const now = new Date("2026-11-13T12:00:00.000Z");

  it("starts the sliding hour exactly 60 minutes before now", () => {
    expect(hourWindowStart(now).getTime()).toBe(now.getTime() - HOUR_MS);
  });

  it("keeps a run's events while it has been idle for less than the retention", () => {
    const at = (msAgo: number) => ({ at: new Date(now.getTime() - msAgo) });
    const events = [at(3 * HOUR_MS), at(2 * HOUR_MS), at(HOUR_MS)];

    expect(currentRunSpan(events, now)).toEqual(events);
  });

  it("ends a run after 7 idle days, so a reused run id starts from zero", () => {
    const at = (msAgo: number) => ({ at: new Date(now.getTime() - msAgo) });
    const old = at(COUNT_RETENTION_MS + 2 * HOUR_MS);
    const recent = [at(HOUR_MS), at(HOUR_MS / 2)];

    expect(currentRunSpan([old, ...recent], now)).toEqual(recent);
    // Still idle: nothing counts, even before the pruner deletes it.
    expect(currentRunSpan([old], now)).toEqual([]);
    expect(currentRunSpan([], now)).toEqual([]);
  });
});

describe("summing", () => {
  it("I-24: sums the items of past events that match the rule's plain conditions", () => {
    const events = [
      event({ action: "email.remove" }, 12),
      event({ action: "email.remove" }, 1),
      event({ action: "email.remove", account: "gmail-personal" }, 50),
      event({ action: "email.send" }, 3),
    ];

    expect(sumMatching(REMOVALS_ON_WORK, events)).toBe(13);
  });

  it("I-24: sums items, not calls: one 1,000-message batch is 1,000", () => {
    expect(sumMatching(REMOVALS_ON_WORK, [event({ action: "email.remove" }, 1000)])).toBe(1000);
  });

  it("doesn't replay state checks against history", () => {
    const merges = firstRule(`rules:
  - match: { action: github.merge, checks: passing, items: { over: 3, per: hour } }
    then: ask
`);

    expect(sumMatching(merges, [event({ action: "github.merge" }, 1)])).toBe(1);
  });

  it("matches a rule's argument conditions against the stored arguments", () => {
    const labelled = firstRule(`rules:
  - match: { action: email.label, args.label: SPAM, items: { over: 5, per: hour } }
    then: ask
`);
    const events = [
      event({ action: "email.label", args: { label: "SPAM" } }, 4),
      event({ action: "email.label", args: { label: "Receipts" } }, 9),
    ];

    expect(sumMatching(labelled, events)).toBe(4);
  });
});

describe("stored facts", () => {
  it("drop items and the run id, which have their own columns, and read back unchanged", () => {
    const stored = storedFacts({
      agent: "inbox-bot",
      account: "gmail-work",
      provider: "gmail",
      tool: "send",
      args: { subject: "Q3" },
      action: "email.send",
      kind: "write",
      recipients: ["bob@vendor.com"],
      items: 4,
      runId: "r1",
    });

    expect(stored).not.toHaveProperty("items");
    expect(stored).not.toHaveProperty("runId");
    expect(parseStoredFacts(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("refuse a row that doesn't hold a call's facts", () => {
    for (const value of [
      null,
      [],
      "gmail-work",
      {},
      { agent: "inbox-bot" },
      { agent: "inbox-bot", account: "gmail-work", kind: "delete" },
      { agent: "inbox-bot", account: "gmail-work", recipients: "bob@vendor.com" },
      { agent: "inbox-bot", account: "gmail-work", cli: { command: "gh" } },
    ]) {
      expect(parseStoredFacts(value)).toBeNull();
    }
  });
});
