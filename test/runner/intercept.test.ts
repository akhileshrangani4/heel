import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxCa, type SandboxCa } from "../../src/runner/ca.ts";
import { EgressConfigError, startEgressProxy } from "../../src/runner/egress.ts";
import {
  type CredentialAuth,
  forwardHeaders,
  hostMatches,
  type InterceptEvent,
  newPlaceholder,
  PLACEHOLDER_PREFIX,
  parseCredentialAuth,
  rewriteAuth,
} from "../../src/runner/intercept.ts";
import { headerOf, httpsUpstream } from "../helpers/https-upstream.ts";

const PLACEHOLDER = `${PLACEHOLDER_PREFIX}0123456789abcdef`;
const TOKEN = "real-token-0123456789";
const BEARER: CredentialAuth = { type: "authorization", schemes: ["bearer"] };
const GH: CredentialAuth = { type: "authorization", schemes: ["token", "bearer"] };
const BASIC: CredentialAuth = { type: "authorization", schemes: ["basic"] };
const KEY: CredentialAuth = { type: "header", name: "x-api-key" };
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("rewriteAuth", () => {
  it.each([
    ["bearer", BEARER, ["Authorization", `Bearer ${PLACEHOLDER}`], `Bearer ${TOKEN}`],
    ["bearer, any case", BEARER, ["authorization", `bearer ${PLACEHOLDER}`], `bearer ${TOKEN}`],
    ["gh's token scheme", GH, ["Authorization", `token ${PLACEHOLDER}`], `token ${TOKEN}`],
    [
      "basic, placeholder as password",
      BASIC,
      ["Authorization", `Basic ${b64(`me:${PLACEHOLDER}`)}`],
      `Basic ${b64(`me:${TOKEN}`)}`,
    ],
    [
      "basic, placeholder as user (Stripe style)",
      BASIC,
      ["Authorization", `Basic ${b64(`${PLACEHOLDER}:`)}`],
      `Basic ${b64(`${TOKEN}:`)}`,
    ],
  ] as const)("%s: puts the credential in the auth position", (_, auth, header, expected) => {
    const result = rewriteAuth(["Host", "api.test", ...header], auth, PLACEHOLDER, TOKEN);
    expect(result).toEqual({
      ok: true,
      headers: ["Host", "api.test", header[0], expected],
      injected: true,
    });
  });

  it("a named header carries the credential alone", () => {
    expect(rewriteAuth(["X-Api-Key", PLACEHOLDER], KEY, PLACEHOLDER, TOKEN)).toEqual({
      ok: true,
      headers: ["X-Api-Key", TOKEN],
      injected: true,
    });
  });

  it("a user:password credential replaces the whole basic userinfo", () => {
    const result = rewriteAuth(
      ["Authorization", `Basic ${b64(`${PLACEHOLDER}:`)}`],
      BASIC,
      PLACEHOLDER,
      "alice:s3cret",
    );
    expect(result).toMatchObject({
      ok: true,
      headers: ["Authorization", `Basic ${b64("alice:s3cret")}`],
    });
  });

  it("leaves the placeholder everywhere else exactly as it was", () => {
    const headers = [
      "Host",
      "api.test",
      "X-Reflect",
      PLACEHOLDER,
      "Cookie",
      `session=${PLACEHOLDER}`,
      "Authorization",
      `Bearer ${PLACEHOLDER}`,
    ];
    const result = rewriteAuth(headers, BEARER, PLACEHOLDER, TOKEN);
    expect(result.ok && result.headers).toEqual([
      ...headers.slice(0, 6),
      "Authorization",
      `Bearer ${TOKEN}`,
    ]);
    // In header mode the Authorization header isn't the auth position, so it isn't touched either.
    const keyed = rewriteAuth(["Authorization", `Bearer ${PLACEHOLDER}`], KEY, PLACEHOLDER, TOKEN);
    expect(keyed).toEqual({
      ok: true,
      headers: ["Authorization", `Bearer ${PLACEHOLDER}`],
      injected: false,
    });
  });

  it("forwards a request with no auth header as it is, without a credential", () => {
    expect(rewriteAuth(["Host", "api.test"], BEARER, PLACEHOLDER, TOKEN)).toEqual({
      ok: true,
      headers: ["Host", "api.test"],
      injected: false,
    });
  });

  it.each([
    ["a foreign bearer", BEARER, ["Authorization", "Bearer someone-elses-token"]],
    ["the placeholder with extra text", BEARER, ["Authorization", `Bearer ${PLACEHOLDER}x`]],
    ["the wrong scheme", BEARER, ["Authorization", `token ${PLACEHOLDER}`]],
    [
      "basic where bearer is configured",
      BEARER,
      ["Authorization", `Basic ${b64(`u:${PLACEHOLDER}`)}`],
    ],
    ["a bare placeholder", BEARER, ["Authorization", PLACEHOLDER]],
    [
      "two auth headers",
      BEARER,
      ["Authorization", `Bearer ${PLACEHOLDER}`, "authorization", `Bearer ${PLACEHOLDER}`],
    ],
    [
      "basic with the placeholder in both slots",
      BASIC,
      ["Authorization", `Basic ${b64(`${PLACEHOLDER}:${PLACEHOLDER}`)}`],
    ],
    ["basic with no colon", BASIC, ["Authorization", `Basic ${b64(PLACEHOLDER)}`]],
    [
      "basic that isn't canonical base64",
      BASIC,
      ["Authorization", `Basic ${b64(`u:${PLACEHOLDER}`).replace(/=+$/, "")}`],
    ],
    ["a foreign named header", KEY, ["X-Api-Key", "not-the-placeholder"]],
  ] as const)("refuses %s", (_, auth, headers) => {
    expect(rewriteAuth(headers, auth, PLACEHOLDER, TOKEN)).toEqual({
      ok: false,
      reason: "credential_mismatch",
    });
  });

  it.each(["", "a\r\nX-Evil: 1", "nul\0"])(
    "refuses a credential that could break the header: %j",
    (credential) => {
      expect(
        rewriteAuth(["Authorization", `Bearer ${PLACEHOLDER}`], BEARER, PLACEHOLDER, credential),
      ).toEqual({
        ok: false,
        reason: "credential_unusable",
      });
    },
  );
});

