import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import { AUDIT_EXPORT_MAX_PAGE, parseAdminRequest } from "../../src/admin/protocol.ts";
import { exportAuditPage } from "../../src/audit/export.ts";
import { auditExportRecord, auditJsonLine } from "../../src/audit/jsonl.ts";
import { type CliIo, EXIT, main, parseExportTime } from "../../src/cli/main.ts";
import { loadConfig, resolveConfigSource } from "../../src/config/load.ts";
import type { AuditEvent } from "../../src/core/audit.ts";
import type { Call } from "../../src/core/call.ts";
import { createLogger } from "../../src/log.ts";
import { startHeel } from "../../src/serve.ts";
import { appendAudit, readAuditPage } from "../../src/store/audit.ts";
import { openStore } from "../../src/store/db.ts";
import { orgs } from "../../src/store/schema.ts";
import { encodeMasterKey, MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { type TestStore, tempDir, testStore } from "../helpers/store.ts";

const T0 = new Date("2026-11-13T09:00:00.000Z");

function call(orgId: string, ownerId: string, n: number): Call {
  return {
    orgId,
    agentId: "agt_inboxbot",
    ownerId,
    runId: "run-1",
    surface: "mcp",
    account: "gmail-work",
    provider: "gmail",
    tool: "trash",
    args: { id: `msg-${n}` },
    action: "email.remove",
    kind: "write",
    items: 1,
  };
}

function denyEvent(orgId: string, ownerId: string, n: number): AuditEvent {
  return {
    kind: "deny",
    call: call(orgId, ownerId, n),
    callHash: n.toString(16).padStart(64, "0"),
    rule: null,
    reason: "no rule matched",
  };
}

/** Appends `count` deny rows, one second apart from `start`. Returns their ids. */
function appendRows(
  t: Pick<TestStore, "db" | "orgId" | "ownerId">,
  count: number,
  start = T0,
): number[] {
  const ids: number[] = [];
  for (let n = 0; n < count; n++) {
    ids.push(
      appendAudit(t.db, denyEvent(t.orgId, t.ownerId, n), new Date(start.getTime() + n * 1_000)),
    );
  }
  return ids;
}

/** Drains an export the way the CLI does, page by page. */
function drain(
  t: TestStore,
  window: { since?: Date; until?: Date } = {},
  limit = AUDIT_EXPORT_MAX_PAGE,
): { lines: string[]; pages: number } {
  const lines: string[] = [];
  let afterId = 0;
  let throughId: number | undefined;
  for (let pages = 1; ; pages++) {
    const page = exportAuditPage(t.db, t.orgId, {
      ...window,
      afterId,
      limit,
      ...(throughId === undefined ? {} : { throughId }),
    });
    lines.push(...page.lines);
    if (page.done) return { lines, pages };
    afterId = page.nextAfterId;
    throughId = page.throughId;
  }
}

describe("audit JSONL format", () => {
  it("has a fixed key set, ISO timestamps and explicit nulls", () => {
    const t = testStore();
    const [id] = appendRows(t, 1);
    const [row] = readAuditPage(t.db, {
      orgId: t.orgId,
      afterId: 0,
      throughId: Number.MAX_SAFE_INTEGER,
      limit: 1,
    });
    if (!row) throw new Error("expected a row");
    const line = auditJsonLine(row);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed)).toEqual([
      "id",
      "at",
      "kind",
      "orgId",
      "agentId",
      "ownerId",
      "runId",
      "surface",
      "account",
      "provider",
      "tool",
      "action",
      "args",
      "callHash",
      "rule",
      "approvalId",
      "standingApprovalId",
      "approverId",
      "pauseScope",
      "reason",
    ]);
    expect(parsed).toMatchObject({
      id,
      at: "2026-11-13T09:00:00.000Z",
      kind: "deny",
      args: { id: "msg-0" },
      rule: null,
      approvalId: null,
      reason: "no rule matched",
    });
    expect(parsed).toEqual(auditExportRecord(row));
  });

  it("escapes newlines inside values so every row stays one line", () => {
    const t = testStore();
    appendAudit(t.db, {
      ...denyEvent(t.orgId, t.ownerId, 0),
      call: { ...call(t.orgId, t.ownerId, 0), args: { body: "line one\nline two\r\n" } },
    });
    const { lines } = drain(t);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split("\n")).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "").args.body).toBe("line one\nline two\r\n");
  });
});

