import { describe, expect, it } from "vitest";
import type { RuleFacts } from "../../src/core/rules/facts.ts";
import { allowedBy, facts, oneRule, ruleSet, run } from "./helpers.ts";

/**
 * Table tests per operator (spec: Rules, "How a match is decided"). Each row
 * is a one-rule file that allows on `match`; anything else falls to the
 * default deny, so "allowed" means "the rule matched".
 */

interface Row {
  name: string;
  match: string;
  call: RuleFacts;
  matches: boolean;
}

function table(rows: readonly Row[]) {
  it.each(rows)("$name", ({ match, call, matches }) => {
    expect(allowedBy(match, call)).toBe(matches);
  });
}

const rcpt = (...recipients: string[]) => facts({ action: "email.send", recipients });
const args = (value: unknown) => facts({ tool: "send_message", args: value });

describe("equals", () => {
  table([
    { name: "scalar shorthand", match: "{ account: gmail-work }", call: facts(), matches: true },
    {
      name: "explicit equals",
      match: "{ account: { equals: gmail-work } }",
      call: facts(),
      matches: true,
    },
    {
      name: "case-sensitive on text",
      match: "{ account: Gmail-Work }",
      call: facts(),
      matches: false,
    },
    {
      name: "addresses compare lower-cased",
      match: "{ recipients: { equals: [Bob@Vendor.com] } }",
      call: rcpt("bob@VENDOR.COM"),
      matches: true,
    },
    {
      name: "on a list: the set equals the given set, in any order",
      match: "{ recipients: { equals: [a@x.com, b@y.com] } }",
      call: rcpt("b@y.com", "a@x.com"),
      matches: true,
    },
    {
      name: "on a list: a subset is not equal",
      match: "{ recipients: { equals: [a@x.com, b@y.com] } }",
      call: rcpt("a@x.com"),
      matches: false,
    },
    {
      name: "on a list: a scalar equals a one-element list",
      match: "{ recipients: a@x.com }",
      call: rcpt("a@x.com"),
      matches: true,
    },
    {
      name: "on a list: a scalar never equals a longer list",
      match: "{ recipients: a@x.com }",
      call: rcpt("a@x.com", "b@y.com"),
      matches: false,
    },
    {
      name: "empty list: matches equals []",
      match: "{ argv: { equals: [] } }",
      call: facts({ cli: { command: "true", flags: {}, argv: [] } }),
      matches: true,
    },
    {
      name: "empty list: a scalar doesn't equal it",
      match: "{ recipients: a@x.com }",
      call: rcpt(),
      matches: false,
    },
  ]);
});

describe("one_of", () => {
  table([
    {
      name: "single value in the set",
      match: "{ repo: { one_of: [acme/web, acme/api] } }",
      call: facts({ repo: "acme/web" }),
      matches: true,
    },
    {
      name: "single value not in the set",
      match: "{ repo: { one_of: [acme/web, acme/api] } }",
      call: facts({ repo: "acme/docs" }),
      matches: false,
    },
    {
      name: "list: every element in the set",
      match: "{ recipients: { one_of: [a@x.com, b@x.com] } }",
      call: rcpt("a@x.com", "b@x.com"),
      matches: true,
    },
    {
      name: "list: one element outside the set fails",
      match: "{ recipients: { one_of: [a@x.com, b@x.com] } }",
      call: rcpt("a@x.com", "c@x.com"),
      matches: false,
    },
    {
      name: "empty list is false",
      match: "{ recipients: { one_of: [a@x.com] } }",
      call: rcpt(),
      matches: false,
    },
  ]);
});

describe("any_of", () => {
  table([
    {
      name: "single value: same as one_of",
      match: "{ repo: { any_of: [acme/web] } }",
      call: facts({ repo: "acme/web" }),
      matches: true,
    },
    {
      name: "single value outside the set",
      match: "{ repo: { any_of: [acme/web] } }",
      call: facts({ repo: "acme/api" }),
      matches: false,
    },
    {
      name: "list: at least one element in the set",
      match: "{ recipients: { any_of: [a@x.com] } }",
      call: rcpt("c@x.com", "a@x.com"),
      matches: true,
    },
    {
      name: "list: no element in the set",
      match: "{ recipients: { any_of: [a@x.com] } }",
      call: rcpt("c@x.com"),
      matches: false,
    },
    {
      name: "empty list is false",
      match: "{ recipients: { any_of: [a@x.com] } }",
      call: rcpt(),
      matches: false,
    },
  ]);
});

