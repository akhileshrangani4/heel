/**
 * The invariants (from the spec's requirements map, REQ I-xx) that must each
 * have at least one passing test tagged with the id in its title, e.g.
 * `it("I-03: rejects an unknown token", …)`. `pnpm test:invariants` fails
 * when a listed id has no tagged test.
 *
 * Each deliverable adds the ids its acceptance criteria cite; never remove
 * one, since a listed invariant stays a release requirement.
 */
export const REQUIRED_INVARIANTS: Readonly<Record<string, string>> = {
  // D1: foundation
  "I-02": "Credentials are encrypted at rest and never written to logs.",
  "I-03": "A missing, unknown or revoked agent token is rejected before rules run.",
  "I-04": "Counters, pending and standing approvals, and pause state survive a restart.",
  "I-73": "Every decision kind writes a complete audit row.",
  // D4a: human-plane UI (the render side; D4 adds the server-side proofs)
  "I-56":
    "Deciding needs a passkey assertion bound to the call hash; no control decides without one.",
  "I-57": "The approval page shows the full arguments, never truncated.",
  // D2: rules engine
  "I-10": "A call that matches no rule is denied.",
  "I-12": "An org rule with `then: allow` is a load error.",
  "I-13": "An org deny beats every owner rule, standing approval and watch mode.",
  "I-18": "A check on a field the call doesn't have doesn't match.",
  "I-23": "A state check on a service with no built-in definition is a load error.",
  "I-71":
    "Global watch lets owner-rule and default-deny outcomes run; it never relaxes org rules or fail-closed denies.",
  "I-72": "A `watch: true` rule never decides a call.",
  // D10a: looks_like detector (module level; D10b proves the hide path)
  "I-44":
    "When the looks_like classifier errors, times out, isn't loaded or is unsure, the verdict is `uncertain` (hidden), never `no_match`.",
  // D3: decision pipeline and counts
  "I-24": "A count sums items, not calls, and includes the current call.",
  "I-25": "A `per: hour` count ignores the run id.",
  "I-26": "A call with no run id never matches a `per: run` condition.",
  "I-51":
    "Re-sending the identical call joins its pending request: the hash is stable when keys are reordered.",
  "I-52": "A call that differs in any argument, the account or the tool is a separate request.",
  // D8a: CLI sandbox core (D8b adds the `heel run` enforcement proofs)
  "I-30": "No shell runs a command: `sh -c …` is matched as `sh`, never as its inner command.",
  "I-31": "Every command form that prints a credential is classified as such, in any flag order.",
  "I-32": "Flags are parsed before matching, in any position.",
  "I-34": "The agent can't swap the binary or read the credential environment.",
};
