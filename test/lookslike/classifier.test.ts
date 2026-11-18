import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyLooksLike, headVerdict } from "../../src/core/lookslike/classify.ts";
import { FEATURE_VERSION } from "../../src/core/lookslike/features.ts";
import type { LooksLikeModel } from "../../src/core/lookslike/model.ts";
import {
  combineVerdicts,
  LOOKS_LIKE_CATEGORIES,
  type LooksLikeMessage,
} from "../../src/core/lookslike/types.ts";
import { LOOKS_LIKE_WEIGHTS_PATH, loadLooksLikeModel } from "../../src/lookslike/load.ts";
import {
  CONFIDENT_NO,
  CONFIDENT_YES,
  constantModel,
  DIMS,
  MATCH_AT,
  NO_MATCH_BELOW,
  ORDINARY,
  RESET,
  UNSURE,
} from "./helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "heel-lookslike-"));
}

describe("classifyLooksLike: I-44, fail closed", () => {
  it("I-44: no loaded model is uncertain, never no_match", () => {
    const result = classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, { model: undefined });
    expect(result.verdict).toBe("uncertain");
    for (const category of LOOKS_LIKE_CATEGORIES) {
      expect(result.categories[category]).toEqual({
        verdict: "uncertain",
        reason: { kind: "model_unavailable" },
      });
    }
  });

  it("I-44: a missing weights file loads as unavailable, and classifies as uncertain", () => {
    const loaded = loadLooksLikeModel(join(tempDir(), "missing.json"));
    expect(loaded.status).toBe("unavailable");
    const model = loaded.status === "loaded" ? loaded.model : undefined;
    expect(classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, { model }).verdict).toBe("uncertain");
  });

  it("I-44: corrupt or stale weights load as unavailable rather than scoring", () => {
    const dir = tempDir();
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    expect(loadLooksLikeModel(corrupt).status).toBe("unavailable");

    // Weights trained for other features would score the wrong inputs.
    const stale = join(dir, "stale.json");
    const committed = JSON.parse(readFileSync(LOOKS_LIKE_WEIGHTS_PATH, "utf8"));
    writeFileSync(stale, JSON.stringify({ ...committed, featureVersion: FEATURE_VERSION + 1 }));
    expect(loadLooksLikeModel(stale).status).toBe("unavailable");
  });

  it("I-44: an error while classifying is uncertain, and nothing throws", () => {
    const broken = { dims: DIMS, heads: {} } as unknown as LooksLikeModel;
    const result = classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, { model: broken });
    expect(result.verdict).toBe("uncertain");
    expect(result.categories.password_reset?.reason).toEqual({
      kind: "error",
      error: "TypeError",
    });

    const malformed = { ...ORDINARY, body: 42 } as unknown as LooksLikeMessage;
    expect(classifyLooksLike(malformed, LOOKS_LIKE_CATEGORIES, { model: CONFIDENT_NO })).toEqual({
      verdict: "uncertain",
      categories: {
        password_reset: { verdict: "uncertain", reason: { kind: "error", error: "TypeError" } },
        login_code: { verdict: "uncertain", reason: { kind: "error", error: "TypeError" } },
      },
    });
  });

  it("I-44: a non-finite score is uncertain", () => {
    const result = classifyLooksLike(ORDINARY, ["login_code"], {
      model: constantModel(Number.NaN),
    });
    expect(result.categories.login_code).toEqual({
      verdict: "uncertain",
      reason: { kind: "error", error: "non-finite score" },
    });
  });

  it("I-44: a low-confidence score is uncertain", () => {
    const result = classifyLooksLike(ORDINARY, ["password_reset"], { model: UNSURE });
    expect(result.categories.password_reset).toEqual({
      verdict: "uncertain",
      reason: { kind: "classifier", score: 0.5 },
    });
  });

  it("I-44: running past the time budget is uncertain; pattern matches stand", () => {
    const clock = (ticks: number[]) => () => ticks.shift() ?? Number.POSITIVE_INFINITY;
    const slow = classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, {
      model: CONFIDENT_NO,
      now: clock([0, 500]),
    });
    expect(slow.verdict).toBe("uncertain");
    expect(slow.categories.login_code?.reason).toEqual({ kind: "timeout", elapsedMs: 500 });

    const slowReset = classifyLooksLike(RESET, LOOKS_LIKE_CATEGORIES, {
      model: CONFIDENT_NO,
      now: clock([0, 500]),
    });
    expect(slowReset.categories.password_reset?.verdict).toBe("match");
    expect(slowReset.verdict).toBe("match");

    const fast = classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, {
      model: CONFIDENT_NO,
      now: clock([0, 5]),
    });
    expect(fast.verdict).toBe("no_match");
  });

  it("I-44: without a model, no input yields no_match", () => {
    const message = fc.record({
      subject: fc.string({ unit: "binary" }),
      from: fc.string({ unit: "binary" }),
      body: fc.string({ unit: "binary", maxLength: 2000 }),
      bodyFormat: fc.constantFrom("text" as const, "html" as const),
    });
    fc.assert(
      fc.property(message, (m) => {
        const result = classifyLooksLike(m, LOOKS_LIKE_CATEGORIES, { model: undefined });
        return result.verdict !== "no_match";
      }),
    );
  });
});

