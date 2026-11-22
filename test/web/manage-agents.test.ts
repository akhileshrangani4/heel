import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashAgentToken } from "../../src/gateway/agent-tokens.ts";
import { addAgent, setWorkRoots, workRootsOf } from "../../src/gateway/agents.ts";
import { agents, agentTokens, users } from "../../src/store/schema.ts";
import {
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  PUBLIC_URL,
} from "../helpers/human-plane.ts";
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

  it("adds the workdir that was signed, not one a symlink swapped in during the passkey", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const base = tempDir("heel-web-swap-");
    const project = join(base, "proj");
    const secret = join(base, "secret");
    mkdirSync(project);
    mkdirSync(secret);
    const start = await h.fetch("/agents/manage/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ op: "workdir", name: h.agent.agentName, path: project }),
    });
    const { challengeId, options } = (await start.json()) as {
      challengeId: string;
      options: never;
    };
    rmSync(project, { recursive: true });
    symlinkSync(secret, project);
    const done = await h.fetch("/agents/manage/confirm", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({
        challengeId,
        response: owner.authenticator.assert(options, PUBLIC_URL.origin),
      }),
    });
    expect(done.status).toBe(409);
    expect(workRootsOf(h.t.db, h.agent.agentId)).toEqual([]);
  });

  it("lets an admin revoke a member's agent but not take a token for it, and stops scripts on a new token", async () => {
    const stopped: string[] = [];
    let scriptAgent = "";
    const h = humanPlaneHarness({
      background: {
        approvalDecided: () => {},
        list: () => [
          {
            id: "scr_1",
            agentId: scriptAgent,
            agentName: "",
            status: "running",
            approvalId: null,
            calls: 0,
            startedAt: new Date(),
          },
        ],
        stop: (id) => {
          stopped.push(id);
          return true;
        },
        waitsOn: () => false,
        stopWaitingOn: () => {},
      },
    });
    scriptAgent = h.agent.agentId;
    const owner = await h.signIn(await h.enroll());
    h.addUser("sam", "member");
    const samId =
      h.t.db
        .select()
        .from(users)
        .all()
        .find((u) => u.name === "sam")?.id ?? "";
    addAgent(h.t.db, { orgId: h.t.orgId, ownerId: samId, name: "sams-bot" }, new Date());
    expect((await manage(h, owner, { op: "rotate", name: "sams-bot", days: "90" })).status).toBe(
      400,
    );
    expect((await h.fetch("/agents/sams-bot/revoke", form(owner))).status).toBe(303);

    // The new token page isn't cached anywhere.
    const done = await manage(h, owner, { op: "rotate", name: h.agent.agentName, days: "90" });
    const { next } = (await done.json()) as { next: string };
    expect((await h.fetch(next, { as: owner })).headers.get("cache-control")).toBe("no-store");
    expect(stopped).toEqual(["scr_1"]);
  });

  it("removes a workdir even when another one has since been deleted", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const keepDir = tempDir("heel-web-keep-");
    const goneDir = tempDir("heel-web-gone-");
    setWorkRoots(h.t.db, h.t.orgId, h.agent.agentName, [keepDir, goneDir]);
    const [kept, gone] = workRootsOf(h.t.db, h.agent.agentId);
    rmSync(goneDir, { recursive: true });
    const removed = await h.fetch(
      `/agents/${h.agent.agentName}/workdirs/remove`,
      form(owner, { path: kept ?? "" }),
    );
    expect(removed.status).toBe(303);
    expect(workRootsOf(h.t.db, h.agent.agentId)).toEqual([gone]);
  });
});
