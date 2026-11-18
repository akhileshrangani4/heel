import { describe, expect, it } from "vitest";
import {
  type HideCandidate,
  hideVerdict,
  hidingFor,
  type LooksLikeJudge,
  needsBody,
  UNSURE_JUDGE,
} from "../../src/core/hide.ts";
import type { LooksLikeVerdict } from "../../src/core/lookslike/types.ts";
import { HideCounts, looksLikeJudge } from "../../src/lookslike/judge.ts";
import { loadLooksLikeModel } from "../../src/lookslike/load.ts";
import { compileFile } from "../rules/helpers.ts";

function entries(hideYaml: string) {
  return compileFile(`rules: []\nhide:\n${hideYaml}`, "owner").hide;
}

function message(overrides: Partial<HideCandidate> = {}): HideCandidate {
  return {
    from: "bob@company.com",
    to: ["alice@company.com"],
    subject: "Lunch on Friday?",
    labels: ["INBOX"],
    body: { body: "Are you free for lunch on Friday?", bodyFormat: "text" },
    ...overrides,
  };
}

/** A judge that always answers `verdict` and records that it was asked. */
function fixedJudge(verdict: LooksLikeVerdict): LooksLikeJudge & { calls: number } {
  const judge = Object.assign(
    () => {
      judge.calls += 1;
      return verdict;
    },
    { calls: 0 },
  );
  return judge;
}

const FAMILY = "  - email: { from: { any_of: [sarah@example.com] } }\n";
const RESETS = "  - email: { looks_like: [password_reset, login_code] }\n";

describe("hideVerdict: plain checks", () => {
  it("hides a message an entry matches and names the entry", () => {
    const verdict = hideVerdict(
      entries(FAMILY),
      message({ from: "Sarah <sarah@example.com>" }),
      fixedJudge("no_match"),
    );
    expect(verdict).toEqual({
      hidden: true,
      reason: "matched",
      entry: { file: "rules/alice.yaml", line: 3 },
    });
  });

  it("shows a message no entry matches", () => {
    expect(hideVerdict(entries(FAMILY), message(), fixedJudge("match"))).toEqual({
      hidden: false,
    });
  });

  it("ANDs the keys inside one entry", () => {
    const both = entries(
      "  - email: { from: { any_of: [sarah@example.com] }, labels: { any_of: [Family] } }\n",
    );
    const judge = fixedJudge("no_match");
    expect(hideVerdict(both, message({ from: "sarah@example.com" }), judge).hidden).toBe(false);
    expect(
      hideVerdict(both, message({ from: "sarah@example.com", labels: ["Family"] }), judge).hidden,
    ).toBe(true);
  });

  it("ORs the entries", () => {
    const either = entries(`${FAMILY}  - email: { subject: { matches: "(?i).*invoice.*" } }\n`);
    const judge = fixedJudge("no_match");
    expect(hideVerdict(either, message({ subject: "Your invoice" }), judge).hidden).toBe(true);
    expect(hideVerdict(either, message({ from: "sarah@example.com" }), judge).hidden).toBe(true);
  });

  it("hides a message whose address doesn't parse, failing closed", () => {
    const verdict = hideVerdict(
      entries(FAMILY),
      message({ from: "not an address" }),
      fixedJudge("no_match"),
    );
    expect(verdict).toMatchObject({ hidden: true, reason: "unparseable" });
  });

  it("shows everything when there are no entries", () => {
    expect(hideVerdict([], message(), fixedJudge("match"))).toEqual({ hidden: false });
  });
});

