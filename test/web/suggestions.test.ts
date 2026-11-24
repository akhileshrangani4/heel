import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { learningDismissals, ruleProposals } from "../../src/store/schema.ts";
import { pendingId, SEND } from "../helpers/approvals.ts";
import type { SoftAuthenticator } from "../helpers/authenticator.ts";
import {
  attribute,
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
} from "../helpers/human-plane.ts";

/**
 * Roadmap 2.10 end to end: approving the same kind of request 5 times on 2
 * days puts a suggested rule on Approvals and Activity; reviewing it opens a
 * proposal heel drafted, which the owner adds with a passkey; dismissing it
 * stops it coming back.
 */

/** A deny above the rule that asks: a suggestion must not get past it. */
const RULES = `rules:
  - name: no-ceo
    match: { action: email.send, recipients: { any_of: [ceo@vendor.com] } }
    then: deny
  - name: sends-ask
    match: { action: email.send }
    then: ask
`;
const HOUR = 3600_000;

/** Approves `n` sends, 13 hours apart so they fall on different days; returns a signed-in browser. */
async function approveSends(
  h: HumanPlaneHarness,
  owner: SoftAuthenticator,
  n: number,
): Promise<Browser> {
  let as = await h.signIn(owner);
  for (let i = 0; i < n; i++) {
    const approvalId = pendingId(
      await h.call({ args: { ...SEND, subject: `Q${h.clock.now.getTime()}` } }),
    );
    const callHash = h.audit().find((row) => row.approvalId === approvalId)?.callHash ?? "";
    const done = await h.ceremony(
      as,
      { url: `/approvals/${approvalId}/challenge`, body: { callHash, intent: "approve" } },
      `/approvals/${approvalId}/decide`,
    );
    expect(done.status).toBe(200);
    // Moving the clock ends the session, so sign in again.
    h.clock.advance(13 * HOUR);
    as = await h.signIn(owner);
  }
  return as;
}

async function setUp(
  learning: { decisions: number; days: number } | null = { decisions: 5, days: 2 },
) {
  const home = mkdtempSync(join(tmpdir(), "heel-learn-"));
  const dir = rulesPaths(home).ownersDir;
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.yaml"), RULES);
  const h = humanPlaneHarness({ owner: RULES, rulesHome: home, learning });
  const passkey = await h.enroll();
  return { h, passkey, home };
}

function keyOn(page: string): string {
  const key = /\/suggestions\/([0-9a-f]+)\/propose/.exec(page)?.[1];
  if (key === undefined) throw new Error("no suggestion on the page");
  return key;
}

