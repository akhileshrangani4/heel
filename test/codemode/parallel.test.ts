import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { approvals } from "../../src/store/schema.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * Code mode round 2, C4: a built-in account's reads have `_async` twins that
 * heel runs as futures, several at once, when the script awaits them. A twin
 * that would need approval can't wait for it: it raises PermissionError and
 * opens no request, so a gather can't open one per call.
 */

interface RunAnswer {
  status: string;
  stdout: string;
  output?: unknown;
  calls: { tool: string; decision: string }[];
  error: string | null;
}

function fakeGitHub() {
  const seen: string[] = [];
  let inFlight = 0;
  let mostAtOnce = 0;
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    seen.push(url.pathname);
    inFlight += 1;
    mostAtOnce = Math.max(mostAtOnce, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    const issue = /^\/repos\/acme\/web\/issues\/(\d+)$/.exec(url.pathname);
    if (issue !== null) {
      return Response.json({
        number: Number(issue[1]),
        title: `Issue ${issue[1]}`,
        state: "open",
        user: { login: "dev" },
        labels: [],
      });
    }
    return Response.json({}, { status: 404 });
  };
  return { fetch, seen, mostAtOnce: () => mostAtOnce };
}

async function setUp(rules: string) {
  const gh = fakeGitHub();
  const h = await mcpHarness({
    owner: rules,
    codeWorker: () => new MontyWorker(),
    github: { fetch: gh.fetch },
  });
  const client = await h.connect("/mcp");
  const run = async (code: string) =>
    (await client.callTool({ name: "run_code", arguments: { code } }))
      .structuredContent as RunAnswer;
  const stubs = async () =>
    (
      (await client.callTool({ name: "heel_stubs", arguments: {} })).content as { text: string }[]
    )[0]?.text ?? "";
  return { h, gh, run, stubs };
}

const READS = `rules:
  - match: { account: github, kind: read }
    then: allow
`;
const READS_ASK = `rules:
  - match: { account: github, kind: read }
    then: ask
`;

describe("parallel reads in code mode (C4)", () => {
  it("gives a built-in account's reads _async twins, and a passthrough account none", async () => {
    const { stubs } = await setUp(READS);
    const text = await stubs();
    expect(text).toContain("async def get_issue_async(");
    expect(text).toContain("asyncio.gather");
    // Writes get no twin.
    expect(text).not.toContain("create_issue_async");
    // The passthrough account (notes) doesn't either: its read hint is its own say-so.
    expect(text).not.toContain("search_notes_async");
  });

  it("runs awaited twins at once, through heel's rules, and hands each result back", async () => {
    const { gh, run } = await setUp(READS);
    const answer = await run(
      [
        "import asyncio",
        "import github",
        "issues = await asyncio.gather(*[github.get_issue_async(repo='acme/web', number=n) for n in (1, 2, 3)])",
        "[i['title'] for i in issues]",
      ].join("\n"),
    );
    expect(answer).toMatchObject({
      status: "completed",
      output: ["Issue 1", "Issue 2", "Issue 3"],
    });
    expect(answer.calls.map((c) => [c.tool, c.decision])).toEqual([
      ["get_issue", "allow"],
      ["get_issue", "allow"],
      ["get_issue", "allow"],
    ]);
    expect(gh.mostAtOnce()).toBeGreaterThan(1);
  });

  it("never runs a twin the script doesn't await", async () => {
    const { gh, run } = await setUp(READS);
    const answer = await run(
      "import github\nc = github.get_issue_async(repo='acme/web', number=1)\n'end'",
    );
    expect(answer).toMatchObject({ status: "completed", output: "end" });
    expect(gh.seen).toEqual([]);
  });

  it("refuses a twin that needs approval, opening no request, and says to make the plain call", async () => {
    const { h, gh, run } = await setUp(READS_ASK);
    const answer = await run(
      [
        "import asyncio",
        "import github",
        "try:",
        "    await asyncio.gather(github.get_issue_async(repo='acme/web', number=1), github.get_issue_async(repo='acme/web', number=2))",
        "except PermissionError as e:",
        "    print(e)",
      ].join("\n"),
    );
    expect(answer.status).toBe("completed");
    expect(answer.stdout).toContain(
      "needs approval, which a parallel call can't wait for; call get_issue() to ask",
    );
    expect(h.t.db.select().from(approvals).all()).toEqual([]);
    expect(gh.seen).toEqual([]);
  });

  it("keeps a per-run limit when reads run at once: past it, a twin is denied", async () => {
    const { h, run } = await setUp(`rules:
  - match: { account: github, items: { over: 2, per: run } }
    then: deny
  - match: { account: github, kind: read }
    then: allow
`);
    const client = await h.connect("/mcp");
    const answer = (
      await client.callTool({
        name: "run_code",
        arguments: {
          run_id: "run-1",
          code: [
            "import asyncio",
            "import github",
            "async def one(n):",
            "    try:",
            "        return (await github.get_issue_async(repo='acme/web', number=n))['number']",
            "    except PermissionError:",
            "        return 'denied'",
            "await asyncio.gather(*[one(n) for n in (1, 2, 3, 4)])",
          ].join("\n"),
        },
      })
    ).structuredContent as RunAnswer;
    expect(answer.status).toBe("completed");
    const out = answer.output as unknown[];
    expect(out.filter((v) => v === "denied")).toHaveLength(2);
    expect(out.filter((v) => typeof v === "number")).toHaveLength(2);
    void run;
  });
});
