import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { chromium, type Page } from "@playwright/test";
import { expect, it } from "vitest";
import { STARTER_RULES } from "../../src/cli/init.ts";
import { rulesPaths } from "../../src/config/rules.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { proposeRules } from "../../src/proposals/rules.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { createHumanApp } from "../../src/web/app.ts";
import { createEnrollment, Passkeys, relyingPartyFor } from "../../src/web/passkeys.ts";
import { FakeGmail, GMAIL_TEST_TOKEN } from "../../test/helpers/fake-gmail.ts";
import { TEST_VAPID_PUBLIC_KEY } from "../../test/helpers/human-plane.ts";
import { captureLogger } from "../../test/helpers/log.ts";
import { compileRules } from "../../test/helpers/pipeline.ts";
import { addAccount, testStore } from "../../test/helpers/store.ts";

/**
 * The screenshots in docs/images (`pnpm docs:screenshots`). heel's real web
 * app, the real Gmail and GitHub definitions in front of fake services, the
 * starter rules from `heel init`, and Chromium with a virtual passkey. Run it
 * after a UI change and commit the images with it.
 */

const OUT = join(import.meta.dirname, "..", "..", "docs", "images");
const GITHUB_TOKEN = "github-docs-token-not-real";
const HEAD = "c".repeat(40);

/** Just enough of GitHub's API for a pull request with green checks. */
async function fakeGitHub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input.toString());
  const method = init?.method ?? "GET";
  const p = url.pathname;
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${GITHUB_TOKEN}`) {
    return Response.json({}, { status: 401 });
  }
  if (method === "GET" && /^\/repos\/acme\/web\/pulls\/\d+$/.test(p)) {
    return Response.json({
      number: 42,
      title: "Fix the login redirect loop",
      state: "open",
      merged: false,
      head: { sha: HEAD, ref: "fix-login" },
      base: { ref: "main" },
      user: { login: "sam" },
      labels: [],
    });
  }
  if (method === "GET" && p.endsWith("/pulls")) {
    return Response.json([
      { number: 42, title: "Fix the login redirect loop", state: "open", user: { login: "sam" } },
    ]);
  }
  if (method === "GET" && p.endsWith("/check-runs")) {
    return Response.json({
      total_count: 1,
      check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
    });
  }
  if (method === "GET" && p.endsWith("/status")) {
    return Response.json({ state: "pending", total_count: 0, statuses: [] });
  }
  if (method === "GET" && p.endsWith("/check-suites")) {
    return Response.json({ total_count: 0, check_suites: [] });
  }
  if (method === "GET" && p.endsWith("/files")) {
    return Response.json(
      url.searchParams.get("page") === "1" ? [{ filename: "src/login.ts" }] : [],
    );
  }
  if (method === "GET" && p.includes("/rules/branches/")) return Response.json([]);
  if (method === "PUT" && p.endsWith("/merge"))
    return Response.json({ merged: true, sha: "d".repeat(40) });
  return Response.json({}, { status: 404 });
}

async function setUp() {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const gmail = new FakeGmail();
  vault.put(addAccount(t, "gmail-work", "gmail"), {
    type: "oauth",
    accessToken: GMAIL_TEST_TOKEN,
    refreshToken: "r",
  });
  vault.put(addAccount(t, "github", "github"), { type: "static", value: GITHUB_TOKEN });
  const { logger } = captureLogger();
  const rules = { set: compileRules({ owner: STARTER_RULES }) };
  const approvals = new SqliteApprovalStore();
  const pauses = new SqlitePauseStore();
  const pipeline = createPipeline({
    db: t.db,
    rules,
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: { vault, fetch: gmail.fetch },
      github: { vault, fetch: fakeGitHub },
    }),
    pauses,
    approvals,
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const { agentId } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "my-agent" },
    new Date(),
  );
  const agent = {
    orgId: t.orgId,
    agentId,
    agentName: "my-agent",
    ownerId: t.ownerId,
    tokenId: "tok_1",
    clientName: "claude-code",
  };
  const call = (account: string, tool: string, args: Record<string, unknown>, reason?: string) =>
    pipeline.run({
      agent,
      surface: "mcp",
      account,
      tool,
      args,
      ...(reason === undefined ? {} : { reason }),
    });

  const home = mkdtempSync(join(tmpdir(), "heel-docs-"));
  mkdirSync(rulesPaths(home).ownersDir);
  writeFileSync(join(rulesPaths(home).ownersDir, "owner.yaml"), STARTER_RULES);

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const publicUrl = new URL(`http://localhost:${port}`);
  const app = createHumanApp({
    db: t.db,
    orgId: t.orgId,
    log: logger,
    publicUrl,
    passkeys: new Passkeys(t.db, relyingPartyFor(publicUrl)),
    approvals,
    pauses,
    rules,
    vapidPublicKey: TEST_VAPID_PUBLIC_KEY,
    agentPublicUrl: null,
    upstreamOAuth: null,
    watchFallback: false,
    ruleFiles: { paths: rulesPaths(home), reload: () => {} },
    providerClients: { google: null, microsoft: null },
    now: () => new Date(),
  });
  server.on("request", getRequestListener(app.fetch));
  return { t, call, agentId, server, origin: publicUrl.origin };
}

