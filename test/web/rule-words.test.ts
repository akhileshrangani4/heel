import { describe, expect, it } from "vitest";
import { hideInWords, ruleInWords } from "../../src/web/ui/rule-words.ts";

/** A rule as heel writes it; `then` is the rules file's own key. */
function rule(match: Record<string, unknown>, decision: "allow" | "ask" | "deny") {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
  return { match, then: decision };
}

describe("a proposed rule in plain words (roadmap 2.3)", () => {
  it("says who may do what, where, and that it won't ask", () => {
    expect(
      ruleInWords(
        rule({ agent: "claude-code", account: "github", action: "github.issue.create" }, "allow"),
      ),
    ).toBe("claude-code may open a GitHub issue on github without asking you.");
    expect(ruleInWords(rule({ kind: "read" }, "allow"))).toBe(
      "Any of your agents may read anything on any of your accounts without asking you.",
    );
    expect(ruleInWords(rule({}, "ask"))).toBe(
      "heel asks you before any of your agents can do anything on any of your accounts.",
    );
  });

  it("names recipients, repos, checks, amounts and counts in words", () => {
    expect(
      ruleInWords(
        rule({ action: "email.send", recipients: { all_domain_in: ["work.com"] } }, "allow"),
      ),
    ).toBe(
      "Any of your agents may send an email on any of your accounts only to people at work.com, without asking you.",
    );
    expect(
      ruleInWords(
        rule(
          {
            action: "email.send",
            recipients: { any_domain_in: ["gmail.com"] },
            items: { over: 5, per: "hour" },
          },
          "deny",
        ),
      ),
    ).toBe(
      "Any of your agents can't send an email on any of your accounts when anyone it goes to is at gmail.com and that's more than 5 in an hour: heel refuses it.",
    );
    expect(
      ruleInWords(
        rule(
          {
            action: { one_of: ["github.merge", "github.push"] },
            repo: "acme/web",
            checks: "passing",
          },
          "allow",
        ),
      ),
    ).toBe(
      "Any of your agents may merge a pull request or push to a GitHub repository on any of your accounts in acme/web once the pull request's required checks pass, without asking you.",
    );
    expect(
      ruleInWords(
        rule(
          { account: "stripe", action: "stripe.refund", amount: { max: 50 }, currency: "usd" },
          "allow",
        ),
      ),
    ).toBe(
      "Any of your agents may refund a Stripe payment on stripe of at most 50 in usd, without asking you.",
    );
  });

  it("spells out every key it has no words for, so no condition is left out", () => {
    const words = ruleInWords(
      rule(
        {
          agent: { matches: "^ci-" },
          account: { matches: "^gh-" },
          action: "github.read",
          "args.force": true,
          "query.per_page": { max: 100 },
        },
        "allow",
      ),
    );
    expect(words).toBe(
      "Any of your agents may do github.read when the agent matches /^ci-/, account matches /^gh-/, args.force is true and query.per_page is at most 100, without asking you.",
    );
  });

  it("says a hide entry only takes email away", () => {
    expect(hideInWords({ email: { looks_like: ["password_reset", "login_code"] } })).toBe(
      "Hide email that looks like a password reset or a login code from every agent.",
    );
    expect(
      hideInWords({
        email: { from: { any_domain_in: ["bank.com"] }, subject: { matches: "statement" } },
      }),
    ).toBe(
      "Hide email from anyone at bank.com and whose subject matches /statement/ from every agent.",
    );
  });
});
