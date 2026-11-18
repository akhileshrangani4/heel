import { describe, expect, it } from "vitest";
import { strictest } from "../../src/core/modes.ts";
import { ORG_DEFAULT, setMode } from "../../src/store/modes.ts";
import { modeChanges } from "../../src/store/schema.ts";
import { pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Rollout modes (A3): enforce, shadow and record, stored per org and per
 * owner, strictest wins. No mode allows a call `--watch` wouldn't (I-71),
 * and org rules, hard denies and pause hold in every mode.
 */

const SEND = { action: "email.send", recipients: ["bob@vendor.com"] };

const OWNER_DENY = "rules:\n  - match: { action: email.send }\n    then: deny\n";
const ORG_DENY = "rules:\n  - match: { action: email.send }\n    then: deny\n";

function withMode(
  mode: "enforce" | "shadow" | "record",
  files: { owner?: string; org?: string },
  ownerRow = false,
) {
  const h = pipelineHarness(files);
  setMode(h.t.db, {
    orgId: h.t.orgId,
    ownerId: ownerRow ? h.t.ownerId : ORG_DEFAULT,
    mode,
    by: "admin",
    at: new Date(),
  });
  return h;
}

describe("strictest", () => {
  it("prefers enforce, then shadow, then record, and falls back with none", () => {
    expect(strictest(["record", "shadow"], "enforce")).toBe("shadow");
    expect(strictest(["record", "enforce"], "record")).toBe("enforce");
    expect(strictest([], "shadow")).toBe("shadow");
  });
});

describe("modes", () => {
  it("enforce denies what the owner's rules deny", async () => {
    const h = withMode("enforce", { owner: OWNER_DENY });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied" });
  });

  it("I-71: shadow lets an owner deny run, logged as would_deny in shadow", async () => {
    const h = withMode("shadow", { owner: OWNER_DENY });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
    expect(h.audit().at(-1)).toMatchObject({ kind: "would_deny", mode: "shadow", reason: "rule" });
  });

  it("record decides exactly as shadow does, logging the mode", async () => {
    const h = withMode("record", { owner: OWNER_DENY });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
    expect(h.audit().at(-1)).toMatchObject({ kind: "would_deny", mode: "record", reason: "rule" });
  });

  it.each(["shadow", "record"] as const)(
    "I-71: %s keeps an owner rule's fail-closed deny when its state check can't run",
    async (mode) => {
      const h = withMode(mode, {
        owner:
          "rules:\n  - match: { action: email.send, recipients: { all_in_thread: true } }\n    then: allow\n",
      });
      h.provider.states.set("all_in_thread", "throw");
      expect(await h.call({ args: SEND })).toMatchObject({
        status: "denied",
        reason: "state_check_unavailable",
      });
      expect(h.provider.executed).toEqual([]);
    },
  );

  it.each(["shadow", "record"] as const)("I-71: %s never relaxes an org deny", async (mode) => {
    const h = withMode(mode, { org: ORG_DENY });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied" });
    expect(h.provider.executed).toEqual([]);
  });

  it.each(["shadow", "record"] as const)("I-71: %s never relaxes a hard deny", async (mode) => {
    const h = withMode(mode, { owner: "rules:\n  - match: { kind: write }\n    then: allow\n" });
    const result = await h.call({ args: { ...SEND, persistence: true } });
    expect(result).toMatchObject({ status: "denied" });
  });

  it.each(["shadow", "record"] as const)("I-60: %s still stops a paused call", async (mode) => {
    const h = withMode(mode, { owner: OWNER_DENY });
    h.pauses.paused.global = true;
    expect(await h.call({ args: SEND })).toMatchObject({ status: "paused" });
  });

  it("an owner's row only tightens: record under an unset org default stays enforce", async () => {
    const h = withMode("record", { owner: OWNER_DENY }, true);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied" });
  });

  it("the strictest stored mode wins: an owner on enforce under an org on record", async () => {
    const h = withMode("record", { owner: OWNER_DENY });
    setMode(h.t.db, {
      orgId: h.t.orgId,
      ownerId: h.t.ownerId,
      mode: "enforce",
      by: "admin",
      at: new Date(),
    });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied" });
  });

  it("--watch is shadow only where no mode is stored", async () => {
    const watching = pipelineHarness({ owner: OWNER_DENY, watch: true });
    expect(await watching.call({ args: SEND })).toMatchObject({ status: "allowed" });
    setMode(watching.t.db, {
      orgId: watching.t.orgId,
      ownerId: ORG_DEFAULT,
      mode: "enforce",
      by: "admin",
      at: new Date(),
    });
    expect(await watching.call({ args: SEND })).toMatchObject({ status: "denied" });
  });

  it("a switch applies from the next call on, and is recorded", async () => {
    const h = withMode("shadow", { owner: OWNER_DENY });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
    setMode(h.t.db, {
      orgId: h.t.orgId,
      ownerId: ORG_DEFAULT,
      mode: "enforce",
      by: "admin",
      at: new Date(),
    });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied" });
    expect(
      h.t.db
        .select()
        .from(modeChanges)
        .all()
        .map((c) => [c.from, c.to]),
    ).toEqual([
      ["enforce", "shadow"],
      ["shadow", "enforce"],
    ]);
  });
});