/**
 * One screen as a person sees it: a phone shows the first screenful, with
 * the decision bar where it sits; a laptop shows the whole page.
 */
async function shoot(page: Page, name: string, { dark = false } = {}): Promise<void> {
  await page.waitForLoadState("networkidle");
  const phone = (page.viewportSize()?.width ?? 0) < 600;
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: !phone });
  // The README's phones follow the reader's theme, so these screens come in dark too.
  if (dark) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: join(OUT, `${name}-dark.png`), fullPage: !phone });
    await page.emulateMedia({ colorScheme: "light" });
  }
}

it("captures the docs screenshots", async () => {
  mkdirSync(OUT, { recursive: true });
  const { t, call, agentId, server, origin } = await setUp();
  const browser = await chromium.launch();
  try {
    // A phone: that is where most approvals happen.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    const link = createEnrollment(t.db, {
      orgId: t.orgId,
      userName: "owner",
      publicUrl: new URL(origin),
      now: new Date(),
    });
    await page.goto(link.url);
    await shoot(page, "enroll");
    await page.getByRole("button", { name: "Create a passkey" }).click();
    await page.waitForURL(/\/sign-in/);
    await shoot(page, "sign-in");
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(/\/approvals$/);

    // A read runs; a send and a merge wait for you.
    expect((await call("github", "list_pull_requests", { repo: "acme/web" })).status).toBe(
      "allowed",
    );
    const send = await call(
      "gmail-work",
      "send",
      {
        from: "alice@company.com",
        to: ["bob@vendor.com"],
        cc: ["dana@company.com"],
        subject: "Q3 invoice",
        body: "Hi Bob,\n\nAttached is the Q3 invoice we discussed. Let me know if anything looks off.\n\nThanks,\nAlice",
      },
      "Bob asked for the Q3 invoice in yesterday's thread",
    );
    const merge = await call(
      "github",
      "merge_pull_request",
      { repo: "acme/web", number: 42 },
      "The fix is reviewed and CI is green",
    );
    if (send.status !== "pending" || merge.status !== "pending") {
      throw new Error(`expected both to wait: ${send.status}, ${merge.status}`);
    }

    await page.goto(`${origin}/approvals`);
    await shoot(page, "approvals");
    await page.goto(`${origin}/approvals/${send.approvalId}`);
    await shoot(page, "approval-email", { dark: true });
    await page.goto(`${origin}/approvals/${merge.approvalId}`);
    await shoot(page, "approval-merge", { dark: true });
    await page.getByRole("button", { name: "Approve once" }).click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await shoot(page, "approval-approved");

    const proposed = proposeRules(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, agentId },
      {
        reason: "You've approved every vendor email this week",
        rules: [
          {
            rule: Object.fromEntries([
              ["name", "vendor-mail"],
              ["match", { action: "email.send", recipients: { all_domain_in: ["vendor.com"] } }],
              // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
              ["then", "allow"],
            ]),
            why: "so replies to vendor threads don't wait for you",
          },
        ],
      },
      new Date(),
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    await page.goto(`${origin}/proposals/${proposed.proposalId}`);
    await shoot(page, "proposal");

    await page.goto(`${origin}/pause`);
    await shoot(page, "pause");

    // The wider pages read better on a laptop.
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto(`${origin}/activity`);
    await shoot(page, "wide-activity");
    await page.goto(`${origin}/connections`);
    await shoot(page, "wide-connections");
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
