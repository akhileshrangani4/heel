import { describe, expect, it } from "vitest";
import { checkKey, checksKey } from "../../src/vault/key-check.ts";

/**
 * Checking a pasted key before heel stores it (roadmap T12). The answers are
 * what each service sent a bogus key on Nov 21 2026 (see
 * test/failclosed/rejected-key.test.ts).
 */

function answering(status: number, body: unknown) {
  const seen: string[] = [];
  const fetch = async (input: string | URL): Promise<Response> => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, seen };
}

describe("checking a pasted key", () => {
  it("refuses a key each service turns down, with what to do", async () => {
    const cases: [string, number, unknown][] = [
      ["github", 401, { message: "Bad credentials" }],
      ["notion", 401, { object: "error", status: 401, code: "unauthorized" }],
      ["stripe", 401, { error: { type: "invalid_request_error" } }],
      ["slack", 200, { ok: false, error: "invalid_auth" }],
      ["linear", 401, { errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }],
    ];
    for (const [provider, status, body] of cases) {
      const result = await checkKey(provider, "bogus", answering(status, body).fetch);
      expect(result.status, provider).toBe("rejected");
      if (result.status === "rejected") expect(result.message).toContain("didn't connect it");
    }
  });

  it("passes a key the service accepts, asking only the service's own API", async () => {
    const github = answering(200, { login: "me" });
    expect(await checkKey("github", "ghp_good", github.fetch)).toEqual({ status: "ok" });
    expect(github.seen).toEqual(["https://api.github.com/user"]);
    const slack = answering(200, { ok: true });
    expect(await checkKey("slack", "xoxb-good", slack.fetch)).toEqual({ status: "ok" });
  });

  it("connects anything it can't settle: a 5xx, a narrow key's 403, no network", async () => {
    expect((await checkKey("github", "k", answering(500, {}).fetch)).status).toBe("unchecked");
    expect((await checkKey("stripe", "rk_narrow", answering(403, {}).fetch)).status).toBe(
      "unchecked",
    );
    const offline = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    expect((await checkKey("notion", "k", offline)).status).toBe("unchecked");
  });

  it("checks only the services it knows", async () => {
    expect(checksKey("github")).toBe(true);
    expect(checksKey("http-billing")).toBe(false);
    const never = async (): Promise<Response> => {
      throw new Error("must not be called");
    };
    expect(await checkKey("http-billing", "k", never)).toEqual({ status: "ok" });
  });
});
