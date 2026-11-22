import { describe, expect, it } from "vitest";
import type { Call } from "../../src/core/call.ts";
import { type DecidedCall, learnRules, MAX_LEARNED } from "../../src/core/learning.ts";
import type { RuleSet } from "../../src/core/rules/evaluate.ts";
import { OWNER, ruleSet } from "../rules/helpers.ts";

/**
 * Roadmap 2.10 (Avi, Nov 20 and 22): 5 decisions on at least 2 days make a
 * suggestion; a suggested rule names its agent and is never wider than
 * what was decided.
 */

const RULES = `rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: everything-else-asks
    match: {}
    then: ask
`;

const NOW = new Date("2026-11-22T12:00:00Z");
const THRESHOLD = { decisions: 5, days: 2 };

function askedBy(set: RuleSet) {
  const rule = set.owners.get(OWNER)?.rules.find((r) => r.decision === "ask");
  if (rule === undefined) throw new Error("no ask rule");
  return rule;
}

type CallOverrides = { [K in keyof Call]?: Call[K] | undefined };

/** A call; an override of `undefined` leaves that field out. */
function call(overrides: CallOverrides = {}): Call {
  const full = {
    orgId: "org",
    agentId: "agt_bot",
    ownerId: "usr_alice",
    surface: "mcp",
    account: "github",
    provider: "github",
    tool: "create_issue",
    action: "github.issue.create",
    kind: "write",
    repo: "acme/web",
    args: { repo: "acme/web", title: "x" },
    items: 1,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(full).filter(([, v]) => v !== undefined),
  ) as unknown as Call;
}

/** `n` decisions, one every `hoursApart` hours back from NOW. */
function decided(
  set: RuleSet,
  n: number,
  opts: { decision?: "approved" | "denied"; hoursApart?: number; call?: CallOverrides } = {},
): DecidedCall[] {
  return Array.from({ length: n }, (_, i) => ({
    agentName: "claude-code",
    decision: opts.decision ?? "approved",
    at: new Date(NOW.getTime() - (i + 1) * (opts.hoursApart ?? 12) * 3600_000),
    call: call(opts.call),
    askedBy: askedBy(set),
  }));
}