describe("matches", () => {
  table([
    {
      name: "the whole value matches",
      match: '{ tool: { matches: "send_.*" } }',
      call: facts({ tool: "send_message" }),
      matches: true,
    },
    {
      name: "anchored: a match inside the value isn't enough",
      match: '{ tool: { matches: "send_.*" } }',
      call: facts({ tool: "resend_message" }),
      matches: false,
    },
    {
      name: "case-sensitive unless (?i)",
      match: '{ tool: { matches: "SEND_.*" } }',
      call: facts({ tool: "send_message" }),
      matches: false,
    },
    {
      name: "(?i) folds case",
      match: '{ tool: { matches: "(?i)SEND_.*" } }',
      call: facts({ tool: "send_message" }),
      matches: true,
    },
    {
      name: "list: every element matches",
      match: '{ args.labels: { matches: "[A-Z]+" } }',
      call: args({ labels: ["INBOX", "SPAM"] }),
      matches: true,
    },
    {
      name: "list: one element that doesn't match fails",
      match: '{ args.labels: { matches: "[A-Z]+" } }',
      call: args({ labels: ["INBOX", "work"] }),
      matches: false,
    },
    {
      name: "empty list is false",
      match: '{ args.labels: { matches: ".*" } }',
      call: args({ labels: [] }),
      matches: false,
    },
    {
      name: "a non-string value never matches",
      match: '{ args.amount: { matches: ".*" } }',
      call: args({ amount: 5 }),
      matches: false,
    },
  ]);
});

describe("any_domain_in and all_domain_in", () => {
  table([
    {
      name: "any: one address in the set is enough",
      match: "{ recipients: { any_domain_in: [clientco.com, partner.io] } }",
      call: rcpt("me@company.com", "ceo@clientco.com"),
      matches: true,
    },
    {
      name: "any: no address in the set",
      match: "{ recipients: { any_domain_in: [clientco.com] } }",
      call: rcpt("me@company.com"),
      matches: false,
    },
    {
      name: "any: empty list is false",
      match: "{ recipients: { any_domain_in: [clientco.com] } }",
      call: rcpt(),
      matches: false,
    },
    {
      name: "all: every address in the set",
      match: "{ recipients: { all_domain_in: [company.com] } }",
      call: rcpt("a@company.com", "b@company.com"),
      matches: true,
    },
    {
      name: "all: one address outside fails",
      match: "{ recipients: { all_domain_in: [company.com] } }",
      call: rcpt("a@company.com", "b@clientco.com"),
      matches: false,
    },
    {
      name: "all: empty list is false, so unresolved recipients never pass vacuously",
      match: "{ recipients: { all_domain_in: [company.com] } }",
      call: rcpt(),
      matches: false,
    },
    {
      name: "a domain matches only itself, not its subdomains",
      match: "{ recipients: { any_domain_in: [clientco.com] } }",
      call: rcpt("a@mail.clientco.com"),
      matches: false,
    },
    {
      name: "*.domain matches subdomains",
      match: '{ recipients: { all_domain_in: ["*.clientco.com"] } }',
      call: rcpt("a@mail.clientco.com", "b@eu.mail.clientco.com"),
      matches: true,
    },
    {
      name: "*.domain doesn't match the bare domain",
      match: '{ recipients: { any_domain_in: ["*.clientco.com"] } }',
      call: rcpt("a@clientco.com"),
      matches: false,
    },
    {
      name: "domains compare case-insensitively",
      match: "{ recipients: { any_domain_in: [ClientCo.com] } }",
      call: rcpt("CEO@CLIENTCO.COM"),
      matches: true,
    },
    {
      name: "IDNA: a Unicode domain in the rule matches its punycode form",
      match: "{ recipients: { any_domain_in: [bücher.example] } }",
      call: rcpt("a@xn--bcher-kva.example"),
      matches: true,
    },
    {
      name: "IDNA: a Unicode address matches a punycode rule",
      match: "{ recipients: { any_domain_in: [xn--bcher-kva.example] } }",
      call: rcpt("a@bücher.example"),
      matches: true,
    },
    {
      name: "on an args value: a header-style list is read in full",
      match: "{ args.to: { all_domain_in: [company.com] } }",
      call: args({ to: 'a@company.com, "Doe, J" <j@company.com>' }),
      matches: true,
    },
    {
      name: "on an args list: an element whose path ran out has no domain",
      match: "{ args.to.address: { all_domain_in: [company.com] } }",
      call: args({ to: [{ address: "a@company.com" }, { name: "J" }] }),
      matches: false,
    },
  ]);
});

