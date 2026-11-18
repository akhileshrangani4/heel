import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../../src/definitions/registry.ts";
import { addAgent } from "../../../src/gateway/agents.ts";
import { createPipeline } from "../../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../../src/store/pauses.ts";
import { KEY_BYTES } from "../../../src/vault/crypto.ts";
import { Vault } from "../../../src/vault/vault.ts";
import { captureLogger } from "../../helpers/log.ts";
import { compileRules } from "../../helpers/pipeline.ts";
import { addAccount, testStore } from "../../helpers/store.ts";

/** The Linear definition (D12b) through the real pipeline, against a fake GraphQL API. */

const KEY = "lin_api_test_key_not_real";
const ENG_ISSUE = "11111111-1111-4111-8111-111111111111";
const OPS_ISSUE = "22222222-2222-4222-8222-222222222222";
const ENG_TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Sent {
  query: string;
  variables: Record<string, unknown>;
  auth: string | null;
}

function fakeLinear(
  options: { refuse?: boolean; children?: Record<string, unknown[]>; moveAfterRead?: boolean } = {},
) {
  let reads = 0;
  const sent: Sent[] = [];
  const issues: Record<string, unknown> = {
    [ENG_ISSUE]: {
      id: ENG_ISSUE,
      identifier: "ENG-1",
      title: "a",
      team: { id: ENG_TEAM, key: "ENG" },
      project: null,
    },
    "ENG-1": {
      id: ENG_ISSUE,
      identifier: "ENG-1",
      title: "a",
      team: { id: ENG_TEAM, key: "ENG" },
      project: null,
    },
    [OPS_ISSUE]: {
      id: OPS_ISSUE,
      identifier: "OPS-7",
      title: "b",
      team: { id: "t2", key: "OPS" },
      project: { id: "44444444-4444-4444-8444-444444444444", name: "Infra" },
    },
  };
  const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    sent.push({ ...body, auth: new Headers(init?.headers).get("authorization") });
    const q = body.query;
    if (q.startsWith("query Children(")) {
      const nodes = options.children?.[String(body.variables["id"])] ?? [];
      return Response.json({
        data: { issue: { children: { nodes, pageInfo: { hasNextPage: false } } } },
      });
    }
    if (q.startsWith("query Issue(")) {
      reads++;
      const issue = issues[String(body.variables["id"])];
      if (options.moveAfterRead === true && reads > 1 && issue !== undefined) {
        return Response.json({
          data: { issue: { ...(issue as object), team: { id: "t9", key: "OPS" } } },
        });
      }
      return issue === undefined
        ? Response.json({ data: { issue: null }, errors: [{ message: "Entity not found: Issue" }] })
        : Response.json({ data: { issue } });
    }
    if (q.startsWith("query Team(")) {
      const key = body.variables["key"];
      return Response.json({
        data: { teams: { nodes: key === "ENG" ? [{ id: ENG_TEAM, key: "ENG" }] : [] } },
      });
    }
    if (q.startsWith("mutation")) {
      if (options.refuse === true) {
        return Response.json({ data: null, errors: [{ message: "Argument Validation Error" }] });
      }
      const name = /\{\s*(\w+)\(/.exec(q.slice(q.indexOf("{")))?.[1] ?? "x";
      return Response.json({
        data: {
          [name]: { success: true, issue: issues[ENG_ISSUE], comment: { id: "c1", url: "u" } },
        },
      });
    }
    return Response.json({ data: null, errors: [{ message: "unknown" }] });
  };
  return { fetch, sent };
}

function setUp(owner: string, linear = fakeLinear()) {
  const t = testStore();
  const accountId = addAccount(t, "linear", "linear");
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "static", value: KEY });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      linear: { vault, fetch: linear.fetch },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const { agentId } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "bot" },
    new Date(),
  );
  const agent = { orgId: t.orgId, agentId, agentName: "bot", ownerId: t.ownerId, tokenId: "tok_1" };
  const call = (tool: string, args: Record<string, unknown>) =>
    pipeline.run({ agent, surface: "mcp", account: "linear", tool, args });
  return { call, sent: linear.sent };
}

const ENG_ONLY = `rules:
  - match: { action: linear.comment, team: ENG }
    then: allow
  - match: { action: linear.issue.create, team: ENG }
    then: allow
  - match: { action: linear.issue.delete }
    then: ask
`;

const mutations = (sent: Sent[]) => sent.filter((s) => s.query.startsWith("mutation"));

