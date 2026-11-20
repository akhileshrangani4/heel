import { describe, expect, it } from "vitest";
import {
  NotPublicError,
  publicOnlyFetch,
  publicUrlProblem,
} from "../../../src/definitions/mcp/public-only.ts";

/** A server an agent asked for is reached only on public https hosts, hop by hop (roadmap 2.5). */

const PUBLIC = "93.184.216.34";

/** A fake network: each URL answers as given; records what was asked, with its headers. */
function network(answers: Record<string, () => Response>) {
  const asked: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({
      url,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ?? null,
    });
    if (init?.redirect !== "manual") throw new Error("heel must follow redirects itself");
    const answer = answers[url];
    if (answer === undefined) throw new Error(`nothing at ${url}`);
    return answer();
  };
  return { fetch, asked };
}

const redirect = (status: number, location: string) => () =>
  new Response(null, { status, headers: { location } });
const ok = () => new Response("{}", { status: 200 });
const resolveTo = (map: Record<string, string>) => async (host: string) => [map[host] ?? PUBLIC];

describe("public-only urls", () => {
  it("takes only https on a public host name", () => {
    expect(publicUrlProblem("https://mcp.example.com/mcp")).toBeNull();
    for (const url of [
      "http://mcp.example.com/mcp",
      "https://10.0.0.5/mcp",
      "https://[::1]/mcp",
      "https://2130706433/mcp",
      "https://localhost/mcp",
      "https://intranet/mcp",
      "https://wiki.corp.internal/mcp",
      "https://printer.local/mcp",
      "https://user:pw@mcp.example.com/mcp",
    ]) {
      expect(publicUrlProblem(url), url).not.toBeNull();
    }
  });
});

describe("publicOnlyFetch", () => {
  it("follows a redirect to another public https host", async () => {
    const net = network({
      "https://mcp.example.com/mcp": redirect(307, "https://api.example.net/mcp"),
      "https://api.example.net/mcp": ok,
    });
    const response = await publicOnlyFetch(net.fetch, resolveTo({}))(
      "https://mcp.example.com/mcp",
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(net.asked.map((a) => [a.url, a.method])).toEqual([
      ["https://mcp.example.com/mcp", "POST"],
      ["https://api.example.net/mcp", "POST"],
    ]);
  });

  it("won't follow a redirect into the network, by address or by name", async () => {
    for (const [location, resolve] of [
      ["http://169.254.169.254/latest/meta-data", resolveTo({})],
      ["https://10.0.0.5/admin", resolveTo({})],
      ["https://looks-public.example/admin", resolveTo({ "looks-public.example": "10.0.0.5" })],
    ] as const) {
      const net = network({ "https://mcp.example.com/mcp": redirect(302, location) });
      await expect(
        publicOnlyFetch(net.fetch, resolve)("https://mcp.example.com/mcp"),
      ).rejects.toBeInstanceOf(NotPublicError);
      expect(net.asked.map((a) => a.url)).toEqual(["https://mcp.example.com/mcp"]);
    }
  });

  it("refuses the first hop too when its name resolves privately", async () => {
    const net = network({});
    await expect(
      publicOnlyFetch(
        net.fetch,
        resolveTo({ "mcp.example.com": "192.168.1.10" }),
      )("https://mcp.example.com/mcp"),
    ).rejects.toBeInstanceOf(NotPublicError);
    expect(net.asked).toEqual([]);
  });

  it("drops the Authorization header on a redirect to another origin, and turns a 303 into a GET", async () => {
    const net = network({
      "https://mcp.example.com/mcp": redirect(303, "https://other.example.org/landing"),
      "https://other.example.org/landing": ok,
    });
    await publicOnlyFetch(net.fetch, resolveTo({}))("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: "{}",
    });
    expect(net.asked).toEqual([
      { url: "https://mcp.example.com/mcp", method: "POST", auth: "Bearer secret", body: "{}" },
      { url: "https://other.example.org/landing", method: "GET", auth: null, body: null },
    ]);
  });

  it("stops after a few redirects", async () => {
    const net = network({
      "https://mcp.example.com/loop": redirect(302, "https://mcp.example.com/loop"),
    });
    await expect(
      publicOnlyFetch(net.fetch, resolveTo({}))("https://mcp.example.com/loop"),
    ).rejects.toThrow("redirects");
  });
});