describe("max", () => {
  table([
    {
      name: "list: length at the limit",
      match: "{ recipients: { max: 2 } }",
      call: rcpt("a@x.com", "b@x.com"),
      matches: true,
    },
    {
      name: "list: length over the limit",
      match: "{ recipients: { max: 2 } }",
      call: rcpt("a@x.com", "b@x.com", "c@x.com"),
      matches: false,
    },
    {
      name: "empty list is true",
      match: "{ recipients: { max: 2 } }",
      call: rcpt(),
      matches: true,
    },
    {
      name: "number at the limit",
      match: "{ args.amount: { max: 100 } }",
      call: args({ amount: 100 }),
      matches: true,
    },
    {
      name: "number over the limit",
      match: "{ args.amount: { max: 100 } }",
      call: args({ amount: 100.5 }),
      matches: false,
    },
    {
      name: "a numeric string is not a number",
      match: "{ args.amount: { max: 100 } }",
      call: args({ amount: "5" }),
      matches: false,
    },
  ]);
});

describe("address normalization", () => {
  table([
    {
      name: "only the addr-spec is kept",
      match: "{ recipients: { one_of: [bob@vendor.com] } }",
      call: rcpt("Bob Smith <Bob@Vendor.com>"),
      matches: true,
    },
    {
      name: "a +tag stays as written",
      match: "{ recipients: { one_of: [user@x.com] } }",
      call: rcpt("user+tag@x.com"),
      matches: false,
    },
    {
      name: "a +tag in the rule matches the same tag",
      match: "{ recipients: { one_of: [user+tag@x.com] } }",
      call: rcpt("User+Tag@x.com"),
      matches: true,
    },
  ]);

  it("denies the call when a recipient doesn't parse, even under a catch-all allow", () => {
    const evaluation = run(
      ruleSet({ owner: oneRule("{}") }),
      rcpt("ceo@clientco.com", "not an address"),
    );
    expect(evaluation.verdict).toMatchObject({ decision: "deny", reason: "address_unparseable" });
  });

  it("denies the call when an address check meets a value that isn't an address", () => {
    const evaluation = run(
      ruleSet({ owner: oneRule("{ args.to: { any_domain_in: [company.com] } }") }),
      args({ to: "nobody" }),
    );
    expect(evaluation.verdict).toMatchObject({ decision: "deny", reason: "address_unparseable" });
  });
});

describe("combining conditions", () => {
  table([
    {
      name: "every key must hold (AND)",
      match: "{ action: email.send, account: gmail-personal }",
      call: rcpt("a@x.com"),
      matches: false,
    },
    {
      name: "every key holds",
      match: "{ action: email.send, account: gmail-work }",
      call: rcpt("a@x.com"),
      matches: true,
    },
    {
      name: "operators on one key are ANDed",
      match: "{ recipients: { all_domain_in: [company.com], max: 1 } }",
      call: rcpt("a@company.com", "b@company.com"),
      matches: false,
    },
    { name: "an empty match matches every call", match: "{}", call: facts(), matches: true },
  ]);
});

describe("absent fields", () => {
  const absent: readonly Omit<Row, "matches">[] = [
    {
      name: "recipients on a GitHub call, even with max (true on an empty list)",
      match: "{ recipients: { max: 5 } }",
      call: facts({ account: "github", action: "github.merge", repo: "acme/web" }),
    },
    {
      name: "kind on a tool no built-in definition describes",
      match: "{ kind: read }",
      call: facts({ provider: "mcp:notes", tool: "list_notes" }),
    },
    {
      name: "repo on an email call",
      match: "{ repo: { matches: '.*' } }",
      call: rcpt("a@x.com"),
    },
    {
      name: "args path that isn't there",
      match: "{ args.to: { max: 5 } }",
      call: args({ cc: ["a@x.com"] }),
    },
    {
      name: "args path through a non-object",
      match: "{ args.to.address: { matches: '.*' } }",
      call: args({ to: "a@x.com" }),
    },
    {
      name: "args path to an inherited property",
      match: "{ args.constructor: { matches: '.*' } }",
      call: args({}),
    },
    {
      name: "argv on a call that isn't a CLI call",
      match: "{ argv: { max: 10 } }",
      call: facts(),
    },
    {
      name: "flags on a CLI call that didn't pass the flag",
      match: "{ flags.namespace: prod }",
      call: facts({ cli: { command: "kubectl", verb: "get", flags: {}, argv: ["get", "pods"] } }),
    },
    {
      name: "query on a call that isn't HTTP",
      match: "{ query.state: open }",
      call: facts(),
    },
    {
      name: "body when the body couldn't be parsed",
      match: "{ body.amount: { max: 100 } }",
      call: facts({ http: { method: "POST", path: "/v1/refunds", query: {} } }),
    },
  ];

  it("I-18: a check on an absent field doesn't match, whatever the operator", () => {
    for (const { name, match, call } of absent) {
      const evaluation = run(ruleSet({ owner: oneRule(match) }), call);
      expect(evaluation.verdict, name).toMatchObject({
        decision: "deny",
        reason: "no_rule_matched",
      });
    }
  });
});

