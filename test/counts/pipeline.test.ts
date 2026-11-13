import { describe, expect, it } from "vitest";
import { COUNT_RETENTION_MS, HOUR_MS } from "../../src/core/counts.ts";
import type { PipelineResult } from "../../src/gateway/pipeline/ports.ts";
import { fakeNormalize, type PipelineHarness, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Count conditions through the whole pipeline, over real SQLite (spec:
 * Counts and state checks). The rules are the README's removal limits.
 */

const README_REMOVAL_LIMITS = `rules:
  - match: { action: email.remove, account: gmail-work, items: { over: 20, per: run } }
    then: ask
  - match: { action: email.remove, account: gmail-work, items: { over: 50, per: hour } }
    then: ask
  - match: { action: email.remove }
    then: allow
  - match: { action: email.send }
    then: allow
`;

const HOURLY_ONLY = `rules:
  - match: { action: email.remove, items: { over: 10, per: hour } }
    then: ask
  - match: { action: email.remove }
    then: allow
`;

function ids(n: number, prefix = "m"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function remove(h: PipelineHarness, n: number, runId?: string, account = "gmail-work") {
  return h.call({
    account,
    tool: n === 1 ? "trash" : "batch_delete",
    args:
      n === 1
        ? { action: "email.remove", id: `m-${h.counts().length}` }
        : { action: "email.remove", ids: ids(n) },
    ...(runId !== undefined && { runId }),
  });
}

async function removeEach(
  h: PipelineHarness,
  times: number,
  runId?: string,
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];
  for (let i = 0; i < times; i++) results.push(await remove(h, 1, runId));
  return results;
}

const statuses = (results: PipelineResult[]) => results.map((r) => r.status);

describe("per-run counts", () => {
  it("I-24: twenty removals in a run are allowed, and the 21st asks because it counts itself", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });

    const first20 = await removeEach(h, 20, "run-1");
    const twentyFirst = await remove(h, 1, "run-1");

    expect(statuses(first20)).toEqual(Array(20).fill("allowed"));
    expect(twentyFirst).toMatchObject({ status: "pending", rule: { line: 2 } });
    expect(h.counts()).toHaveLength(20);
  });

  it("I-24: one call whose own items exceed the limit asks with no history", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });

    expect(await remove(h, 21, "run-1")).toMatchObject({ status: "pending" });
    expect(h.counts()).toEqual([]);
  });

  it("I-24: counts items, not calls: ten removals then a 15-message batch asks", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });

    await removeEach(h, 10, "run-1");
    const batch = await remove(h, 15, "run-1");
    const smaller = await remove(h, 10, "run-1");

    expect(batch.status).toBe("pending");
    expect(smaller.status).toBe("allowed"); // 10 + 10 is not over 20
  });

  it("I-24: a 1,000-message batch is 1,000 items, reserved as one event", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.remove, items: { over: 1000, per: hour } }
    then: ask
  - match: { action: email.remove }
    then: allow