describe("classifyLooksLike: verdicts", () => {
  it("lets a message through only when a loaded model scores it below threshold", () => {
    expect(classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, { model: CONFIDENT_NO })).toEqual({
      verdict: "no_match",
      categories: {
        password_reset: {
          verdict: "no_match",
          reason: { kind: "classifier", score: expect.any(Number) },
        },
        login_code: {
          verdict: "no_match",
          reason: { kind: "classifier", score: expect.any(Number) },
        },
      },
    });
  });

  it("matches on a confident score", () => {
    const result = classifyLooksLike(ORDINARY, ["login_code"], { model: CONFIDENT_YES });
    expect(result.categories.login_code?.verdict).toBe("match");
  });

  it("matches on a pattern before the classifier runs", () => {
    const result = classifyLooksLike(RESET, ["password_reset"], { model: CONFIDENT_NO });
    expect(result.categories.password_reset).toEqual({
      verdict: "match",
      reason: { kind: "pattern", pattern: "reset_phrase" },
    });
  });

  it("reports only the requested categories", () => {
    const result = classifyLooksLike(ORDINARY, ["login_code"], { model: CONFIDENT_NO });
    expect(Object.keys(result.categories)).toEqual(["login_code"]);
  });

  it("hides unreadable mail unless a pattern already matched", () => {
    const flagged = classifyLooksLike({ ...ORDINARY, unreadable: "encrypted" }, ["login_code"], {
      model: CONFIDENT_NO,
    });
    expect(flagged.categories.login_code).toEqual({
      verdict: "uncertain",
      reason: { kind: "unreadable", detail: "encrypted" },
    });

    const pgp = classifyLooksLike(
      { ...ORDINARY, body: "-----BEGIN PGP MESSAGE-----\nhQEMA...\n-----END PGP MESSAGE-----" },
      ["login_code"],
      { model: CONFIDENT_NO },
    );
    expect(pgp.categories.login_code?.reason).toEqual({ kind: "unreadable", detail: "encrypted" });

    const imageOnly = classifyLooksLike(
      { ...ORDINARY, body: '<img src="https://cdn.example.com/code.png">', bodyFormat: "html" },
      ["login_code"],
      { model: CONFIDENT_NO },
    );
    expect(imageOnly.categories.login_code?.reason).toEqual({
      kind: "unreadable",
      detail: "image_only",
    });

    const readableReset = classifyLooksLike(
      { ...RESET, unreadable: "unparseable" },
      ["password_reset"],
      { model: CONFIDENT_NO },
    );
    expect(readableReset.categories.password_reset?.verdict).toBe("match");
  });

  it("headVerdict: at matchAt is a match, at noMatchBelow is still unsure", () => {
    const head = { matchAt: MATCH_AT, noMatchBelow: NO_MATCH_BELOW };
    expect(headVerdict(head, MATCH_AT)).toBe("match");
    expect(headVerdict(head, NO_MATCH_BELOW)).toBe("uncertain");
    expect(headVerdict(head, NO_MATCH_BELOW - 0.01)).toBe("no_match");
    expect(headVerdict(head, Number.NaN)).toBe("uncertain");
  });

  it("combineVerdicts: any match wins, then any uncertainty", () => {
    expect(combineVerdicts(["no_match", "uncertain", "match"])).toBe("match");
    expect(combineVerdicts(["no_match", "uncertain"])).toBe("uncertain");
    expect(combineVerdicts(["no_match", "no_match"])).toBe("no_match");
    expect(combineVerdicts([])).toBe("no_match");
  });
});

describe("committed weights", () => {
  const loaded = loadLooksLikeModel();

  it("load through the runtime loader", () => {
    expect(loaded).toMatchObject({ status: "loaded" });
  });

  it("let an ordinary business note through and hide a reset email", () => {
    if (loaded.status !== "loaded") throw new Error(loaded.error);
    const options = { model: loaded.model };
    expect(classifyLooksLike(ORDINARY, LOOKS_LIKE_CATEGORIES, options).verdict).toBe("no_match");
    expect(classifyLooksLike(RESET, LOOKS_LIKE_CATEGORIES, options).verdict).toBe("match");
  });
});
