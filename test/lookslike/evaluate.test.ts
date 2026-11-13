import { describe, expect, it } from "vitest";
import { evaluateLooksLike, type GateSettings } from "../../scripts/lib/lookslike/evaluate.ts";
import type { LabeledMessage } from "../../scripts/lib/lookslike/train.ts";
import type { LooksLikeCategory, LooksLikeMessage } from "../../src/core/lookslike/types.ts";
import { CONFIDENT_NO, CONFIDENT_YES, LOGIN_CODE, ORDINARY, RESET, UNSURE } from "./helpers.ts";

/** The spec's thresholds, with floors low enough for hand-built sets. */
const GATE: GateSettings = {
  minRecall: 0.99,
  maxOrdinaryFpr: 0.05,
  minPositivesPerCategory: 1,
  minOrdinary: 1,
};

function labeled(
  id: string,
  message: LooksLikeMessage,
  labels: LooksLikeCategory[],
  ordinary = labels.length === 0,
): LabeledMessage {
  return { id, group: id.split("#")[0] as string, labels, ordinary, message };
}

const BASE = [
  labeled("reset#1", RESET, ["password_reset"]),
  labeled("code#1", LOGIN_CODE, ["login_code"]),
  labeled("enron#1", ORDINARY, []),
];

describe("evaluateLooksLike: the release gate", () => {
  it("passes when every positive is hidden and no ordinary mail is", () => {
    const report = evaluateLooksLike(BASE, CONFIDENT_NO, GATE);
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.recall.password_reset).toEqual({ hidden: 1, total: 1, rate: 1 });
    expect(report.recall.login_code).toEqual({ hidden: 1, total: 1, rate: 1 });
    expect(report.ordinaryFpr).toEqual({ hidden: 0, total: 1, rate: 0 });
  });

  it("fails when a positive gets through, and names it", () => {
    const missed = labeled("reset#2", ORDINARY, ["password_reset"]);
    const report = evaluateLooksLike([...BASE, missed], CONFIDENT_NO, GATE);
    expect(report.pass).toBe(false);
    expect(report.recall.password_reset.rate).toBe(0.5);
    expect(report.missed).toEqual([{ id: "reset#2", category: "password_reset" }]);
    expect(report.failures).toEqual(["password_reset: recall 0.5000 is below 0.99"]);
  });

  it("scores each positive against its own category, so the other pattern can't rescue it", () => {
    // RESET hits a password_reset pattern but no login_code pattern.
    const crossed = labeled("code#2", RESET, ["login_code"]);
    const report = evaluateLooksLike([...BASE, crossed], CONFIDENT_NO, GATE);
    expect(report.missed).toEqual([{ id: "code#2", category: "login_code" }]);
    expect(report.pass).toBe(false);
  });

  it("fails when ordinary mail is hidden above the ceiling", () => {
    const report = evaluateLooksLike(BASE, CONFIDENT_YES, GATE);
    expect(report.ordinaryFpr.rate).toBe(1);
    expect(report.ordinaryHiddenBy).toEqual({ "classifier:match": 1 });
    expect(report.failures).toEqual(["ordinary mail: false-positive rate 1.0000 is above 0.05"]);
  });

  it("I-44: counts uncertain as hidden, so fail-closed costs show up in the FPR", () => {
    const report = evaluateLooksLike(BASE, UNSURE, GATE);
    expect(report.ordinaryHiddenBy).toEqual({ "classifier:uncertain": 1 });
    expect(report.pass).toBe(false);
  });

  it("reports hard negatives without gating on them", () => {
    const hard = labeled("heel.meeting_invite#1", LOGIN_CODE, [], false);
    const report = evaluateLooksLike([...BASE, hard], CONFIDENT_NO, GATE);
    expect(report.hardNegativeFpr).toEqual({ hidden: 1, total: 1, rate: 1 });
    expect(report.ordinaryFpr.rate).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("never passes on too few examples", () => {
    const report = evaluateLooksLike([], CONFIDENT_NO, GATE);
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      "password_reset: 0 held-out positives, need at least 1",
      "login_code: 0 held-out positives, need at least 1",
      "ordinary mail: 0 held-out messages, need at least 1",
    ]);
  });
});
