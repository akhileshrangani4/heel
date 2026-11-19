/**
 * Regressions from the security review of credential injection at the egress
 * proxy (PR #78). Each test pins one way the proxy could leak the credential,
 * crash heel, let a request past its checks, or hold resources.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createSandboxCa } from "../../src/runner/ca.ts";
import { type EgressProxyOptions, startEgressProxy } from "../../src/runner/egress.ts";
import { type CredentialAuth, PLACEHOLDER_PREFIX } from "../../src/runner/intercept.ts";
import { httpsUpstream, rawTlsUpstream } from "../helpers/https-upstream.ts";
import { exchange, request, secure, tunnel } from "../helpers/proxy-client.ts";
import { leakedForms } from "../helpers/token-forms.ts";

/** Made per run: a fixed random-looking string here reads as a leaked secret to scanners. */
const TOKEN = randomBytes(24).toString("base64url");
const PLACEHOLDER = `${PLACEHOLDER_PREFIX}0123456789abcdef0123`;
const BEARER: CredentialAuth = { type: "authorization", schemes: ["bearer"] };
const BASIC: CredentialAuth = { type: "authorization", schemes: ["basic"] };
const b64 = (text: string) => Buffer.from(text).toString("base64");

let dir: string;
let count = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "heel-harden-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A proxy injecting into `127.0.0.1:<port>`, with a client that opens tunnels through it. */
async function proxyTo(
  port: number,
  upstreamCa: string,
  options: {
    auth?: CredentialAuth;
    credential?: () => Promise<string>;
    intercept?: { headerTimeoutMs?: number; idleTimeoutMs?: number };
    proxy?: Partial<Pick<EgressProxyOptions, "headTimeoutMs" | "maxConnections">>;
  } = {},
) {
  const target = `127.0.0.1:${port}`;
  const ca = await createSandboxCa(["127.0.0.1"]);
  const started = await startEgressProxy({
    socketPath: join(dir, `h${count++}.sock`),
    allow: [target],
    ...options.proxy,
    inject: {
      hosts: [target],
      intercept: {
        ca,
        auth: options.auth ?? BEARER,
        placeholder: PLACEHOLDER,
        credential: options.credential ?? (async () => TOKEN),
        upstreamCa: [upstreamCa],
        ...options.intercept,
      },
    },
  });
  onTestFinished(() => started.close());
  return {
    target,
    socketPath: started.socketPath,
    async open() {
      const { status, socket } = await tunnel(started.socketPath, target);
      expect(status).toBe("HTTP/1.1 200 Connection Established");
      const tls = await secure(socket, ca.certificate);
      tls.on("error", () => {});
      return Object.assign(tls, { raw: socket });
    },
    close: () => started.close(),
  };
}

async function raw(respond: Parameters<typeof rawTlsUpstream>[0]) {
  const upstream = await rawTlsUpstream(respond);
  onTestFinished(() => upstream.close());
  return upstream;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the response scrub", () => {
  it("catches a basic credential re-aligned by a user name the sandbox chose", async () => {
    const upstream = await httpsUpstream();
    onTestFinished(() => upstream.close());
    const p = await proxyTo(upstream.port, upstream.ca, { auth: BASIC });
    for (const user of ["", "a", "ab", "abc"]) {
      const answer = await exchange(
        await p.open(),
        request(p.target, [
          "GET / HTTP/1.1",
          "Host: {target}",
          `Authorization: Basic ${b64(`${user}:${PLACEHOLDER}`)}`,
        ]),
      );
      expect(answer.status).toBe(200);
      expect(leakedForms(answer.body, TOKEN), `user ${JSON.stringify(user)}`).toEqual([]);
    }
  });

  it("catches the credential base64-encoded at any offset by an upstream that encodes what it got", async () => {
    // The upstream answers with the whole request it received, base64-encoded.
    const upstream = await raw((received, socket) => {
      const body = received.toString("base64");
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    });
    for (const pad of ["", "x", "xy"]) {
      const p = await proxyTo(upstream.port, upstream.ca);
      const answer = await exchange(
        await p.open(),
        request(p.target, [
          `GET /${pad} HTTP/1.1`,
          "Host: {target}",
          `Authorization: Bearer ${PLACEHOLDER}`,
        ]),
      );
      expect(leakedForms(answer.body, TOKEN), `pad ${JSON.stringify(pad)}`).toEqual([]);
    }
  });

  it("never passes the upstream's reason phrase through", async () => {
    const upstream = await raw((_received, socket) => {
      socket.end(`HTTP/1.1 200 OK ${TOKEN}\r\nContent-Length: 2\r\n\r\nhi`);
    });
    const p = await proxyTo(upstream.port, upstream.ca);
    const answer = await exchange(
      await p.open(),
      request(p.target, [
        "GET / HTTP/1.1",
        "Host: {target}",
        `Authorization: Bearer ${PLACEHOLDER}`,
      ]),
    );
    expect(answer.head.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect(answer.head).not.toContain(TOKEN);
  });
});

