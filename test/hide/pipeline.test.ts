import { describe, expect, it } from "vitest";
import type { HideCandidate } from "../../src/core/hide.ts";
import { pipelineHarness } from "../helpers/pipeline.ts";

/**
 * The pipeline hands each definition one call's `Hiding`, built from the
 * account owner's entries, the `looks_like` judge and the metric hook.
 */

const RULES = `rules:
  - match: { action: email.send }
    then: allow
hide:
  - email: { looks_like: [password_reset] }
`;

const TEXT = { body: "Hello", bodyFormat: "text" } as const;

const MESSAGES: HideCandidate[] = [
  { from: "bob@company.com", to: [], subject: "Lunch?", labels: [], body: TEXT },
  { from: "carol@company.com", to: [], subject: "Notes", labels: [], body: TEXT },
];

function harness(options: Parameters<typeof pipelineHarness>[0] = {}) {
  const h = pipelineHarness({ owner: RULES, ...options });
  h.provider.hide = async (_call, _result, hiding) =>
    MESSAGES.filter((message) => !hiding.isHidden(message)).map((message) => message.subject);
  return h;
}

const SEND = { action: "email.send", recipients: ["bob@vendor.com"] };

describe("the pipeline's hiding", () => {
  it("I-44: without a judge, every message a looks_like entry covers is hidden and counted", async () => {
    const h = harness();
    const result = await h.call({ args: SEND });
    expect(result).toMatchObject({ status: "allowed", result: [] });
    expect(h.hidden).toEqual(["uncertain", "uncertain"]);
  });

  it("uses the judge it is given", async () => {
    const h = harness({
      looksLike: (message) => (message.subject === "Notes" ? "match" : "no_match"),
    });
    const result = await h.call({ args: SEND });
    expect(result).toMatchObject({ status: "allowed", result: ["Lunch?"] });
    expect(h.hidden).toEqual(["matched"]);
  });
});
