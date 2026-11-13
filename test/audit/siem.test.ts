import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  type AdminAlerts,
  isSiemBacklogged,
  SIEM_MAX_BACKOFF_MS,
  type SiemAlert,
  SiemSink,
  siemBackoffMs,
} from "../../src/audit/siem.ts";
import { loadConfig, resolveConfigSource } from "../../src/config/load.ts";
import type { SiemConfig } from "../../src/config/schema.ts";
import type { AuditEvent } from "../../src/core/audit.ts";
import { createLogger } from "../../src/log.ts";
import { startHeel } from "../../src/serve.ts";
import { advanceSiemCursor, appendAudit, readSiemCursor } from "../../src/store/audit.ts";
import { openStore } from "../../src/store/db.ts";
import { orgs } from "../../src/store/schema.ts";
import { encodeMasterKey, MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { captureLogger } from "../helpers/log.ts";
import { reopen, type TestStore, tempDir, testStore } from "../helpers/store.ts";

const T0 = new Date("2026-11-13T09:00:00.000Z");
// Generated per run so no credential-shaped literal lives in the repo.
const TOKEN = randomBytes(16).toString("hex");

type Mode = "up" | "down" | "hang" | "redirect";

interface Received {
  headers: IncomingHttpHeaders;
  lines: Array<{ id: number; [key: string]: unknown }>;
}

/** A loopback SIEM collector whose behaviour a test can switch. */
async function fakeSiem(): Promise<{
  url: URL;
  received: Received[];
  ids: () => number[];
  setMode: (mode: Mode) => void;
  redirectHits: () => number;
}> {
  let mode: Mode = "up";
  let redirectHits = 0;
  const received: Received[] = [];
  const listen = async (server: Server): Promise<URL> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`);
  };
  const elsewhere = await listen(
    createServer((req, res) => {
      redirectHits += 1;
      req.resume();
      res.end();
    }),
  );
  const url = await listen(
    createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        if (mode === "hang") return;
        if (mode === "down") {
          res.writeHead(503).end("unavailable");
          return;
        }
        if (mode === "redirect") {
          res.writeHead(307, { location: elsewhere.href }).end();
          return;
        }
        const lines = body
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line));
        received.push({ headers: req.headers, lines });
        res.writeHead(204).end();
      });
    }),
  );
  return {
    url,
    received,
    ids: () => received.flatMap((batch) => batch.lines.map((line) => line.id)),
    setMode: (next) => {
      mode = next;
    },
    redirectHits: () => redirectHits,
  };
}

function siemConfig(url: URL, overrides: Partial<SiemConfig> = {}): SiemConfig {
  return {
    url,
    auth: null,
    batchSize: 100,
    intervalMs: 5,
    timeoutMs: 2_000,
    backlogAlert: { rows: 10, ageMs: 15 * 60_000 },
    ...overrides,
  };
}

function denyEvent(t: Pick<TestStore, "orgId" | "ownerId">, n: number): AuditEvent {
  return {
    kind: "deny",
    call: {
      orgId: t.orgId,
      agentId: "agt_inboxbot",
      ownerId: t.ownerId,
      surface: "mcp",
      account: "gmail-work",
      provider: "gmail",
      tool: "trash",
      args: { id: `msg-${n}` },
      items: 1,
    },
    callHash: n.toString(16).padStart(64, "0"),
    rule: null,
    reason: "no rule matched",
  };
}

function appendRows(t: Pick<TestStore, "db" | "orgId" | "ownerId">, count: number): number[] {
  const ids: number[] = [];
  for (let n = 0; n < count; n++) ids.push(appendAudit(t.db, denyEvent(t, n), T0));
  return ids;
}

function recordAlerts(): AdminAlerts & { alerts: SiemAlert[] } {
  const alerts: SiemAlert[] = [];
  return { alerts, raise: (alert) => alerts.push(alert) };
}

function sink(
  t: TestStore,
  config: SiemConfig,
  extra: { alerts?: AdminAlerts; env?: Record<string, string>; now?: () => Date } = {},
): SiemSink {
  const created = new SiemSink({
    db: t.db,
    orgId: t.orgId,
    config,
    env: extra.env ?? {},
    log: createLogger("silent"),
    alerts: extra.alerts ?? recordAlerts(),
    now: extra.now ?? (() => T0),
  });
  onTestFinished(() => created.close());
  return created;
}

describe("siemBackoffMs", () => {
  it("doubles from the interval and caps at five minutes", () => {
    expect([1, 2, 3, 4].map((n) => siemBackoffMs(n, 5_000))).toEqual([
      5_000, 10_000, 20_000, 40_000,
    ]);
    expect(siemBackoffMs(10, 5_000)).toBe(SIEM_MAX_BACKOFF_MS);
    expect(siemBackoffMs(1_000, 5_000)).toBe(SIEM_MAX_BACKOFF_MS);
  });

  it("never waits less than the interval", () => {
    expect(siemBackoffMs(0, 5_000)).toBe(5_000);
    expect(siemBackoffMs(3, 10 * 60_000)).toBe(10 * 60_000);
  });
});

describe("isSiemBacklogged", () => {
  const threshold = { rows: 10, ageMs: 60_000 };

  it.each([
    [{ rows: 0, oldestAt: null }, false],
    [{ rows: 9, oldestAt: T0 }, false],
    [{ rows: 10, oldestAt: T0 }, true],
    [{ rows: 1, oldestAt: new Date(T0.getTime() - 60_000) }, true],
    [{ rows: 1, oldestAt: new Date(T0.getTime() - 59_999) }, false],
  ])("%j → %s", (backlog, expected) => {
    expect(isSiemBacklogged(backlog, threshold, T0)).toBe(expected);
  });
});

describe("SIEM sink delivery", () => {
  it("POSTs batches of JSON Lines in append order and advances the cursor", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    const ids = appendRows(t, 250);
    const s = sink(t, siemConfig(siem.url));

    expect(await s.deliverOnce()).toEqual({
      kind: "delivered",
      rows: 100,
      throughId: ids[99],
      more: true,
    });
    await s.deliverOnce();
    expect(await s.deliverOnce()).toMatchObject({ kind: "delivered", rows: 50, more: false });
    expect(await s.deliverOnce()).toEqual({ kind: "idle" });

    expect(siem.received.map((batch) => batch.lines.length)).toEqual([100, 100, 50]);
    expect(siem.ids()).toEqual(ids);
    expect(siem.received[0]?.headers["content-type"]).toBe("application/x-ndjson");
    expect(siem.received[0]?.lines[0]).toMatchObject({ kind: "deny", args: { id: "msg-0" } });
    expect(readSiemCursor(t.db, t.orgId, siem.url.href)).toBe(ids.at(-1));
  });

  it("keeps its cursor across a restart and never re-sends acknowledged rows", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    const first = appendRows(t, 3);
    await sink(t, siemConfig(siem.url)).deliverOnce();

    const restarted = reopen(t);
    const second = appendRows(restarted, 2);
    await sink(restarted, siemConfig(siem.url)).deliverOnce();
    expect(siem.ids()).toEqual([...first, ...second]);
  });

  it("never moves the cursor backwards", () => {
    const t = testStore();
    advanceSiemCursor(t.db, t.orgId, "https://siem.example/", 40, T0);
    advanceSiemCursor(t.db, t.orgId, "https://siem.example/", 12, T0);
    expect(readSiemCursor(t.db, t.orgId, "https://siem.example/")).toBe(40);
  });

  it("sends the token from the environment with its scheme", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    appendRows(t, 1);
    const config = siemConfig(siem.url, {
      auth: { header: "Authorization", scheme: "Bearer", tokenFile: join(t.dir, "absent") },
    });
    await sink(t, config, { env: { HEEL_SIEM_TOKEN: TOKEN } }).deliverOnce();
    expect(siem.received[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends nothing and keeps the rows when the token is unavailable", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    appendRows(t, 1);
    const config = siemConfig(siem.url, {
      auth: { header: "X-Api-Key", scheme: "", tokenFile: join(t.dir, "absent") },
    });
    const outcome = await sink(t, config).deliverOnce();
    expect(outcome).toMatchObject({ kind: "failed" });
    if (outcome.kind === "failed") expect(outcome.error).toMatch(/^token unavailable: /);
    expect(siem.received).toEqual([]);
    expect(readSiemCursor(t.db, t.orgId, siem.url.href)).toBe(0);
  });

  it("treats a redirect as a failure and never follows it", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    appendRows(t, 1);
    siem.setMode("redirect");
    const config = siemConfig(siem.url, {
      auth: { header: "Authorization", scheme: "Bearer", tokenFile: join(t.dir, "absent") },
    });
    const outcome = await sink(t, config, { env: { HEEL_SIEM_TOKEN: TOKEN } }).deliverOnce();
    expect(outcome.kind).toBe("failed");
    expect(siem.redirectHits()).toBe(0);
    expect(readSiemCursor(t.db, t.orgId, siem.url.href)).toBe(0);
  });

  it("gives up on a hung sink after the timeout", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    appendRows(t, 1);
    siem.setMode("hang");
    const outcome = await sink(t, siemConfig(siem.url, { timeoutMs: 100 })).deliverOnce();
    expect(outcome).toEqual({ kind: "failed", error: "timeout" });
  });
});

describe("SIEM outage", () => {
  it("doesn't block or lose audit rows, alerts once, and clears on recovery", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    const recorder = recordAlerts();
    const s = sink(t, siemConfig(siem.url, { batchSize: 4 }), { alerts: recorder });
    const before = appendRows(t, 3);
    await s.deliverOnce();

    siem.setMode("down");
    // Decisions keep writing audit rows while the sink is down.
    const during = appendRows(t, 12);
    expect(await s.deliverOnce()).toEqual({ kind: "failed", error: "HTTP 503" });
    await s.deliverOnce();
    expect(recorder.alerts).toEqual([
      {
        kind: "siem_backlog",
        sink: siem.url.href,
        pendingRows: 12,
        oldestPendingAgeMs: 0,
        lastError: "HTTP 503",
      },
    ]);
    expect(readSiemCursor(t.db, t.orgId, siem.url.href)).toBe(before.at(-1));

    siem.setMode("up");
    const after = appendRows(t, 1);
    for (let i = 0; i < 4; i++) await s.deliverOnce();
    expect(siem.ids()).toEqual([...before, ...during, ...after]);
    expect(recorder.alerts.at(-1)).toEqual({ kind: "siem_backlog_cleared", sink: siem.url.href });
    expect(recorder.alerts).toHaveLength(2);
  });

  it("alerts on age even when few rows are waiting", async () => {
    const t = testStore();
    const recorder = recordAlerts();
    // Nothing listens on port 9 on loopback: every delivery fails to connect.
    const config = siemConfig(new URL("http://127.0.0.1:9/ingest"));
    let now = T0;
    const s = sink(t, config, { alerts: recorder, now: () => now });
    appendRows(t, 1);
    await s.deliverOnce();
    expect(recorder.alerts).toEqual([]);

    now = new Date(T0.getTime() + config.backlogAlert.ageMs);
    const outcome = await s.deliverOnce();
    expect(outcome.kind).toBe("failed");
    expect(recorder.alerts).toMatchObject([
      { kind: "siem_backlog", pendingRows: 1, oldestPendingAgeMs: config.backlogAlert.ageMs },
    ]);
  });

  it("never writes the token to the log or into an alert", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    siem.setMode("down");
    const { logger, output } = captureLogger();
    const recorder = recordAlerts();
    const config = siemConfig(siem.url, {
      intervalMs: 5,
      backlogAlert: { rows: 1, ageMs: 60_000 },
      auth: { header: "Authorization", scheme: "Bearer", tokenFile: join(t.dir, "absent") },
    });
    const s = new SiemSink({
      db: t.db,
      orgId: t.orgId,
      config,
      env: { HEEL_SIEM_TOKEN: TOKEN },
      log: logger,
      alerts: recorder,
    });
    appendRows(t, 2);
    s.start();
    await expect.poll(() => output()).toContain("SIEM delivery failed");
    await s.close();
    expect(output()).not.toContain(TOKEN);
    expect(JSON.stringify(recorder.alerts)).not.toContain(TOKEN);
  });
});

describe("SIEM sink loop", () => {
  it("drains a large backlog in back-to-back batches, then stops on close", async () => {
    const siem = await fakeSiem();
    const t = testStore();
    const ids = appendRows(t, 35);
    const s = sink(t, siemConfig(siem.url, { batchSize: 10, intervalMs: 60_000 }));
    s.start();
    // A 60 s interval: only immediate follow-ups after a full batch can drain 35 rows in time.
    await expect.poll(() => siem.ids().length).toBe(35);
    await s.close();
    expect(siem.ids()).toEqual(ids);

    appendRows(t, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(siem.ids()).toHaveLength(35);
  });

  it("is started by heel serve, and serve boots while the sink is down", async () => {
    const siem = await fakeSiem();
    siem.setMode("down");
    const home = tempDir("heel-siem-");
    writeFileSync(
      join(home, "heel.yaml"),
      [
        "admin_socket: run/admin.sock",
        "listen:",
        "  agent: 127.0.0.1:0",
        "  human: 127.0.0.1:0",
        "audit:",
        "  siem:",
        `    url: ${siem.url.href}`,
        "    interval_seconds: 0.01",
        "",
      ].join("\n"),
    );
    const env = { HEEL_HOME: home, [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)) };
    const config = loadConfig(resolveConfigSource(env, undefined));
    const heel = await startHeel({ config, env, log: createLogger("silent"), version: "test" });
    onTestFinished(() => heel.close());
    expect(heel.planes.agent.state).toBe("listening");

    const store = openStore(config.databasePath);
    onTestFinished(() => store.close());
    const org = store.db.select().from(orgs).get();
    if (!org) throw new Error("heel serve created no org");
    const ids = appendRows({ db: store.db, orgId: org.id, ownerId: "usr_x" }, 3);

    siem.setMode("up");
    // Backoff after the 503s is short (10 ms doubling), so delivery resumes quickly.
    await expect.poll(() => siem.ids(), { timeout: 5_000 }).toEqual(ids);
    await heel.close();
  });
});
