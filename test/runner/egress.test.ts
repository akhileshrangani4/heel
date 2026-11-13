import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideEgress,
  EgressConfigError,
  type EgressDecision,
  isAllowlisted,
  isPublicAddress,
  parseConnectRequest,
  parseEgressAllow,
  parseHostPort,
  startEgressProxy,
} from "../../src/runner/egress.ts";

describe("parseHostPort", () => {
  it.each([
    ["api.github.com", 443, { host: "api.github.com", port: 443 }],
    ["API.GitHub.com:8443", 443, { host: "api.github.com", port: 8443 }],
    ["127.0.0.1:9", 443, { host: "127.0.0.1", port: 9 }],
    ["[::1]:9000", 443, { host: "::1", port: 9000 }],
    ["[2001:DB8::1]", 443, { host: "2001:db8::1", port: 443 }],
  ] as const)("%s", (text, defaultPort, expected) => {
    expect(parseHostPort(text, defaultPort)).toEqual(expected);
  });

  it.each([
    "user@api.github.com",
    "api.github.com/path",
    "api%2egithub.com",
    "api.github.com:0",
    "api.github.com:65536",
    "::1",
    "[not-v6]:80",
    "-bad.example",
    "",
  ])("rejects %j", (text) => {
    expect(parseHostPort(text, 443)).toBeUndefined();
  });

  it("needs an explicit port when there is no default", () => {
    expect(parseHostPort("api.github.com", undefined)).toBeUndefined();
  });
});

describe("parseEgressAllow", () => {
  it("parses entries with port 443 by default", () => {
    expect(parseEgressAllow(["github.com", "uploads.github.com:8443"])).toEqual([
      { host: "github.com", port: 443 },
      { host: "uploads.github.com", port: 8443 },
    ]);
  });

  it("throws a config error on a bad entry", () => {
    expect(() => parseEgressAllow(["https://github.com"])).toThrow(EgressConfigError);
  });
});

describe("isAllowlisted", () => {
  const allow = parseEgressAllow(["api.github.com"]);

  it("needs the exact host and port", () => {
    expect(isAllowlisted(allow, { host: "api.github.com", port: 443 })).toBe(true);
    expect(isAllowlisted(allow, { host: "api.github.com", port: 80 })).toBe(false);
    expect(isAllowlisted(allow, { host: "evil.api.github.com", port: 443 })).toBe(false);
    expect(isAllowlisted(allow, { host: "github.com", port: 443 })).toBe(false);
  });
});

describe("parseConnectRequest", () => {
  it("reads the target of a CONNECT request line", () => {
    expect(parseConnectRequest("CONNECT api.github.com:443 HTTP/1.1\r\nHost: x")).toEqual({
      host: "api.github.com",
      port: 443,
    });
  });

  it.each([
    "GET http://api.github.com/ HTTP/1.1",
    "CONNECT api.github.com HTTP/1.1",
    "CONNECT api.github.com:443 HTTP/2",
    "connect api.github.com:443 HTTP/1.1",
    "",
  ])("rejects %j", (head) => {
    expect(parseConnectRequest(head)).toBeUndefined();
  });
});

