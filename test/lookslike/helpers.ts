import type { LooksLikeModel } from "../../src/core/lookslike/model.ts";
import type { LooksLikeMessage } from "../../src/core/lookslike/types.ts";

/**
 * A token-shaped URL part: long and mixed, as `isTokenLike` wants. Built by
 * repetition so the source holds no high-entropy literal for secret scanners
 * to flag; it is a fixture, never a credential.
 */
export const FAKE_TOKEN = "tok3n".repeat(4);

export const DIMS = 1024;
export const MATCH_AT = 0.9;
export const NO_MATCH_BELOW = 0.1;

/** Zero weights, so every message scores sigmoid(bias): the verdict is chosen by the test. */
export function constantModel(bias: number): LooksLikeModel {
  const head = () => ({
    bias,
    weights: new Float32Array(DIMS),
    matchAt: MATCH_AT,
    noMatchBelow: NO_MATCH_BELOW,
  });
  return { dims: DIMS, heads: { password_reset: head(), login_code: head() } };
}

/** Scores ~0: every message the patterns miss is let through. */
export const CONFIDENT_NO = constantModel(-10);
/** Scores ~1: every message is a match. */
export const CONFIDENT_YES = constantModel(10);
/** Scores exactly 0.5, inside the unsure band. */
export const UNSURE = constantModel(0);

/** No pattern hits: only the classifier can hide it. */
export const ORDINARY: LooksLikeMessage = {
  subject: "Thursday call",
  from: "Sally Beck <sally.beck@example.com>",
  body:
    "Jeff, can we move the 3pm call with the gas desk to Thursday? " +
    "I'll send the updated numbers tonight.\n\nThanks,\nSally",
  bodyFormat: "text",
};

/** Hits the `reset_phrase` pattern. */
export const RESET: LooksLikeMessage = {
  subject: "Reset your password",
  from: "Example <no-reply@example.com>",
  body: `We received a request to reset your password. https://app.example.com/reset/${FAKE_TOKEN}`,
  bodyFormat: "text",
};

/** Hits the `login_code` pattern. */
export const LOGIN_CODE: LooksLikeMessage = {
  subject: "Your sign-in code",
  from: "Example <no-reply@example.com>",
  body: "Your verification code is 482913. It expires in 10 minutes.",
  bodyFormat: "text",
};
