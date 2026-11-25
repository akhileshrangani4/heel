import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { textHash } from "../../src/proposals/edit.ts";
import { proposeRules } from "../../src/proposals/rules.ts";
import { requestConnection } from "../../src/requests/connection.ts";
import { ORG_DEFAULT } from "../../src/store/modes.ts";
import { passkeys } from "../../src/store/schema.ts";
import { Passkeys, relyingPartyFor } from "../../src/web/passkeys.ts";
import {
  AGENT_URL,
  attribute,
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  PUBLIC_URL,
} from "../helpers/human-plane.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Every change on the human plane that asks for a passkey refuses the same
 * two ways: 400 when the person has no passkey to sign with, and 401 when the
 * signed answer doesn't check out. Each route's happy path is tested with it.
 */

const RULES = "rules:\n  - name: asks\n    match: {}\n    then: ask\n";
const REDIRECT = "https://connector.example.com/oauth/callback";
const NO_PASSKEY = { ok: false, message: "You have no passkey enrolled." };
const FAILED = { ok: false, message: "The passkey check didn't pass." };

async function setUp() {
  const home = tempDir("heel-passkey-routes-");
  const dir = rulesPaths(home).ownersDir;
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.yaml"), RULES);
  const h = humanPlaneHarness({
    rulesHome: home,
    // The vault comes with upstream sign-in: accounts and connection requests need it.
    upstreamOAuth: { fetch: async () => new Response("unexpected", { status: 500 }) },
  });
  const owner = await h.signIn(await h.enroll());
  return { h, owner };
}

function post(h: HumanPlaneHarness, as: Browser, path: string, body: unknown) {
  return h.fetch(path, {
    as,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Route = {
  start: string;
  finish: string;
  /** A body the route's own checks let through to the passkey. */
  body: (h: HumanPlaneHarness, owner: Browser) => Promise<Record<string, unknown>>;
};

const ROUTES: Route[] = [
  { start: "/devices/challenge", finish: "/devices/confirm", body: async () => ({}) },
  {
    start: "/modes/challenge",
    finish: "/modes/confirm",
    body: async () => ({ owner: ORG_DEFAULT, mode: "shadow" }),
  },
  {
    start: "/grants/challenge",
    finish: "/grants/confirm",
    body: async (h) => ({
      agent: h.agent.agentId,
      task: "Send Q3 to the vendor",
      match: "{ action: email.send }",
      duration: "1h",
    }),
  },
  {
    start: "/agents/manage/challenge",
    finish: "/agents/manage/confirm",
    body: async () => ({ op: "add", name: "web-bot", days: "30" }),
  },
  {
    start: "/connections/manage/challenge",
    finish: "/connections/manage/confirm",
    body: async () => ({ op: "connect", service: "github", alias: "gh-web" }),
  },
  {
    start: "/people/challenge",
    finish: "/people/confirm",
    body: async () => ({ op: "add", name: "sam" }),
  },
  {
    start: "/pause/resume/challenge",
    finish: "/pause/resume",
    body: async (h, owner) => {
      await h.fetch("/pause", {
        as: owner,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: owner.csrf, scope: "global", target: "" }).toString(),
      });
      return { scope: "global", target: "" };
    },
  },
  {
    start: "/proposals/challenge",
    finish: "/proposals/confirm",
    body: async (h, owner) => {
      const proposed = proposeRules(
        h.t.db,
        { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
        {
          rules: [
            {
              // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
              rule: { name: "read-mail", match: { action: "email.read" }, then: "allow" },
              why: "so I can summarise your inbox",
            },
          ],
        },
        h.clock.now,
      );
      if (!proposed.ok) throw new Error(proposed.problems.join("; "));
      const id = proposed.proposalId;
      const page = await (await h.fetch(`/proposals/${id}`, { as: owner })).text();
      return { proposalId: id, sha: attribute(page, "data-sha") };
    },
  },
  {
    start: "/requests/challenge",
    finish: "/requests/confirm",
    body: async (h, owner) => {
      const asked = requestConnection(
        h.t.db,
        { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
        { service: "gmail", alias: "inbox-new", why: "so I can triage your work mail" },
        h.clock.now,
      );
      if (!asked.ok) throw new Error(asked.problem);
      const page = await (await h.fetch(`/requests/${asked.requestId}`, { as: owner })).text();
      return { requestId: asked.requestId, hash: attribute(page, "data-hash") };
    },
  },
  {
    start: "/rules/challenge",
    finish: "/rules/confirm",
    body: async () => {
      const text = RULES.replace("then: ask", "then: deny");
      return { text, before: textHash(RULES), after: textHash(text) };
    },
  },
  {
    start: "/oauth/authorize/challenge",
    finish: "/oauth/authorize/confirm",
    body: async (h) => {
      const registered = await h.fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
      });
      const { client_id } = (await registered.json()) as { client_id: string };
      return {
        clientId: client_id,
        redirectUri: REDIRECT,
        codeChallenge: "c".repeat(43),
        state: "",
        resource: AGENT_URL.toString(),
      };
    },
  },
];

describe("routes that ask for a passkey", () => {
  it.each(ROUTES)("$start answers 400 when the person has no passkey", async (route) => {
    const { h, owner } = await setUp();
    const body = await route.body(h, owner);
    const issued = await post(h, owner, route.start, body);
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({ ok: true, challengeId: expect.any(String) });

    h.t.db.delete(passkeys).run();
    const refused = await post(h, owner, route.start, body);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("content-type")).toBe("application/json");
    expect(await refused.json()).toEqual(NO_PASSKEY);
  });

  it.each(ROUTES)(
    "I-56: $finish answers 401 to a passkey signed for another kind of decision",
    async (route) => {
      const { h, owner } = await setUp();
      const foreign = await new Passkeys(h.t.db, relyingPartyFor(PUBLIC_URL)).assertionOptions({
        orgId: h.t.orgId,
        purpose: "decide",
        userId: h.t.ownerId,
        binding: { approval: "elsewhere" },
        now: h.clock.now,
      });
      if (!foreign.ok) throw new Error(foreign.reason);
      const refused = await post(h, owner, route.finish, {
        challengeId: foreign.challengeId,
        response: owner.authenticator.assert(foreign.options, PUBLIC_URL.origin),
      });
      expect(refused.status).toBe(401);
      expect(refused.headers.get("content-type")).toBe("application/json");
      expect(await refused.json()).toEqual(FAILED);
    },
  );

  it("I-56: a device link is only for the person the signed challenge names", async () => {
    const { h, owner } = await setUp();
    const issued = await new Passkeys(h.t.db, relyingPartyFor(PUBLIC_URL)).assertionOptions({
      orgId: h.t.orgId,
      purpose: "add_device",
      userId: h.t.ownerId,
      binding: { userId: "someone-else" },
      now: h.clock.now,
    });
    if (!issued.ok) throw new Error(issued.reason);
    const refused = await post(h, owner, "/devices/confirm", {
      challengeId: issued.challengeId,
      response: owner.authenticator.assert(issued.options, PUBLIC_URL.origin),
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(FAILED);
  });
});