describe("isPublicAddress", () => {
  it.each(["140.82.112.6", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "%s is public",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "64:ff9b::808:808",
    "api.github.com",
  ])("%s is not", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("decideEgress", () => {
  const allow = parseEgressAllow(["api.github.com", "10.0.0.5:8080"]);
  const target = { host: "api.github.com", port: 443 };
  const resolvesTo =
    (...addresses: string[]) =>
    async (): Promise<readonly string[]> =>
      addresses;

  it("refuses a request it can't parse", async () => {
    expect(await decideEgress(allow, undefined, resolvesTo())).toEqual({
      allowed: false,
      reason: "bad_request",
    });
  });

  it("refuses a target outside the allowlist without resolving it", async () => {
    let resolved = false;
    const decision = await decideEgress(allow, { host: "example.com", port: 443 }, async () => {
      resolved = true;
      return ["93.184.216.34"];
    });
    expect(decision).toMatchObject({ allowed: false, reason: "not_allowlisted" });
    expect(resolved).toBe(false);
  });

  it("dials an allowlisted IP literal as is", async () => {
    expect(await decideEgress(allow, { host: "10.0.0.5", port: 8080 }, resolvesTo())).toEqual({
      allowed: true,
      target: { host: "10.0.0.5", port: 8080 },
      address: "10.0.0.5",
    });
  });

  it("dials the first address of a name that resolves only to public addresses", async () => {
    expect(await decideEgress(allow, target, resolvesTo("140.82.112.6", "140.82.112.5"))).toEqual({
      allowed: true,
      target,
      address: "140.82.112.6",
    });
  });

  it("refuses a name that resolves to any non-public address", async () => {
    expect(await decideEgress(allow, target, resolvesTo("140.82.112.6", "127.0.0.1"))).toEqual({
      allowed: false,
      target,
      reason: "private_address",
    });
  });

  it("refuses when resolution fails or returns nothing", async () => {
    const failing = async (): Promise<readonly string[]> => {
      throw new Error("ENOTFOUND");
    };
    expect(await decideEgress(allow, target, failing)).toMatchObject({ reason: "resolve_failed" });
    expect(await decideEgress(allow, target, resolvesTo())).toMatchObject({
      reason: "resolve_failed",
    });
  });
});

describe("startEgressProxy", () => {
  let dir: string;
  let upstream: Server;
  let upstreamPort: number;
  let proxies = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "heel-egress-test-"));
    upstream = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("no upstream port");
    upstreamPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Sends `request` to the proxy and returns everything it answers until it closes. */
  async function exchange(socketPath: string, request: string, then?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = connect(socketPath);
      let received = "";
      client.setEncoding("latin1");
      client.on("data", (text: string) => {
        received += text;
        if (then !== undefined && received.includes("\r\n\r\n") && received.endsWith(then)) {
          client.end();
        }
      });
      client.on("error", reject);
      client.on("close", () => resolve(received));
      client.write(request + (then ?? ""));
    });
  }

  async function withProxy<T>(
    run: (socketPath: string, decisions: EgressDecision[]) => Promise<T>,
  ): Promise<T> {
    const decisions: EgressDecision[] = [];
    const proxy = await startEgressProxy({
      socketPath: join(dir, `proxy-${proxies++}.sock`),
      allow: [`127.0.0.1:${upstreamPort}`],
      onDecision: (decision) => decisions.push(decision),
    });
    try {
      return await run(proxy.socketPath, decisions);
    } finally {
      await proxy.close();
    }
  }

  it("tunnels to an allowlisted target, including bytes sent with the request", async () => {
    await withProxy(async (socketPath, decisions) => {
      const answer = await exchange(
        socketPath,
        `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n\r\n`,
        "ping",
      );
      expect(answer).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
      expect(decisions).toMatchObject([{ allowed: true, address: "127.0.0.1" }]);
    });
  });

  it("answers 403 for a target outside the allowlist and never dials it", async () => {
    await withProxy(async (socketPath, decisions) => {
      const answer = await exchange(socketPath, "CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n");
      expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
      expect(answer).toContain("not_allowlisted");
      expect(decisions).toMatchObject([{ allowed: false, reason: "not_allowlisted" }]);
    });
  });

  it("answers 400 to anything but CONNECT", async () => {
    await withProxy(async (socketPath) => {
      const answer = await exchange(
        socketPath,
        `GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\n\r\n`,
      );
      expect(answer).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    });
  });

  it("refuses to start with a bad allowlist", async () => {
    await expect(
      startEgressProxy({ socketPath: join(dir, "bad.sock"), allow: ["http://x"] }),
    ).rejects.toThrow(EgressConfigError);
  });
});