describe("learning from what you approve (2.10)", () => {
  it("suggests an allow for the agent, account, action and repo after 5 approvals on 2 days", () => {
    const set = ruleSet({ owner: RULES });
    const [learned, ...rest] = learnRules(decided(set, 5), {
      owner: OWNER,
      rules: set,
      threshold: THRESHOLD,
      now: NOW,
    });
    expect(rest).toEqual([]);
    expect(learned?.rule).toEqual({
      match: {
        agent: "claude-code",
        account: "github",
        action: "github.issue.create",
        tool: "create_issue",
        persistence: false,
        repo: "acme/web",
      },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
      then: "allow",
    });
    expect(learned?.evidence).toMatch(
      /^approved 5 times on 3 days since Nov 20, all in acme\/web$/,
    );
  });

  it("needs the decisions spread over enough days, so one burst earns nothing", () => {
    const set = ruleSet({ owner: RULES });
    const burst = decided(set, 8, { hoursApart: 0.1 });
    expect(learnRules(burst, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW })).toEqual(
      [],
    );
    expect(
      learnRules(decided(set, 4), { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW }),
    ).toEqual([]);
  });

  it("counts days in UTC, so two approvals either side of midnight are two days", () => {
    const set = ruleSet({ owner: RULES });
    const at = (iso: string): DecidedCall => ({
      ...(decided(set, 1)[0] as DecidedCall),
      at: new Date(iso),
    });
    const calls = [
      at("2026-11-21T23:50:00Z"),
      at("2026-11-21T23:55:00Z"),
      at("2026-11-22T00:05:00Z"),
      at("2026-11-22T00:10:00Z"),
      at("2026-11-22T00:15:00Z"),
    ];
    expect(
      learnRules(calls, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW }),
    ).toHaveLength(1);
    const sameDay = calls.map((c) => ({ ...c, at: new Date("2026-11-22T01:00:00Z") }));
    expect(
      learnRules(sameDay, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW }),
    ).toEqual([]);
  });

  it("forgets decisions older than 30 days", () => {
    const set = ruleSet({ owner: RULES });
    const old = decided(set, 5).map((d) => ({
      ...d,
      at: new Date(d.at.getTime() - 31 * 86400_000),
    }));
    expect(learnRules(old, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW })).toEqual(
      [],
    );
  });

  it("never suggests an allow that would cover a call you denied", () => {
    const set = ruleSet({ owner: RULES });
    const calls = [...decided(set, 6), ...decided(set, 1, { decision: "denied" })];
    expect(learnRules(calls, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW })).toEqual(
      [],
    );
  });

  it("keeps sends to the domains they went to, and drops the allow if a denied send fits", () => {
    const set = ruleSet({ owner: RULES });
    const send = {
      account: "gmail",
      provider: "gmail",
      tool: "send_email",
      action: "email.send",
      repo: undefined,
      recipients: ["ann@work.com"],
    } satisfies CallOverrides;
    const sends = decided(set, 5, { call: send });
    const [learned] = learnRules(sends, {
      owner: OWNER,
      rules: set,
      threshold: THRESHOLD,
      now: NOW,
    });
    expect(learned?.rule.match["recipients"]).toEqual({ equals: ["ann@work.com"] });
    expect(learned?.evidence).toMatch(/all to ann@work\.com$/);

    // A denied send to gmail.com is outside it; one to work.com isn't.
    const elsewhere = decided(set, 1, {
      decision: "denied",
      call: { ...send, recipients: ["x@gmail.com"] },
    });
    expect(
      learnRules([...sends, ...elsewhere], {
        owner: OWNER,
        rules: set,
        threshold: THRESHOLD,
        now: NOW,
      }),
    ).toHaveLength(1);
    const inside = decided(set, 1, { decision: "denied", call: send });
    expect(
      learnRules([...sends, ...inside], {
        owner: OWNER,
        rules: set,
        threshold: THRESHOLD,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("doesn't suggest an allow with nothing to narrow it (any arguments), but does a deny", () => {
    const set = ruleSet({ owner: RULES });
    const refund = {
      account: "stripe",
      provider: "stripe",
      tool: "refund",
      action: "stripe.refund",
      repo: undefined,
    } satisfies CallOverrides;
    expect(
      learnRules(decided(set, 5, { call: refund }), {
        owner: OWNER,
        rules: set,
        threshold: THRESHOLD,
        now: NOW,
      }),
    ).toEqual([]);
    const [deny] = learnRules(decided(set, 5, { call: refund, decision: "denied" }), {
      owner: OWNER,
      rules: set,
      threshold: THRESHOLD,
      now: NOW,
    });
    expect(deny?.rule).toEqual({
      match: {
        agent: "claude-code",
        account: "stripe",
        action: "stripe.refund",
        tool: "refund",
        persistence: false,
      },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
      then: "deny",
    });
    expect(deny?.evidence).toMatch(/^denied 5 times/);
  });

  it("keeps each agent's decisions to that agent", () => {
    const set = ruleSet({ owner: RULES });
    const mine = decided(set, 3);
    const other = decided(set, 3).map((d) => ({
      ...d,
      agentName: "inbox-bot",
      call: { ...d.call, agentId: "agt_other" },
    }));
    expect(
      learnRules([...mine, ...other], { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW }),
    ).toEqual([]);
  });

  it("skips what the rule that asked guards with a count or a state check, or a rule that's gone", () => {
    const counted = ruleSet({
      owner: `rules:
  - match: { action: github.issue.create, items: { over: 3, per: hour } }
    then: ask
  - match: {}
    then: ask
`,
    });
    const calls = decided(counted, 5).map((d) => ({
      ...d,
      askedBy: counted.owners.get(OWNER)?.rules[0] ?? null,
    }));
    expect(
      learnRules(calls, { owner: OWNER, rules: counted, threshold: THRESHOLD, now: NOW }),
    ).toEqual([]);
    const set = ruleSet({ owner: RULES });
    const gone = decided(set, 5).map((d) => ({ ...d, askedBy: null }));
    expect(learnRules(gone, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW })).toEqual(
      [],
    );
  });

  it("drops what your rules already decide, what you dismissed, and keeps to a few", () => {
    const set = ruleSet({ owner: RULES });
    const covered = ruleSet({
      owner: `rules:\n  - match: { action: github.issue.create }\n    then: allow\n${RULES.slice("rules:\n".length)}`,
    });
    expect(
      learnRules(decided(set, 5), { owner: OWNER, rules: covered, threshold: THRESHOLD, now: NOW }),
    ).toEqual([]);

    const [learned] = learnRules(decided(set, 5), {
      owner: OWNER,
      rules: set,
      threshold: THRESHOLD,
      now: NOW,
    });
    expect(
      learnRules(decided(set, 5), {
        owner: OWNER,
        rules: set,
        threshold: THRESHOLD,
        now: NOW,
        skip: new Set([learned?.kindKey ?? ""]),
      }),
    ).toEqual([]);

    const many = Array.from({ length: 8 }, (_, i) =>
      decided(set, 5, { call: { repo: `acme/r${i}` } }),
    ).flat();
    expect(
      learnRules(many, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW }),
    ).toHaveLength(MAX_LEARNED);
  });

  it("keeps the rule that asked's conditions and goes right before it", () => {
    const set = ruleSet({
      owner: `rules:
  - match: { action: github.issue.create, args.labels: { one_of: [bug] } }
    then: ask
  - match: {}
    then: ask
`,
    });
    const asker = set.owners.get(OWNER)?.rules[0];
    if (asker === undefined) throw new Error("no rule");
    const calls = decided(set, 5, { call: { args: { labels: ["bug"] } } }).map((d) => ({
      ...d,
      askedBy: asker,
    }));
    const [learned] = learnRules(calls, {
      owner: OWNER,
      rules: set,
      threshold: THRESHOLD,
      now: NOW,
    });
    expect(learned?.before).toBe(asker.hash);
    expect(learned?.rule.match).toEqual({
      "args.labels": { one_of: ["bug"] },
      action: "github.issue.create",
      agent: "claude-code",
      account: "github",
      tool: "create_issue",
      persistence: false,
      repo: "acme/web",
    });
  });

  it("allows events with no one invited only as events with no one invited", () => {
    const set = ruleSet({ owner: RULES });
    const event = {
      account: "gcal",
      provider: "gcal",
      tool: "create_event",
      action: "calendar.event.create",
      repo: undefined,
      calendar: "me@x.com",
      recipients: [],
    } satisfies CallOverrides;
    const [learned] = learnRules(decided(set, 5, { call: event }), {
      owner: OWNER,
      rules: set,
      threshold: THRESHOLD,
      now: NOW,
    });
    expect(learned?.rule.match["recipients"]).toEqual({ max: 0 });
    expect(learned?.evidence).toMatch(/with no one invited or addressed$/);
    // Events that did invite someone are another group: 4 plain and 1 with a guest earn nothing.
    const mixed = [
      ...decided(set, 4, { call: event }),
      ...decided(set, 1, { call: { ...event, recipients: ["x@evil.com"] } }),
    ];
    expect(learnRules(mixed, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW })).toEqual(
      [],
    );
  });

  it("doesn't let one approval to another domain widen the rest, and names personal addresses", () => {
    const set = ruleSet({ owner: RULES });
    const send = {
      account: "gmail",
      provider: "gmail",
      tool: "send_email",
      action: "email.send",
      repo: undefined,
      recipients: ["boss@work.com"],
    } satisfies CallOverrides;
    const mixed = [
      ...decided(set, 4, { call: send }),
      ...decided(set, 1, { call: { ...send, recipients: ["friend@gmail.com"] } }),
    ];
    expect(learnRules(mixed, { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW })).toEqual(
      [],
    );
    const [personal] = learnRules(
      decided(set, 5, { call: { ...send, recipients: ["friend@gmail.com"] } }),
      { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW },
    );
    expect(personal?.rule.match["recipients"]).toEqual({ equals: ["friend@gmail.com"] });
  });

  it("gives the same kind key whatever the recipients, so a dismissal holds", () => {
    const set = ruleSet({ owner: RULES });
    const send = {
      account: "gmail",
      provider: "gmail",
      tool: "send_email",
      action: "email.send",
      repo: undefined,
    } satisfies CallOverrides;
    const learn = (to: string) =>
      learnRules(decided(set, 5, { call: { ...send, recipients: [to] } }), {
        owner: OWNER,
        rules: set,
        threshold: THRESHOLD,
        now: NOW,
      })[0];
    const a = learn("x@work.com");
    const b = learn("y@corp.io");
    expect(a?.key).not.toBe(b?.key);
    expect(a?.kindKey).toBe(b?.kindKey);
  });

  it("never learns from calls that outlive heel, and a suggestion for sends doesn't cover a forward", () => {
    const set = ruleSet({ owner: RULES });
    const filter = {
      account: "gmail",
      provider: "gmail",
      tool: "create_filter",
      action: "email.send",
      repo: undefined,
      recipients: ["bob@work.com"],
      persistence: true,
    } satisfies CallOverrides;
    expect(
      learnRules(decided(set, 5, { call: filter }), {
        owner: OWNER,
        rules: set,
        threshold: THRESHOLD,
        now: NOW,
      }),
    ).toEqual([]);

    const [send] = learnRules(
      decided(set, 5, { call: { ...filter, tool: "send_email", persistence: undefined } }),
      { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW },
    );
    expect(send?.rule.match["persistence"]).toBe(false);
  });

  it("doesn't suggest a deny while a standing approval lets those calls through", () => {
    const set = ruleSet({ owner: RULES });
    const calls = decided(set, 5, { decision: "denied" });
    const input = { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW };
    expect(learnRules(calls, input)).toHaveLength(1);
    expect(learnRules(calls, { ...input, standing: () => true })).toEqual([]);
  });

  it("keeps one agent's suggestions from crowding out another's, when asked for one agent", () => {
    const set = ruleSet({ owner: RULES });
    const busy = Array.from({ length: MAX_LEARNED }, (_, i) =>
      decided(set, 6, { call: { repo: `acme/r${i}` } }),
    ).flat();
    const other = decided(set, 5, { call: { agentId: "agt_other", repo: "acme/other" } }).map(
      (d) => ({
        ...d,
        agentName: "other-bot",
      }),
    );
    const input = { owner: OWNER, rules: set, threshold: THRESHOLD, now: NOW };
    expect(learnRules([...busy, ...other], input).some((l) => l.agentId === "agt_other")).toBe(
      false,
    );
    const [mine] = learnRules([...busy, ...other], { ...input, agentId: "agt_other" });
    expect(mine?.agentName).toBe("other-bot");
    // An agent may see only what heel drew from its own calls, never the asking rule's conditions.
    expect(Object.keys(mine?.own ?? {}).sort()).toEqual(
      ["account", "action", "agent", "persistence", "repo", "tool"].sort(),
    );
  });
});
