import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { proposeRules } from "../../src/proposals/rules.ts";
import { createHumanApp } from "../../src/web/app.ts";
import { createEnrollment, Passkeys, relyingPartyFor } from "../../src/web/passkeys.ts";
import {
  type ApprovalHarness,
  approvalHarness,
  pendingId,
  SEND,
} from "../../test/helpers/approvals.ts";
import { TEST_VAPID_PUBLIC_KEY } from "../../test/helpers/human-plane.ts";
import { captureLogger } from "../../test/helpers/log.ts";
import { oneRule } from "../../test/helpers/pipeline.ts";

/**
 * The approval page in a real browser (spec: D4 tests): Chromium with a
 * virtual WebAuthn authenticator runs the page's own script for every
 * ceremony. A person enrolls from a one-time link, signs in, approves a
 * request, denies another, pauses and resumes an account, then adds the
 * rules an agent proposed.
 *
 * Set `HEEL_E2E_ARTIFACTS_DIR` to keep a screenshot of each step and a WebM
 * of the run.
 */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");

interface Running {
  h: ApprovalHarness;
  home: string;
  server: Server;
  origin: string;
}

/** The human plane on a loopback port, over an approval harness's store. */
async function startHumanPlane(): Promise<Running> {
  const h = approvalHarness({ owner: ASK_SENDS });
  const home = mkdtempSync(join(tmpdir(), "heel-e2e-rules-"));
  mkdirSync(rulesPaths(home).ownersDir);
  // The browser keeps real time (cookie expiry, WebAuthn), so the store's clock starts at now.
  h.clock.advance(Date.now() - h.clock.now.getTime());
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // WebAuthn needs a secure context; http://localhost is one, and is the RP ID.
  const publicUrl = new URL(`http://localhost:${port}`);
  const app = createHumanApp({
    db: h.t.db,
    orgId: h.t.orgId,
    log: captureLogger().logger,
    publicUrl,
    passkeys: new Passkeys(h.t.db, relyingPartyFor(publicUrl)),
    approvals: h.store,
    pauses: h.pauseStore,
    rules: h.rules,
    vapidPublicKey: TEST_VAPID_PUBLIC_KEY,
    agentPublicUrl: null,
    upstreamOAuth: null,
    watchFallback: false,
    ruleFiles: { paths: rulesPaths(home), reload: () => {} },
    providerClients: { google: null, microsoft: null },
    now: () => h.clock.now,
  });
  server.on("request", getRequestListener(app.fetch));
  return { h, server, origin: publicUrl.origin, home };
}

/** A page whose browser has a platform passkey authenticator that always verifies the user. */
async function pageWithAuthenticator(context: BrowserContext): Promise<Page> {
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
  return page;
}

describe("the approval page in a browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("enrolls, signs in, approves, denies, pauses and resumes with a passkey", async () => {
    // The harness's store cleans up when the test ends, so it starts inside the test.
    const { h, server, origin, home } = await startHumanPlane();
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const artifacts = process.env["HEEL_E2E_ARTIFACTS_DIR"];
    const context = await browser.newContext(
      artifacts ? { recordVideo: { dir: join(artifacts, "approval-page") } } : {},
    );
    const page = await pageWithAuthenticator(context);
    let step = 0;
    const shot = async (name: string) => {
      step += 1;
      if (artifacts) {
        const file = `${String(step).padStart(2, "0")}-${name}.png`;
        await page.screenshot({ path: join(artifacts, "approval-page", file), fullPage: true });
      }
    };

    // Enroll from the one-time link `heel user enroll` prints.
    const link = createEnrollment(h.t.db, {
      orgId: h.t.orgId,
      userName: "owner",
      publicUrl: new URL(origin),
      now: h.clock.now,
    });
    await page.goto(link.url);
    await shot("enroll");
    await page.getByRole("button", { name: "Create a passkey" }).click();
    // Making the passkey signs you in, on the page that turns on notifications (2.7).
    await page.waitForURL(/\/welcome$/);
    await page.getByRole("heading", { name: "Your passkey is ready" }).waitFor();
    await shot("welcome");

    // Sign out, then sign in with that passkey.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/sign-in/);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(/\/approvals$/);

    // An agent's send asks; the owner approves it once.
    const approved = pendingId(await h.call({ args: SEND }));
    await page.goto(`${origin}/approvals/${approved}`);
    // The address also sits in the closed Details fold, which comes first on the page.
    await page.getByText("bob@vendor.com").filter({ visible: true }).first().waitFor();
    await shot("request");

    // Opening a section is remembered in heel: it's still open after a reload.
    const args = page.locator('details[data-heel-fold="args"]');
    expect(await args.evaluate((d) => (d as { open: boolean }).open)).toBe(false);
    // The raw arguments sit in the main flow, under the email, one tap away (I-57).
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/approvals/folds") && (r.request().postData() ?? "").includes('"args"'),
    );
    await page.getByText("See raw arguments").click();
    expect((await saved).status()).toBe(200);
    await page.reload();
    expect(await args.evaluate((d) => (d as { open: boolean }).open)).toBe(true);
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect.poll(() => h.status(approved)).toBe("approved");
    await page.waitForLoadState("load");
    await shot("approved");
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });

    // Another send asks; the owner denies it.
    const denied = pendingId(await h.call({ args: { ...SEND, subject: "no" } }));
    await page.goto(`${origin}/approvals/${denied}`);
    await page.getByRole("button", { name: "Deny" }).click();
    await expect.poll(() => h.status(denied)).toBe("denied");
    await page.waitForLoadState("load");
    await shot("denied");

    // Pause the account with one tap; resuming asks for the passkey.
    await page.goto(`${origin}/pause`);
    await page.getByRole("switch", { name: /Pause .*gmail-work/ }).click();
    await page.waitForURL(/done=paused/);
    await shot("paused");
    expect(await h.call({ args: { ...SEND, subject: "while paused" } })).toMatchObject({
      status: "paused",
    });
    await page.getByRole("switch", { name: /Resume .*gmail-work/ }).click();
    await page.waitForURL(/done=resumed/);
    await shot("resumed");
    expect((await h.call({ args: { ...SEND, subject: "after resume" } })).status).toBe("pending");

    // The agent proposes a rule; the owner reads it and adds it with a passkey.
    const proposed = proposeRules(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      {
        rules: [
          {
            rule: Object.fromEntries([
              ["name", "vendor-mail"],
              ["match", { action: "email.send", recipients: { all_domain_in: ["vendor.com"] } }],
              // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
              ["then", "allow"],
            ]),
            why: "so I can answer the vendor thread",
          },
        ],
      },
      new Date(),
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    await page.goto(`${origin}/approvals`);
    await page.getByRole("link", { name: /proposes a new rule/ }).click();
    await page.getByText("so I can answer the vendor thread").first().waitFor();
    await shot("proposal");
    await page.getByRole("button", { name: "Add these rules" }).click();
    await page.waitForURL(/\?applied/);
    await shot("proposal-added");
    const written = readFileSync(join(rulesPaths(home).ownersDir, "owner.yaml"), "utf8");
    expect(written).toContain("name: vendor-mail");
    expect(written).toContain("# Proposed by");

    await context.close();
  });
});