describe("dotted paths", () => {
  const messages = (...ids: (string | null)[]) =>
    args({ messages: ids.map((id) => (id === null ? {} : { id })) });

  table([
    {
      name: "a path into an array checks every element",
      match: '{ args.messages.id: { one_of: ["1", "2"] } }',
      call: messages("1", "2"),
      matches: true,
    },
    {
      name: "one element outside the set fails one_of",
      match: '{ args.messages.id: { one_of: ["1"] } }',
      call: messages("1", "2"),
      matches: false,
    },
    {
      name: "any_of finds one element",
      match: '{ args.messages.id: { any_of: ["2"] } }',
      call: messages("1", "2"),
      matches: true,
    },
    {
      name: "an element missing the path fails an every-element check",
      match: '{ args.messages.id: { one_of: ["1"] } }',
      call: messages("1", null),
      matches: false,
    },
    {
      name: "an array at the end of the path is a list",
      match: "{ args.to: { max: 1 } }",
      call: args({ to: ["a@x.com", "b@x.com"] }),
      matches: false,
    },
    {
      name: "a boolean value",
      match: "{ args.draft: true }",
      call: args({ draft: true }),
      matches: true,
    },
  ]);
});

describe("CLI and HTTP fields", () => {
  const kubectl = (argv: string[], flags: Record<string, string | true>) =>
    facts({
      account: "prod",
      cli: { command: "kubectl", verb: argv[0] ?? "", flags, argv },
    });
  const http = (fields: Partial<NonNullable<RuleFacts["http"]>>) =>
    facts({ http: { method: "GET", path: "/", query: {}, ...fields } });

  table([
    {
      name: "command and verb",
      match: "{ command: kubectl, verb: { one_of: [get, describe, logs] } }",
      call: kubectl(["get", "pods"], {}),
      matches: true,
    },
    {
      name: "a flag's value",
      match: "{ command: kubectl, verb: delete, flags.namespace: prod }",
      call: kubectl(["delete", "pod", "x"], { namespace: "prod" }),
      matches: true,
    },
    {
      name: "a flag without a value",
      match: "{ flags.force: true }",
      call: kubectl(["delete", "pod", "x"], { force: true }),
      matches: true,
    },
    {
      name: "raw argv for any CLI",
      match: "{ argv: { any_of: [--force] } }",
      call: kubectl(["delete", "pod", "x", "--force"], { force: true }),
      matches: true,
    },
    {
      name: "path matches the template when one matched",
      match: '{ method: PUT, path: "/repos/{o}/{r}/pulls/{n}/merge" }',
      call: http({
        method: "PUT",
        path: "/repos/acme/web/pulls/7/merge",
        pathTemplate: "/repos/{o}/{r}/pulls/{n}/merge",
      }),
      matches: true,
    },
    {
      name: "path is the literal path when no template matched",
      match: "{ path: /v1/charges }",
      call: http({ path: "/v1/charges" }),
      matches: true,
    },
    {
      name: "a query parameter",
      match: "{ query.state: open }",
      call: http({ query: { state: "open" } }),
      matches: true,
    },
    {
      name: "a repeated query parameter is a list",
      match: "{ query.label: { any_of: [urgent] } }",
      call: http({ query: { label: ["bug", "urgent"] } }),
      matches: true,
    },
    {
      name: "a body path",
      match: "{ method: POST, body.amount: { max: 5000 } }",
      call: http({ method: "POST", path: "/v1/refunds", body: { amount: 2500 } }),
      matches: true,
    },
  ]);
});
