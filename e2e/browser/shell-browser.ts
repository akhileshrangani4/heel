import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, onTestFinished } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { createHumanApp } from "../../src/web/app.ts";
import { createEnrollment, Passkeys, relyingPartyFor } from "../../src/web/passkeys.ts";
import { createPreviewApp } from "../../src/web/ui/preview/app.ts";
import { approvalHarness } from "../../test/helpers/approvals.ts";
import { TEST_VAPID_PUBLIC_KEY } from "../../test/helpers/human-plane.ts";
import { captureLogger } from "../../test/helpers/log.ts";

/**
 * Shared setup for the shell pages' browser checks (Activity, sign-in,
 * enroll, dialogs, the passkey status): Chromium for the test file, the
 * preview harness, phone-sized pages, and a real heel with an owner who has
 * enrolled a passkey on a virtual authenticator.
 */

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function shellBrowser(): {
  /** Chromium, open for the whole test file. */
  browser(): Browser;
  /** The preview harness, served for this test; returns its origin. */
  preview(): Promise<string>;
  /** A touch phone page at `width`, closed when the test ends. */
  phone(width: number, theme?: "light" | "dark"): Promise<Page>;
  /** A real heel, signed in as an owner who just enrolled a passkey. */
  signedIn(): Promise<SignedIn>;
} {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  return {
    browser: () => browser,
    preview: () => listen(createServer(getRequestListener(createPreviewApp().fetch))),
    async phone(width, theme = "light") {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        hasTouch: true,
        isMobile: true,
        colorScheme: theme,
      });
      onTestFinished(() => context.close());
      return context.newPage();
    },
    async signedIn() {
      const h = approvalHarness({});
      h.clock.advance(Date.now() - h.clock.now.getTime());
      const home = mkdtempSync(join(tmpdir(), "heel-e2e-shell-"));
      mkdirSync(rulesPaths(home).ownersDir);
      const server = createServer();
      const origin = (await listen(server)).replace("127.0.0.1", "localhost");
      const publicUrl = new URL(origin);
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

      const context = await browser.newContext();
      onTestFinished(() => context.close());
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
      const link = createEnrollment(h.t.db, {
        orgId: h.t.orgId,
        userName: "owner",
        publicUrl,
        now: h.clock.now,
      });
      await page.goto(link.url);
      await page.getByRole("button", { name: "Create a passkey" }).click();
      await page.waitForURL(/\/welcome$/);
      return { h, publicUrl, context, page };
    },
  };
}

export interface SignedIn {
  h: ReturnType<typeof approvalHarness>;
  publicUrl: URL;
  context: BrowserContext;
  page: Page;
}
