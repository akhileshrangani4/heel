import { describe, expect, it } from "vitest";
import { hashAgentToken } from "../../src/gateway/agent-tokens.ts";
import { workRootsOf } from "../../src/gateway/agents.ts";
import { agents, agentTokens } from "../../src/store/schema.ts";
import { type Browser, type HumanPlaneHarness, humanPlaneHarness } from "../helpers/human-plane.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Roadmap 2.9: agents from the web app. Adding one, a new token and a new
 * workdir need a passkey; revoking and removing a workdir are plain forms.
 * A new token is shown once, to whoever made it.
 */

function manage(h: HumanPlaneHarness, as: Browser, body: Record<string, string>) {
  return h.ceremony(as, { url: "/agents/manage/challenge", body }, "/agents/manage/confirm");
}

async function tokenFrom(h: HumanPlaneHarness, as: Browser, done: Response): Promise<string> {
  const { next } = (await done.json()) as { next: string };
  expect(next).toMatch(/^\/agents\/token\//);
  const page = await (await h.fetch(next, { as })).text();
  const token = /id="new-token"[^>]*value="([^"]+)"/.exec(page)?.[1];
  if (token === undefined) throw new Error("no token on the page");
  // Shown once: the same link is empty now.
  expect(await (await h.fetch(next, { as })).text()).toContain("already shown");
  return token;
}

const form = (as: Browser, fields: Record<string, string> = {}): RequestInit & { as: Browser } => ({
  as,
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: as.csrf, ...fields }).toString(),
});

describe("agents in the web app (2.9)", () => {
  it("adds an agent with a passkey and shows its token once, with the MCP address", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    expect((await manage(h, owner, { op: "add", name: "bad name!", days: "90" })).status).toBe(400);
    const done = await manage(h, owner, { op: "add", name: "web-bot", days: "30" });
    expect(done.status).toBe(200);
    const token = await tokenFrom(h, owner, done);
    const row = h.t.db
      .select()
      .from(agents)
      .all()
      .find((a) => a.name === "web-bot");
    expect(row?.ownerId).toBe(h.t.ownerId);
    const stored = h.t.db
      .select()
      .from(agentTokens)
      .all()
      .filter((t) => t.agentId === row?.id);
    expect(stored.map((t) => t.tokenHash)).toEqual([hashAgentToken(token)]);
    expect((await manage(h, owner, { op: "add", name: "web-bot", days: "30" })).status).toBe(400);
  });

  it("gives a new token, revokes, and keeps people to their own agents", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const old = h.t.db
      .select()
      .from(agentTokens)
      .all()
      .find((t) => t.agentId === h.agent.agentId);
    const fresh = await tokenFrom(
      h,
      owner,
      await manage(h, owner, { op: "rotate", name: h.agent.agentName, days: "never" }),
    );
    const live = h.t.db
      .select()
      .from(agentTokens)
      .all()
      .filter((t) => t.agentId === h.agent.agentId && t.revokedAt === null);
    expect(live.map((t) => t.tokenHash)).toEqual([hashAgentToken(fresh)]);
    expect(live[0]?.id).not.toBe(old?.id);

    // Someone else's token page shows nothing, and they can't touch this agent.
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    expect(
      (await manage(h, sam, { op: "rotate", name: h.agent.agentName, days: "90" })).status,
    ).toBe(400);
    expect((await h.fetch(`/agents/${h.agent.agentName}/revoke`, form(sam))).status).toBe(404);

    const revoked = await h.fetch(`/agents/${h.agent.agentName}/revoke`, form(owner));
    expect(revoked.status).toBe(303);
    expect(
      h.t.db
        .select()
        .from(agents)
        .all()
        .find((a) => a.id === h.agent.agentId)?.revokedAt,
    ).not.toBeNull();
  });

  it("adds a workdir with a passkey, as heel will store it, and removes one with a form", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const dir = tempDir("heel-web-wd-");
    const done = await manage(h, owner, { op: "workdir", name: h.agent.agentName, path: dir });
    expect(done.status).toBe(200);
    const [root] = workRootsOf(h.t.db, h.agent.agentId);
    expect(root).toBeDefined();
    expect(
      (await manage(h, owner, { op: "workdir", name: h.agent.agentName, path: "relative" })).status,
    ).toBe(400);
    const page = await (await h.fetch("/agents", { as: owner })).text();
    expect(page).toContain("Manage " + h.agent.agentName);
    const removed = await h.fetch(
      `/agents/${h.agent.agentName}/workdirs/remove`,
      form(owner, { path: root ?? "" }),
    );
    expect(removed.status).toBe(303);
    expect(workRootsOf(h.t.db, h.agent.agentId)).toEqual([]);
  });
});