describe("suggested rules from what you approve (2.10)", () => {
  it("suggests nothing until the 5th approval, then on Approvals and Activity", async () => {
    const { h, passkey } = await setUp();
    let owner = await approveSends(h, passkey, 4);
    expect(await (await h.fetch("/approvals", { as: owner })).text()).not.toContain(
      "Suggested rules",
    );

    owner = await approveSends(h, passkey, 1);
    const approvalsPage = await (await h.fetch("/approvals", { as: owner })).text();
    expect(approvalsPage).toContain("Suggested rules");
    expect(approvalsPage).toContain("vendor.com");
    expect(approvalsPage).toMatch(/You approved 5 times on 3 days since/);
    const activity = await (await h.fetch("/activity", { as: owner })).text();
    expect(activity).toContain(`/suggestions/${keyOn(approvalsPage)}/propose`);
  });

  it("opens a suggestion as heel's own proposal, which a passkey adds to the rules file", async () => {
    const { h, passkey, home } = await setUp();
    const owner = await approveSends(h, passkey, 5);
    const key = keyOn(await (await h.fetch("/approvals", { as: owner })).text());

    const proposed = await h.fetch(`/suggestions/${key}/propose`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf }).toString(),
    });
    expect(proposed.status).toBe(303);
    const location = proposed.headers.get("location") ?? "";
    expect(location).toMatch(/^\/proposals\//);
    const row = h.t.db.select().from(ruleProposals).get();
    expect(row).toMatchObject({ origin: "heel", status: "pending" });
    expect(row?.rules[0]?.rule).toEqual({
      match: {
        agent: h.agent.agentName,
        account: expect.any(String),
        action: "email.send",
        tool: expect.any(String),
        persistence: false,
        recipients: { equals: ["bob@vendor.com"] },
      },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
      then: "allow",
    });

    const page = await (await h.fetch(location, { as: owner })).text();
    expect(page).toContain("heel suggests");
    expect(page).toContain("heel drafted this from requests you decided");
    // While it waits as a proposal, it isn't offered again.
    expect(await (await h.fetch("/approvals", { as: owner })).text()).not.toContain(
      `/suggestions/${key}/propose`,
    );

    const id = location.slice("/proposals/".length);
    const applied = await h.ceremony(
      owner,
      { url: "/proposals/challenge", body: { proposalId: id, sha: attribute(page, "data-sha") } },
      "/proposals/confirm",
    );
    expect(applied.status).toBe(200);
    const written = readFileSync(join(rulesPaths(home).ownersDir, "owner.yaml"), "utf8");
    expect(written).toContain("bob@vendor.com");
    // It went right before the rule that asked: the deny above still decides first.
    const at = (text: string) => written.indexOf(text);
    expect(at("no-ceo")).toBeLessThan(at("Suggested by heel"));
    expect(at("Suggested by heel")).toBeLessThan(at("sends-ask"));
    // The file says heel suggested it; the agent didn't propose it.
    expect(written).toMatch(/# Suggested by heel for \S+: You approved 5 times/);
    expect(written).not.toContain("Proposed by");
  });

  it("stops offering a dismissed suggestion, and only to whoever it was for", async () => {
    const { h, passkey } = await setUp();
    const owner = await approveSends(h, passkey, 5);
    const key = keyOn(await (await h.fetch("/approvals", { as: owner })).text());
    const form = (as: Browser) => ({
      as,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: as.csrf, from: "activity" }).toString(),
    });
    // Someone else can't dismiss or propose it: it isn't theirs.
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await h.fetch(`/suggestions/${key}/dismiss`, form(sam))).status).toBe(404);
    expect((await h.fetch(`/suggestions/${key}/propose`, form(sam))).status).toBe(404);

    const dismissed = await h.fetch(`/suggestions/${key}/dismiss`, form(owner));
    expect(dismissed.status).toBe(303);
    expect(dismissed.headers.get("location")).toBe("/activity");
    expect(h.t.db.select().from(learningDismissals).all()).toHaveLength(1);
    expect(await (await h.fetch("/approvals", { as: owner })).text()).not.toContain(
      "Suggested rules",
    );
  });

  it("suggests nothing when heel.yaml turns learning off", async () => {
    const { h, passkey } = await setUp(null);
    const owner = await approveSends(h, passkey, 6);
    expect(await (await h.fetch("/approvals", { as: owner })).text()).not.toContain(
      "Suggested rules",
    );
  });

  it("checks a suggestion again when it's added, and a rejected one doesn't come straight back", async () => {
    const { h, passkey } = await setUp();
    let owner = await approveSends(h, passkey, 5);
    const form = (as: Browser) => ({
      as,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: as.csrf }).toString(),
    });
    const key = keyOn(await (await h.fetch("/approvals", { as: owner })).text());
    const location =
      (await h.fetch(`/suggestions/${key}/propose`, form(owner))).headers.get("location") ?? "";
    const id = location.slice("/proposals/".length);
    const sha = attribute(await (await h.fetch(location, { as: owner })).text(), "data-sha");

    // The owner then denies a send it would allow: heel no longer suggests it.
    const approvalId = pendingId(await h.call({ args: { ...SEND, subject: "late" } }));
    const callHash = h.audit().find((row) => row.approvalId === approvalId)?.callHash ?? "";
    const denied = await h.ceremony(
      owner,
      { url: `/approvals/${approvalId}/challenge`, body: { callHash, intent: "deny" } },
      `/approvals/${approvalId}/decide`,
    );
    expect(denied.status).toBe(200);
    const challenge = await h.fetch("/proposals/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ proposalId: id, sha }),
    });
    expect(challenge.status).toBe(409);
    expect(await challenge.text()).toMatch(/wouldn't suggest this now/);

    // Rejected, it isn't offered again, even once the denial ages out of the window.
    const rejected = await h.fetch(`/proposals/${id}/reject`, form(owner));
    expect(rejected.status).toBe(303);
    h.clock.advance(31 * 24 * HOUR);
    owner = await approveSends(h, passkey, 5);
    expect(await (await h.fetch("/approvals", { as: owner })).text()).not.toContain(
      "Suggested rules",
    );
  });
});