describe("exportAuditPage", () => {
  it("pages through every row in append order, each exactly once", () => {
    const t = testStore();
    const ids = appendRows(t, 2_501);
    const { lines, pages } = drain(t);
    expect(pages).toBe(3);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(ids);
  });

  it("returns done with no lines on an empty log", () => {
    const t = testStore();
    expect(exportAuditPage(t.db, t.orgId, { afterId: 0, limit: 10 })).toEqual({
      lines: [],
      throughId: 0,
      nextAfterId: 0,
      done: true,
    });
  });

  it("pins its snapshot: rows appended mid-export are not included", () => {
    const t = testStore();
    const ids = appendRows(t, 5);
    const first = exportAuditPage(t.db, t.orgId, { afterId: 0, limit: 2 });
    expect(first.throughId).toBe(ids.at(-1));
    appendRows(t, 3, new Date(T0.getTime() + 60_000));
    const rest = exportAuditPage(t.db, t.orgId, {
      afterId: first.nextAfterId,
      throughId: first.throughId,
      limit: 100,
    });
    const exported = [...first.lines, ...rest.lines].map((line) => JSON.parse(line).id);
    expect(exported).toEqual(ids);
    expect(rest.done).toBe(true);
  });

  it("filters on since (inclusive) and until (exclusive)", () => {
    const t = testStore();
    const ids = appendRows(t, 10);
    const { lines } = drain(
      t,
      { since: new Date(T0.getTime() + 3_000), until: new Date(T0.getTime() + 7_000) },
      2,
    );
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(ids.slice(3, 7));
  });

  it("exports only the requested org's rows", () => {
    const t = testStore();
    const otherOrg = "org_other";
    t.db.insert(orgs).values({ id: otherOrg, name: "other", createdAt: new Date() }).run();
    const ours = appendRows(t, 2);
    appendRows({ db: t.db, orgId: otherOrg, ownerId: "usr_other" }, 3);
    expect(drain(t).lines.map((line) => JSON.parse(line).id)).toEqual(ours);
  });
});

describe("audit.export admin request", () => {
  it("defaults to the first page at the maximum size", () => {
    const parsed = parseAdminRequest('{"method":"audit.export"}');
    expect(parsed).toEqual({
      ok: true,
      request: {
        method: "audit.export",
        params: { afterId: 0, limit: AUDIT_EXPORT_MAX_PAGE },
      },
    });
  });

  it.each([
    ['{"method":"audit.export","params":{"limit":1001}}', "params.limit"],
    ['{"method":"audit.export","params":{"since":"yesterday"}}', "params.since"],
    ['{"method":"audit.export","params":{"afterId":-1}}', "params.afterId"],
    ['{"method":"audit.export","params":{"sql":"1"}}', "params"],
  ])("rejects %s", (line, field) => {
    const parsed = parseAdminRequest(line);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response).toMatchObject({ ok: false, error: { code: "bad_request" } });
    if (!parsed.response.ok) expect(parsed.response.error.message).toContain(field);
  });

  it("answers with a page of JSON Lines", async () => {
    const t = testStore();
    const ids = appendRows(t, 3);
    const handle = createAdminHandler({ db: t.db, orgId: t.orgId, vault: null, version: "test" });
    const response = await handle({
      method: "audit.export",
      params: { afterId: 0, limit: 3, since: new Date(T0.getTime() + 1_000).toISOString() },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { throughId: ids[2], nextAfterId: ids[2], done: true },
    });
    if (!response.ok) return;
    const { lines } = response.result as { lines: string[] };
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(ids.slice(1));
  });
});