describe("parseCredentialAuth", () => {
  it.each([
    ["bearer", BEARER],
    ["basic", BASIC],
    ["header:X-Api-Key", KEY],
    ["header:Authorization", BEARER],
  ] as const)("%s", (text, expected) => {
    expect(parseCredentialAuth(text)).toEqual(expected);
  });

  it.each(["query:api_key", "token", "header:", "header:Host", "header:Cookie", "header:a b", ""])(
    "refuses %j",
    (text) => {
      expect(parseCredentialAuth(text)).toBeNull();
    },
  );
});

describe("hostMatches", () => {
  const target = { host: "api.github.com", port: 443 };
  it.each(["api.github.com", "API.GitHub.com", "api.github.com:443"])(
    "%s names the target",
    (host) => {
      expect(hostMatches(host, target)).toBe(true);
    },
  );
  it.each([
    undefined,
    "",
    "github.com",
    "api.github.com:8443",
    "api.github.com.evil.test",
    "api.github.com@evil",
  ])("%j doesn't", (host) => {
    expect(hostMatches(host, target)).toBe(false);
  });
  it("needs the port when it isn't 443, and brackets for IPv6", () => {
    expect(hostMatches("127.0.0.1:8443", { host: "127.0.0.1", port: 8443 })).toBe(true);
    expect(hostMatches("127.0.0.1", { host: "127.0.0.1", port: 8443 })).toBe(false);
    expect(hostMatches("[::1]:9", { host: "::1", port: 9 })).toBe(true);
  });
});