`,
    });

    const batch = await remove(h, 1000, "run-1");
    const next = await remove(h, 1, "run-2");

    expect(batch.status).toBe("allowed");
    expect(h.counts().map((row) => [row.items, row.runId])).toEqual([[1000, "run-1"]]);
    expect(next.status).toBe("pending");
  });

  it("I-24: a 1,000-message batch asks under the README's run limit", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });

    expect(await remove(h, 1000, "run-1")).toMatchObject({ status: "pending", rule: { line: 2 } });
    expect(h.provider.executed).toEqual([]);
  });

  it("I-24: sums only past calls that match the rule's other conditions", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });

    // 40 items elsewhere: another account, and another action on this one.
    expect((await remove(h, 30, "run-1", "gmail-personal")).status).toBe("allowed");
    for (let i = 0; i < 10; i++) {
      await h.call({ args: { action: "email.send", subject: `s${i}` }, runId: "run-1" });
    }
    const results = await removeEach(h, 20, "run-1");

    expect(statuses(results)).toEqual(Array(20).fill("allowed"));
    expect((await remove(h, 1, "run-1")).status).toBe("pending");
  });

  it("keeps two agents' runs apart even when they send the same run id", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });
    const other = h.addAgent("cleanup-bot");

    await removeEach(h, 20, "shared");
    const otherRun = await h.call({
      agent: other,
      tool: "trash",
      args: { action: "email.remove", id: "x1" },
      runId: "shared",
    });

    expect(otherRun.status).toBe("allowed");
    expect((await remove(h, 1, "shared")).status).toBe("pending");
  });

  it("starts a reused run id from zero once the run sat idle for 7 days", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });
    await removeEach(h, 20, "nightly");
    expect((await remove(h, 1, "nightly")).status).toBe("pending");

    h.clock.advance(COUNT_RETENTION_MS);

    expect((await remove(h, 1, "nightly")).status).toBe("allowed");
  });
});

describe("hourly counts", () => {
  it("I-25: per: hour counts every run's calls and calls with no run id", async () => {
    const h = pipelineHarness({ owner: HOURLY_ONLY });

    await removeEach(h, 5, "run-a");
    await removeEach(h, 3, "run-b");
    const unlabelled = await removeEach(h, 2);
    const eleventh = await remove(h, 1, "run-c");

    expect(statuses(unlabelled)).toEqual(["allowed", "allowed"]);
    expect(eleventh.status).toBe("pending");
  });

  it("I-25: the hour slides: calls older than 60 minutes stop counting", async () => {
    const h = pipelineHarness({ owner: HOURLY_ONLY });
    await removeEach(h, 6, "run-a");
    h.clock.advance(30 * 60_000);
    await removeEach(h, 4, "run-a");
    expect((await remove(h, 1, "run-a")).status).toBe("pending");

    // The first six are now exactly an hour old and have left the window.
    h.clock.advance(30 * 60_000);

    expect(statuses(await removeEach(h, 6, "run-a"))).toEqual(Array(6).fill("allowed"));
    expect((await remove(h, 1, "run-a")).status).toBe("pending");
    h.clock.advance(HOUR_MS);
    expect((await remove(h, 1, "run-a")).status).toBe("allowed");
  });
});

describe("calls with no run id", () => {
  it("I-26: never match a per: run condition, so the rule falls through", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.remove, items: { over: 20, per: run } }
    then: ask
  - match: { action: email.remove }
    then: allow
`,
    });

    const result = await remove(h, 500);

    expect(result).toMatchObject({ status: "allowed", via: { kind: "rule", rule: { line: 4 } } });
  });

  it("I-26: an invalid run id is treated as none, and falls through the same way", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.remove, items: { over: 20, per: run } }
    then: ask
  - match: { action: email.remove }
    then: allow
`,
    });

    expect((await remove(h, 500, "not a valid id")).status).toBe("allowed");
  });

  it("I-26: are caught by the hourly limit paired below the run limit", async () => {
    const h = pipelineHarness({ owner: README_REMOVAL_LIMITS });

    const result = await remove(h, 51);

    expect(result).toMatchObject({ status: "pending", rule: { line: 4 } });
  });
});

describe("reservations", () => {
  it("lets exactly one of two parallel 15-item batches through an over-20 limit", async () => {
    const h = pipelineHarness({ owner: HOURLY_ONLY.replace("over: 10", "over: 20") });
    // Hold both calls until each has normalized, so they decide back to back.
    let arrived = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.normalizeHook = async (base) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return fakeNormalize(base);
    };

    const results = await Promise.all([remove(h, 15, "run-a"), remove(h, 15, "run-b")]);

    expect(statuses(results).sort()).toEqual(["allowed", "pending"]);
    expect(h.counts().map((row) => row.items)).toEqual([15]);
  });

  it("writes nothing for a denied, asked or paused call", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.send }
    then: deny
  - match: { action: email.remove }
    then: ask
`,
    });

    await h.call({ args: { action: "email.send" } });
    await remove(h, 5, "run-1");
    h.pauses.paused.global = true;
    await h.call({ tool: "label", args: { action: "email.label" } });

    expect(h.audit().map((row) => row.kind)).toEqual(["deny", "ask", "paused"]);
    expect(h.counts()).toEqual([]);
  });

  it("never refunds: a call the upstream rejected or lost still counts", async () => {
    const h = pipelineHarness({ owner: HOURLY_ONLY });

    h.provider.upstream = { kind: "error", status: 500, body: { error: "backend" } };
    expect((await remove(h, 6, "run-1")).status).toBe("upstream_error");
    h.provider.upstream = { kind: "drop" };
    expect((await remove(h, 4, "run-1")).status).toBe("upstream_outcome_unknown");
    h.provider.upstream = { kind: "ok" };

    expect(h.counts().map((row) => row.items)).toEqual([6, 4]);
    expect((await remove(h, 1, "run-1")).status).toBe("pending");
  });
});