describe("parseExportTime", () => {
  const now = new Date("2026-11-13T12:00:00.000Z");

  it.each([
    ["90m", "2026-11-13T10:30:00.000Z"],
    ["24h", "2026-11-12T12:00:00.000Z"],
    ["7d", "2026-11-06T12:00:00.000Z"],
    ["2026-11-01", "2026-11-01T00:00:00.000Z"],
    ["2026-11-13T09:30:00+02:00", "2026-11-13T07:30:00.000Z"],
    ["2026-11-13T09:30:00Z", "2026-11-13T09:30:00.000Z"],
  ])("reads %s", (text, iso) => {
    expect(parseExportTime(text, now)).toBe(iso);
  });

  it.each(["yesterday", "7w", "-1d", "2026-02-30", "2026-11-13T09:30:00", ""])(
    "refuses %j",
    (text) => {
      expect(parseExportTime(text, now)).toBeNull();
    },
  );
});

describe("heel audit export", () => {
  interface Run {
    code: number;
    stdout: string;
    stderr: string;
  }

  async function run(argv: string[], env: Record<string, string>): Promise<Run> {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      env,
      stdin: (async function* () {})(),
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
    };
    return { code: await main(argv, io), stdout, stderr };
  }

  /** Boots heel in a temp HEEL_HOME and opens a second handle on its database. */
  async function serve(): Promise<{ env: Record<string, string>; t: TestStore }> {
    const home = tempDir("heel-audit-export-");
    writeFileSync(
      join(home, "heel.yaml"),
      "admin_socket: run/admin.sock\nlisten:\n  agent: 127.0.0.1:0\n  human: 127.0.0.1:0\n",
    );
    const env = { HEEL_HOME: home, [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)) };
    const config = loadConfig(resolveConfigSource(env, undefined));
    const heel = await startHeel({ config, env, log: createLogger("silent"), version: "test" });
    onTestFinished(() => heel.close());
    const store = openStore(config.databasePath);
    onTestFinished(() => store.close());
    const org = store.db.select().from(orgs).get();
    if (!org) throw new Error("heel serve created no org");
    return {
      env,
      t: {
        dir: home,
        path: config.databasePath,
        store,
        db: store.db,
        orgId: org.id,
        ownerId: "usr_x",
      },
    };
  }

  it("streams every row across pages as JSON Lines on stdout", async () => {
    const { env, t } = await serve();
    const ids = appendRows(t, AUDIT_EXPORT_MAX_PAGE + 5);
    const result = await run(["audit", "export"], env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const lines = result.stdout.split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(ids);
    expect(result.stdout).toBe(drain(t).lines.join(""));
  });

  it("applies --since and --until", async () => {
    const { env, t } = await serve();
    const ids = appendRows(t, 5);
    const result = await run(
      ["audit", "export", "--since", "2026-11-13T09:00:01Z", "--until", "2026-11-13T09:00:03Z"],
      env,
    );
    expect(result.code).toBe(EXIT.ok);
    const exported = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line).id);
    expect(exported).toEqual(ids.slice(1, 3));
  });

  it("writes nothing for an empty window", async () => {
    const { env, t } = await serve();
    appendRows(t, 2);
    const result = await run(["audit", "export", "--since", "1h"], env);
    expect(result).toEqual({ code: EXIT.ok, stdout: "", stderr: "" });
  });

  it.each([
    [["audit", "export", "--format", "csv"], "--format"],
    [["audit", "export", "--since", "last week"], "--since"],
    [["audit", "list"], "audit subcommand"],
  ])("exits 64 on %j", async (argv, message) => {
    const result = await run(argv, { HEEL_HOME: tempDir() });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain(message);
  });

  it("exits 69 when heel serve is not running", async () => {
    const home = tempDir();
    writeFileSync(join(home, "heel.yaml"), "admin_socket: run/admin.sock\n");
    const result = await run(["audit", "export"], { HEEL_HOME: home });
    expect(result.code).toBe(EXIT.unavailable);
  });
});