describe("the Linear definition", () => {
  it("comments on an issue in an allowed team, on the id it read, with the key as sent", async () => {
    const h = setUp(ENG_ONLY);
    const result = await h.call("add_comment", { issue: "ENG-1", body: "on it" });
    expect(result.status).toBe("allowed");
    expect(mutations(h.sent)[0]?.variables).toEqual({
      input: { issueId: ENG_ISSUE, body: "on it" },
    });
    expect(h.sent[0]?.auth).toBe(KEY);
  });

  it("denies a comment in a team the rule doesn't name", async () => {
    const h = setUp(ENG_ONLY);
    expect((await h.call("add_comment", { issue: OPS_ISSUE, body: "x" })).status).toBe("denied");
    expect(mutations(h.sent)).toEqual([]);
  });

  it("creates an issue in a team it resolves by key", async () => {
    const h = setUp(ENG_ONLY);
    const result = await h.call("create_issue", { team: "eng", title: "Fix it" });
    expect(result.status).toBe("allowed");
    expect(mutations(h.sent)[0]?.variables).toEqual({
      input: { teamId: ENG_TEAM, title: "Fix it" },
    });
  });

  it("denies a team that doesn't exist as not available", async () => {
    const h = setUp(ENG_ONLY);
    expect(await h.call("create_issue", { team: "NOPE", title: "x" })).toMatchObject({
      status: "denied",
      reason: "not_available",
    });
  });

  it("asks before a delete, and denies an issue that isn't there", async () => {
    const h = setUp(ENG_ONLY);
    expect((await h.call("delete_issue", { issue: "ENG-1" })).status).toBe("pending");
    expect(await h.call("delete_issue", { issue: "ENG-999" })).toMatchObject({
      reason: "not_available",
    });
  });

  it("lets a rule name the project", async () => {
    const h = setUp(
      `rules:\n  - match: { action: linear.issue.update, project: 44444444-4444-4444-8444-444444444444 }\n    then: allow\n`,
    );
    expect((await h.call("update_issue", { issue: OPS_ISSUE, title: "t" })).status).toBe("allowed");
    expect((await h.call("update_issue", { issue: ENG_ISSUE, title: "t" })).status).toBe("denied");
  });

  it("doesn't offer moving an issue to another team or project", async () => {
    const h = setUp(ENG_ONLY);
    expect(await h.call("update_issue", { issue: "ENG-1", project_id: OPS_ISSUE })).toMatchObject({
      reason: "unsupported",
    });
  });

  it("reports Linear's refusal as an upstream error", async () => {
    const h = setUp(ENG_ONLY, fakeLinear({ refuse: true }));
    expect(await h.call("add_comment", { issue: "ENG-1", body: "x" })).toMatchObject({
      status: "upstream_error",
      upstreamStatus: 400,
    });
  });

  it("refuses a delete that would trash a sub-issue in another team", async () => {
    const h = setUp(
      "rules:\n  - match: { action: linear.issue.delete }\n    then: allow\n",
      fakeLinear({
        children: { [ENG_ISSUE]: [{ id: OPS_ISSUE, team: { key: "OPS" }, project: null }] },
      }),
    );
    expect(await h.call("delete_issue", { issue: "ENG-1" })).toMatchObject({
      reason: "unsupported",
    });
    expect(mutations(h.sent)).toEqual([]);
  });

  it("counts sub-issues in the same team as items of the delete", async () => {
    const child = "33333333-3333-4333-8333-333333333333";
    const h = setUp(
      "rules:\n  - match: { action: linear.issue.delete, items: { over: 1 } }\n    then: deny\n  - match: { action: linear.issue.delete }\n    then: allow\n",
      fakeLinear({
        children: { [ENG_ISSUE]: [{ id: child, team: { key: "ENG" }, project: null }] },
      }),
    );
    expect((await h.call("delete_issue", { issue: "ENG-1" })).status).toBe("denied");
  });

  it("sends nothing when the issue moved after heel checked it", async () => {
    const h = setUp(ENG_ONLY, fakeLinear({ moveAfterRead: true }));
    expect(await h.call("add_comment", { issue: "ENG-1", body: "x" })).toMatchObject({
      status: "upstream_error",
    });
    expect(mutations(h.sent)).toEqual([]);
  });

  it("matches a team written in lower case", async () => {
    const h = setUp(
      "rules:\n  - match: { action: linear.comment, team: eng }\n    then: deny\n  - match: {}\n    then: allow\n",
    );
    expect((await h.call("add_comment", { issue: "ENG-1", body: "x" })).status).toBe("denied");
  });
});
