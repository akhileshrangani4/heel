import { describe, expect, it } from "vitest";
import { requestConnection } from "../../src/requests/connection.ts";
import { homePage } from "../../src/web/ui/home.ts";
import { NOW, PENDING_ROWS } from "../../src/web/ui/preview/fixtures.ts";
import { approvalHarness, pendingId, SEND } from "../helpers/approvals.ts";
import { dom } from "../helpers/dom.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/**
 * What waits for you, everywhere (section 4 of the setup notes): one count
 * of calls, connection requests, rule changes and recovery links drives the
 * menu badge, the tab title and Home; a stream keeps open pages current.
 */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");

function withConnectionRequest() {
  const h = humanPlaneHarness({ owner: ASK_SENDS });
  const asked = requestConnection(
    h.t.db,
    { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
    { service: "github", alias: "github", why: "to read pull requests" },
    h.clock.now,
  );
  if (!asked.ok) throw new Error(asked.problem);
  return { h, requestId: asked.requestId };
}

/** Reads the stream's first event, then hangs up. */
async function firstEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const first = await reader?.read();
  await reader?.cancel().catch(() => {});
  return new TextDecoder().decode(first?.value);
}

describe("the waiting count", () => {
  it("counts a connection request, which used to raise no count, in the badge, the title and Home", async () => {
    const { h, requestId } = withConnectionRequest();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/", { as: owner })).text();
    expect(page).toContain("<title>(1) Home · heel</title>");
    expect(page).toMatch(
      /class="nav-count" data-heel-count><span class="visually-hidden">, <\/span><span data-heel-count-n>1</,
    );
    expect(page).toContain(`href="/requests/${requestId}"`);
    expect(page).toContain(">Connect GitHub<");
    expect(page).toMatch(
      /class="home-wait-when muted"><span title="inbox-bot">inbox-bot<\/span> · /,
    );
  });

  it("adds calls and connection requests into one number", async () => {
    const { h } = withConnectionRequest();
    pendingId(await h.call({ args: SEND }));
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/activity", { as: owner })).text();
    expect(page).toContain("<title>(2) Activity · heel</title>");
    // Activity doesn't list what waits, so the banner shows there, as a link to Approvals.
    expect(page).toMatch(/<a id="heel-waiting" class="waiting-alert" href="\/approvals">/);
    expect(page).toContain("2 things need you");
  });

  it("keeps the title plain, the badge hidden and the banner hidden when nothing waits", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/activity", { as: owner })).text();
    expect(page).toContain("<title>Activity · heel</title>");
    expect(page).toContain('class="nav-count" data-heel-count hidden');
    expect(page).toMatch(/id="heel-waiting" class="waiting-alert" href="\/approvals" hidden/);
    // Approvals lists what waits, so it has no banner until the count changes while it's open.
    const approvals = await (await h.fetch("/approvals", { as: owner })).text();
    expect(approvals).not.toContain('id="heel-waiting"');
  });

  it("I-56: Home's waiting list only links to where each item is decided, with no controls", () => {
    const doc = dom(
      homePage({
        now: NOW,
        waiting: {
          counts: { calls: PENDING_ROWS.length, requests: 0, proposals: 0, recoveries: 0 },
          items: PENDING_ROWS.map((row) => ({
            kind: "call" as const,
            href: row.href,
            at: row.createdAt,
            expiresAt: row.expiresAt,
            headline: row.headline,
            service: { action: row.action, tool: row.tool, account: row.account },
          })),
        },
        agents: { total: 1, active: 1, expiring: 0 },
        connections: { total: 1, needsSignIn: 0 },
        rules: { loaded: true, count: 1, stopped: 0 },
        setup: { passkey: true, notifications: true, account: true, agent: true },
        days: [],
        recent: [],
      }),
    );
    const list = doc.querySelector(".home-wait");
    expect(list?.querySelectorAll("button, form, input")).toHaveLength(0);
    const hrefs = [...(list?.querySelectorAll("a.home-wait-row") ?? [])].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(PENDING_ROWS.map((r) => r.href));
    // Expiry shows only when close: one of the three ends in 8 minutes.
    expect(list?.querySelectorAll(".home-wait-soon")).toHaveLength(1);
  });
});

describe("keeping open pages current", () => {
  it("asks the browser to revalidate a page it restores", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    for (const path of ["/", "/approvals", "/connections"]) {
      const response = await h.fetch(path, { as: owner });
      expect({ path, cache: response.headers.get("cache-control") }).toEqual({
        path,
        cache: "no-cache",
      });
    }
  });

  it("streams the count and an opaque version only, to a signed-in owner", async () => {
    const { h, requestId } = withConnectionRequest();
    const id = pendingId(await h.call({ args: SEND }));
    const owner = await h.signIn(await h.enroll());
    const controller = new AbortController();
    const response = await h.fetch("/waiting/stream", { as: owner, signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toMatch(/no-(cache|store)/);
    const text = await firstEvent(response);
    controller.abort();
    expect(text).toContain("event: waiting");
    const data = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? "{}");
    expect(Object.keys(data).sort()).toEqual(["version", "waiting"]);
    expect(data.waiting).toBe(2);
    expect(data.version).toMatch(/^[0-9a-f]{16}$/);
    // Nothing about what waits: no ids, names, accounts or arguments.
    for (const secret of [id, requestId, "inbox-bot", "gmail-work", "github", "bob@"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("I-56: a decision from a stale page, on a request decided elsewhere or expired, is refused and changes nothing", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const approvedElsewhere = pendingId(await h.call({ args: SEND }));
    // Another device approves it; this page still shows it as waiting.
    expect(h.decide(approvedElsewhere, "approve")).toMatchObject({ ok: true });
    expect(h.decide(approvedElsewhere, "deny")).toEqual({ ok: false, reason: "not_pending" });
    expect(h.decide(approvedElsewhere, "approve")).toEqual({ ok: false, reason: "not_pending" });
    expect(h.status(approvedElsewhere)).toBe("approved");

    const expired = pendingId(await h.call({ args: { ...SEND, subject: "Q4" } }));
    h.clock.advance(25 * 60 * 60_000);
    expect(h.decide(expired, "approve")).toEqual({ ok: false, reason: "not_pending" });
    expect(h.status(expired)).not.toBe("approved");
  });

  it("sends nothing to someone signed out", async () => {
    const { h } = withConnectionRequest();
    const response = await h.fetch("/waiting/stream");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?next=%2Fwaiting%2Fstream");
    expect(await response.text()).not.toContain("waiting");
  });
});