describe("forwardHeaders", () => {
  it("drops hop-by-hop headers and asks for an identity body", () => {
    expect(
      forwardHeaders(
        [
          "Host",
          "a.test",
          "Connection",
          "keep-alive",
          "Accept-Encoding",
          "gzip",
          "Proxy-Authorization",
          "x",
          "TE",
          "trailers",
          "X-Ok",
          "1",
        ],
        false,
      ),
    ).toEqual(["Host", "a.test", "X-Ok", "1", "Accept-Encoding", "identity"]);
  });
});

describe("newPlaceholder", () => {
  it("is heel-prefixed, random, and safe in every auth position", () => {
    const a = newPlaceholder();
    expect(a).toMatch(/^heel-placeholder-[0-9a-f]{40}$/);
    expect(newPlaceholder()).not.toBe(a);
  });
});

/** Opens a CONNECT tunnel through the proxy socket; resolves with the status line and the socket. */
async function tunnel(
  socketPath: string,
  target: string,
): Promise<{ status: string; socket: Socket }> {
  const socket = connect(socketPath);
  const status = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    socket.once("error", reject);
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end !== -1) {
        socket.off("data", onData);
        resolve(buffered.slice(0, end).split("\r\n")[0] ?? "");
      }
    };
    socket.on("data", onData);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
  return { status, socket };
}

function secure(socket: Socket, ca: string, alpn: string[] = ["http/1.1"]): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, host: "127.0.0.1", ca, ALPNProtocols: alpn }, () =>
      resolve(tls),
    );
    tls.once("error", reject);
  });
}

/** Sends raw bytes and reads until the server closes; `Connection: close` requests end that way. */
function exchange(
  tls: TLSSocket,
  raw: string,
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    tls.on("data", (chunk: Buffer) => chunks.push(chunk));
    tls.once("error", reject);
    tls.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const end = text.indexOf("\r\n\r\n");
      const head = text.slice(0, end);
      resolve({ status: Number(head.split(" ")[1]), head, body: text.slice(end + 4) });
    });
    tls.write(raw);
  });
}