describe("a hostile upstream", () => {
  it.each([
    ["status 099", "HTTP/1.1 099 Odd\r\nContent-Length: 0\r\n\r\n"],
    ["status 1000", "HTTP/1.1 1000 Odd\r\nContent-Length: 0\r\n\r\n"],
  ])("answering with %s gets the client a 502, and heel keeps running", async (_, line) => {
    const upstream = await raw((_received, socket) => socket.end(line));
    const p = await proxyTo(upstream.port, upstream.ca);
    const answer = await exchange(
      await p.open(),
      request(p.target, ["GET / HTTP/1.1", "Host: {target}"]),
    );
    expect(answer.status).toBe(502);
  });

  it("answering an upgrade with a bad status gets the client a 502", async () => {
    const upstream = await raw((_received, socket) =>
      socket.end("HTTP/1.1 099 Odd\r\nContent-Length: 0\r\n\r\n"),
    );
    const p = await proxyTo(upstream.port, upstream.ca);
    const answer = await exchange(
      await p.open(),
      [
        "GET /socket HTTP/1.1",
        `Host: ${p.target}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "",
        "",
      ].join("\r\n"),
    );
    expect(answer.status).toBe(502);
  });
});

describe("request framing", () => {
  it.each(["GET", "DELETE", "OPTIONS"])(
    "re-frames a chunked %s body, so nothing in it can ride along as a second request",
    async (method) => {
      const upstream = await raw((_received, socket) =>
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
      );
      const p = await proxyTo(upstream.port, upstream.ca);
      const smuggled = `GET /smuggled HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer stolen\r\n\r\n`;
      const chunk = `${Buffer.byteLength(smuggled).toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`;
      await exchange(
        await p.open(),
        `${method} / HTTP/1.1\r\nHost: ${p.target}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}`,
      );
      await settle(100);
      const wire = upstream.received[0]?.toString("latin1") ?? "";
      const [head = "", body = ""] = wire.split(/\r\n\r\n([\s\S]*)/);
      expect(head).toMatch(/^.* \/ HTTP\/1\.1\r\n/);
      expect(head.toLowerCase()).toContain("transfer-encoding: chunked");
      // The upstream reads exactly one chunked body: the smuggled request is data inside it.
      expect(body.startsWith(`${Buffer.byteLength(smuggled).toString(16)}\r\nGET /smuggled`)).toBe(
        true,
      );
      expect(body.endsWith("\r\n0\r\n\r\n")).toBe(true);
    },
  );

  it("keeps a Content-Length body exactly as sent", async () => {
    const upstream = await raw((_received, socket) =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
    );
    const p = await proxyTo(upstream.port, upstream.ca);
    await exchange(
      await p.open(),
      request(p.target, ["DELETE /x HTTP/1.1", "Host: {target}"], "hello"),
    );
    await settle(100);
    const wire = upstream.received[0]?.toString("latin1") ?? "";
    expect(wire.toLowerCase()).toContain("content-length: 5");
    expect(wire.endsWith("\r\n\r\nhello")).toBe(true);
  });
});

describe("resources", () => {
  it("doesn't send the authenticated request when the client left while heel read the credential", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = await raw((_received, socket) =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
    );
    const p = await proxyTo(upstream.port, upstream.ca, {
      credential: async () => {
        await gate;
        return TOKEN;
      },
    });
    for (const upgrade of [false, true]) {
      const tls = await p.open();
      tls.write(
        [
          "GET / HTTP/1.1",
          `Host: ${p.target}`,
          `Authorization: Bearer ${PLACEHOLDER}`,
          ...(upgrade ? ["Connection: Upgrade", "Upgrade: websocket"] : []),
          "",
          "",
        ].join("\r\n"),
      );
      await settle(50);
      tls.destroy();
    }
    await settle(50);
    release();
    await settle(150);
    expect(upstream.received).toEqual([]);
  });

  it("closes the upstream when a websocket client leaves before the upstream answers", async () => {
    const upstream = await raw(() => {}); // never answers
    const p = await proxyTo(upstream.port, upstream.ca);
    const tls = await p.open();
    tls.write(
      [
        "GET / HTTP/1.1",
        `Host: ${p.target}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "",
        "",
      ].join("\r\n"),
    );
    await settle(150);
    expect(upstream.open()).toBe(1);
    tls.destroy();
    await settle(150);
    expect(upstream.open()).toBe(0);
  });

  it("closing the proxy closes upstream connections still waiting for an answer", async () => {
    const upstream = await raw(() => {}); // never answers
    const p = await proxyTo(upstream.port, upstream.ca);
    const tls = await p.open();
    tls.write(["GET / HTTP/1.1", `Host: ${p.target}`, "", ""].join("\r\n"));
    await settle(150);
    expect(upstream.open()).toBe(1);
    await p.close();
    await settle(150);
    expect(upstream.open()).toBe(0);
  });

  it("drops a client that dribbles request headers past the deadline", async () => {
    const upstream = await raw((_received, socket) =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
    );
    const p = await proxyTo(upstream.port, upstream.ca, { intercept: { headerTimeoutMs: 300 } });
    const tls = await p.open();
    let closed = false;
    tls.on("close", () => {
      closed = true;
    });
    tls.write("GET / HTTP/1.1\r\n");
    for (let i = 0; i < 6; i++) {
      await settle(100);
      if (!closed) tls.write(`X-Slow-${i}: 1\r\n`);
    }
    expect(closed).toBe(true);
  });

  it("drops a CONNECT whose head never finishes", async () => {
    const upstream = await raw(() => {});
    const p = await proxyTo(upstream.port, upstream.ca, { proxy: { headTimeoutMs: 200 } });
    const socket = connect(p.socketPath);
    socket.on("error", () => {});
    socket.resume();
    socket.write("CONNECT 127.0.0.1:1 HTTP/1.1\r\n");
    const closed = await new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
    });
    expect(closed).toBe(true);
  });

  it("refuses connections past its cap", async () => {
    const upstream = await raw(() => {});
    const p = await proxyTo(upstream.port, upstream.ca, { proxy: { maxConnections: 2 } });
    const held = [await tunnel(p.socketPath, p.target), await tunnel(p.socketPath, p.target)];
    expect(held.map((h) => h.status)).toEqual([
      "HTTP/1.1 200 Connection Established",
      "HTTP/1.1 200 Connection Established",
    ]);
    const third = await tunnel(p.socketPath, p.target);
    expect(third.status).toBe("HTTP/1.1 503 Service Unavailable");
    third.socket.destroy();
    for (const h of held) h.socket.destroy();
    await settle(50);
    const fourth = await tunnel(p.socketPath, p.target);
    expect(fourth.status).toBe("HTTP/1.1 200 Connection Established");
    fourth.socket.destroy();
  });
});