describe("hideVerdict: looks_like", () => {
  it("hides on a match", () => {
    expect(hideVerdict(entries(RESETS), message(), fixedJudge("match"))).toMatchObject({
      hidden: true,
      reason: "matched",
    });
  });

  it("I-44: hides on uncertain, never treating it as no_match", () => {
    expect(hideVerdict(entries(RESETS), message(), fixedJudge("uncertain"))).toMatchObject({
      hidden: true,
      reason: "uncertain",
    });
  });

  it("shows on no_match", () => {
    expect(hideVerdict(entries(RESETS), message(), fixedJudge("no_match")).hidden).toBe(false);
  });

  it("doesn't ask the judge when the entry's plain checks already fail", () => {
    const judge = fixedJudge("match");
    const scoped = entries(
      "  - email: { from: { any_domain_in: [bank.com] }, looks_like: [password_reset] }\n",
    );
    expect(hideVerdict(scoped, message(), judge).hidden).toBe(false);
    expect(judge.calls).toBe(0);
  });

  it("I-44: unreadable mail hides even when the judge says no_match", () => {
    const judge = fixedJudge("no_match");
    const encrypted = message({ body: { body: "", bodyFormat: "text", unreadable: "encrypted" } });
    expect(hideVerdict(entries(RESETS), encrypted, judge)).toMatchObject({
      hidden: true,
      reason: "uncertain",
    });
    const { body: _, ...headersOnly } = message();
    expect(hideVerdict(entries(RESETS), headersOnly, judge).hidden).toBe(true);
    expect(judge.calls).toBe(0);
  });

  it("I-43: no looks_like verdict un-hides a message another entry hides", () => {
    const set = entries(`${RESETS}${FAMILY}`);
    const family = message({ from: "sarah@example.com" });
    for (const verdict of ["match", "no_match", "uncertain"] as const) {
      expect(hideVerdict(set, family, fixedJudge(verdict)).hidden).toBe(true);
    }
  });
});

describe("needsBody", () => {
  it("is true only when an entry uses looks_like", () => {
    expect(needsBody(entries(FAMILY))).toBe(false);
    expect(needsBody(entries(`${FAMILY}${RESETS}`))).toBe(true);
    expect(needsBody([])).toBe(false);
  });
});

describe("the looks_like judge", () => {
  const loaded = loadLooksLikeModel();
  if (loaded.status !== "loaded") throw new Error("the committed weights must load");
  const judge = looksLikeJudge(loaded.model);

  it("hides a password reset email", () => {
    const reset = message({
      from: "Example <no-reply@example.com>",
      subject: "Reset your password",
      body: { body: "We received a request to reset your password.", bodyFormat: "text" },
    });
    expect(hideVerdict(entries(RESETS), reset, judge).hidden).toBe(true);
  });

  it("shows an ordinary email", () => {
    expect(hideVerdict(entries(RESETS), message(), judge)).toEqual({ hidden: false });
  });

  it("I-44: a message with no body read is judged unreadable, so it hides", () => {
    const { body: _, ...headersOnly } = message();
    expect(hideVerdict(entries(RESETS), headersOnly, judge)).toMatchObject({
      hidden: true,
      reason: "uncertain",
    });
  });

  it("I-44: with no model loaded, every looks_like message is hidden as uncertain", () => {
    const verdict = hideVerdict(entries(RESETS), message(), looksLikeJudge(undefined));
    expect(verdict).toMatchObject({ hidden: true, reason: "uncertain" });
  });
});

describe("hidingFor", () => {
  it("I-44: counts each hidden message by reason, and the default judge hides every looks_like message", () => {
    const counts = new HideCounts();
    const hiding = hidingFor(entries(`${FAMILY}${RESETS}`), UNSURE_JUDGE, (reason) =>
      counts.record(reason),
    );
    expect(hiding.needsBody).toBe(true);
    expect(hiding.isHidden(message())).toBe(true);
    expect(hiding.isHidden(message({ from: "sarah@example.com" }))).toBe(true);
    expect(counts.snapshot()).toEqual({ matched: 1, uncertain: 1, unparseable: 0 });
  });
});

describe("HideCounts", () => {
  it("counts hidden messages by reason", () => {
    const counts = new HideCounts();
    counts.record("uncertain");
    counts.record("uncertain");
    counts.record("matched");
    expect(counts.snapshot()).toEqual({ matched: 1, uncertain: 2, unparseable: 0 });
  });
});