describe("credential injection at the egress proxy", () => {
  let dir: string;
  let upstream: Awaited<ReturnType<typeof httpsUpstream>>;
  let echoValue: string | undefined;
  let proxies = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "heel-intercept-test-"));
    upstream = await httpsUpstream({ echo: () => echoValue });
  });
  afterAll(async () => {
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function proxy(
    options: {
      auth?: CredentialAuth;
      credential?: () => Promise<string>;
      upstreamCa?: readonly string[];
    } = {},
  ) {
    const target = `127.0.0.1:${upstream.port}`;
    const ca: SandboxCa = await createSandboxCa(["127.0.0.1"]);
    const events: InterceptEvent[] = [];
    const started = await startEgressProxy({
      socketPath: join(dir, `p${proxies++}.sock`),
      allow: [target],
      inject: {
        hosts: [target],
        intercept: {
          ca,
          auth: options.auth ?? BEARER,
          placeholder: PLACEHOLDER,
          credential: options.credential ?? (async () => TOKEN),
          upstreamCa: options.upstreamCa ?? [upstream.ca],
          onRequest: (event) => events.push(event),
        },
      },
    });
    return {
      target,
      ca,
      events,
      async open(alpn?: string[]) {
        const { status, socket } = await tunnel(started.socketPath, target);
        expect(status).toBe("HTTP/1.1 200 Connection Established");
        return secure(socket, ca.certificate, alpn);
      },
      close: () => started.close(),
    };
  }

  function request(target: string, lines: string[], body = ""): string {
    return [
      ...lines.map((l) => l.replace("{target}", target)),
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n");
  }

  it("adds the credential in the auth position only; the placeholder elsewhere arrives unchanged", async () => {
    const p = await proxy();
    const before = upstream.seen.length;
    const tls = await p.open();
    const body = JSON.stringify({ token: PLACEHOLDER });
    const answer = await exchange(
      tls,
      request(
        p.target,
        [
          `POST /echo?key=${PLACEHOLDER} HTTP/1.1`,
          "Host: {target}",
          `Authorization: Bearer ${PLACEHOLDER}`,
          `X-Reflect: ${PLACEHOLDER}`,
        ],
        body,
      ),
    );
    expect(answer.status).toBe(200);
    const seen = upstream.seen[before];
    expect(headerOf(seen?.rawHeaders ?? [], "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(seen?.rawHeaders ?? [], "x-reflect")).toBe(PLACEHOLDER);
    expect(headerOf(seen?.rawHeaders ?? [], "accept-encoding")).toBe("identity");
    expect(seen?.url).toBe(`/echo?key=${PLACEHOLDER}`);
    expect(seen?.body).toBe(body);
    // The upstream reflected the request, credential included; the proxy scrubbed it.
    expect(answer.body).not.toContain(TOKEN);
    expect(answer.body).toContain("[redacted by heel]");
    expect(p.events).toEqual([
      { target: { host: "127.0.0.1", port: upstream.port }, method: "POST", injected: true },
    ]);
    await p.close();
  });

  it("scrubs the credential's forms from response headers and bodies", async () => {
    const p = await proxy();
    echoValue = Buffer.from(TOKEN).toString("base64");
    try {
      const tls = await p.open();
      const answer = await exchange(tls, request(p.target, ["GET / HTTP/1.1", "Host: {target}"]));
      expect(answer.head).toContain("x-echo: [redacted by heel]");
      expect(answer.body).not.toContain(echoValue);
    } finally {
      echoValue = undefined;
      await p.close();
    }
  });

  it("forwards a request without an auth header without a credential", async () => {
    const p = await proxy();
    const before = upstream.seen.length;
    const tls = await p.open();
    expect(
      (await exchange(tls, request(p.target, ["GET / HTTP/1.1", "Host: {target}"]))).status,
    ).toBe(200);
    expect(headerOf(upstream.seen[before]?.rawHeaders ?? [], "authorization")).toBeUndefined();
    await p.close();
  });

  it("injects into a named header", async () => {
    const p = await proxy({ auth: KEY });
    const before = upstream.seen.length;
    const tls = await p.open();
    await exchange(
      tls,
      request(p.target, ["GET / HTTP/1.1", "Host: {target}", `X-Api-Key: ${PLACEHOLDER}`]),
    );
    expect(headerOf(upstream.seen[before]?.rawHeaders ?? [], "x-api-key")).toBe(TOKEN);
    await p.close();
  });

  it.each([
    [
      "a foreign Authorization value",
      ["GET / HTTP/1.1", "Host: {target}", "Authorization: Bearer stolen"],
      403,
      "credential_mismatch",
    ],
    [
      "a Host other than the CONNECT target",
      ["GET / HTTP/1.1", "Host: api.github.com", `Authorization: Bearer ${PLACEHOLDER}`],
      403,
      "host_mismatch",
    ],
    [
      "an absolute-form target",
      ["GET https://api.github.com/ HTTP/1.1", "Host: {target}"],
      400,
      "bad_target",
    ],
    [
      "an h2c upgrade",
      [
        "GET / HTTP/1.1",
        "Host: {target}",
        "Connection: Upgrade, HTTP2-Settings",
        "Upgrade: h2c",
        "HTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA",
      ],
      400,
      "unsupported_upgrade",
    ],
  ] as const)("refuses %s, and nothing reaches the upstream", async (_, lines, status, reason) => {
    const p = await proxy();
    const before = upstream.seen.length;
    const tls = await p.open();
    const answer = await exchange(tls, request(p.target, [...lines]));
    expect(answer.status).toBe(status);
    expect(answer.body).toContain(reason);
    expect(upstream.seen.length).toBe(before);
    await p.close();
  });

  it("refuses a CONNECT inside the tunnel", async () => {
    const p = await proxy();
    const tls = await p.open();
    const answer = await exchange(tls, "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n");
    expect(answer.status).toBe(405);
    expect(p.events.at(-1)?.refused).toBe("nested_connect");
    await p.close();
  });

  it("refuses a client that offers only HTTP/2", async () => {
    const p = await proxy();
    await expect(p.open(["h2"])).rejects.toThrow();
    await p.close();
  });

  it("reads the credential per request, so a rotated or revoked one takes effect at once", async () => {
    let current: string | null = "first-token-0123";
    const p = await proxy({
      credential: async () => {
        if (current === null) throw new Error("disconnected");
        return current;
      },
    });
    const before = upstream.seen.length;
    const send = async () =>
      exchange(
        await p.open(),
        request(p.target, [
          "GET / HTTP/1.1",
          "Host: {target}",
          `Authorization: Bearer ${PLACEHOLDER}`,
        ]),
      );
    await send();
    current = "second-token-4567";
    await send();
    current = null;
    const refused = await send();
    expect(upstream.seen.slice(before).map((r) => headerOf(r.rawHeaders, "authorization"))).toEqual(
      ["Bearer first-token-0123", "Bearer second-token-4567"],
    );
    expect(refused.status).toBe(503);
    expect(refused.body).toContain("credential_unavailable");
    await p.close();
  });

  it("verifies the upstream's certificate", async () => {
    const other = await createSandboxCa(["127.0.0.1"]);
    const p = await proxy({ upstreamCa: [other.certificate] });
    const before = upstream.seen.length;
    const answer = await exchange(
      await p.open(),
      request(p.target, [
        "GET / HTTP/1.1",
        "Host: {target}",
        `Authorization: Bearer ${PLACEHOLDER}`,
      ]),
    );
    expect(answer.status).toBe(502);
    expect(upstream.seen.length).toBe(before);
    await p.close();
  });

  it("serves several requests on one kept-alive connection, checking each", async () => {
    const p = await proxy();
    const before = upstream.seen.length;
    const tls = await p.open();
    const keepAlive = (auth: string) =>
      [
        `GET / HTTP/1.1`,
        `Host: ${p.target}`,
        `Authorization: ${auth}`,
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n");
    tls.write(keepAlive(`Bearer ${PLACEHOLDER}`));
    tls.write(keepAlive("Bearer stolen"));
    const answer = await exchange(
      tls,
      request(p.target, [
        "GET / HTTP/1.1",
        "Host: {target}",
        `Authorization: Bearer ${PLACEHOLDER}`,
      ]),
    );
    const statuses = [
      ...`${answer.head}\r\n\r\n${answer.body}`.matchAll(/HTTP\/1\.1 (\d{3})/g),
    ].map((m) => m[1]);
    expect(statuses).toEqual(["200", "403", "200"]);
    expect(upstream.seen.slice(before).map((r) => headerOf(r.rawHeaders, "authorization"))).toEqual(
      [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`],
    );
    await p.close();
  });

  it("rewrites a websocket upgrade like any request, then pipes it", async () => {
    const p = await proxy();
    const before = upstream.seen.length;
    const tls = await p.open();
    const reply = await new Promise<string>((resolve, reject) => {
      let text = "";
      tls.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\r\n\r\n") && text.includes("ping")) resolve(text);
        else if (text.includes("\r\n\r\n") && !text.includes("ping")) tls.write("ping");
      });
      tls.once("error", reject);
      tls.write(
        [
          `GET /socket HTTP/1.1`,
          `Host: ${p.target}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Authorization: Bearer ${PLACEHOLDER}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(headerOf(upstream.seen[before]?.rawHeaders ?? [], "authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    tls.destroy();
    await p.close();
  });

  it("refuses a credential host that isn't allowlisted", async () => {
    const ca = await createSandboxCa(["127.0.0.1"]);
    await expect(
      startEgressProxy({
        socketPath: join(dir, "bad.sock"),
        allow: ["api.github.com"],
        inject: {
          hosts: ["127.0.0.1:9"],
          intercept: { ca, auth: BEARER, placeholder: PLACEHOLDER, credential: async () => TOKEN },
        },
      }),
    ).rejects.toBeInstanceOf(EgressConfigError);
  });
});
