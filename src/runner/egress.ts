/**
 * heel's egress proxy (spec: CLI runner, "Network"). A sandbox has its own
 * network namespace with nothing but loopback; its only route out is this
 * proxy, reached through a Unix socket bind-mounted into the sandbox. The
 * proxy speaks HTTP `CONNECT` and opens a tunnel only to an allowlisted
 * `host:port`. A client that ignores the proxy has no route at all.
 *
 * A hostname that resolves to a loopback, private or link-local address is
 * refused even when allowlisted, so a DNS record can't point a CLI at heel's
 * own planes or the host's LAN. An IP literal is reached only when the
 * allowlist names that literal.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, connect, createServer, isIP, type Server, type Socket } from "node:net";

export interface EgressTarget {
  /** Lower-cased hostname or IP literal (IPv6 without brackets). */
  readonly host: string;
  readonly port: number;
}

export type EgressDecision =
  | { readonly allowed: true; readonly target: EgressTarget; readonly address: string }
  | {
      readonly allowed: false;
      readonly target?: EgressTarget;
      readonly reason: "bad_request" | "not_allowlisted" | "private_address" | "resolve_failed";
    };

export interface EgressProxyOptions {
  /** Where to listen; the caller owns the directory and its permissions. */
  readonly socketPath: string;
  /** `host` (port 443) or `host:port`, e.g. `api.github.com`, `example.com:8443`, `[::1]:9000`. */
  readonly allow: readonly string[];
  /** Called once per CONNECT, for audit. */
  readonly onDecision?: (decision: EgressDecision) => void;
  /** A connection failed for a reason other than the decision or the network; it was closed. */
  readonly onError?: (error: unknown) => void;
  /** Injectable for tests; defaults to the system resolver. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly connectTimeoutMs?: number;
}

export interface EgressProxy {
  readonly socketPath: string;
  close(): Promise<void>;
}

export class EgressConfigError extends Error {
  override readonly name = "EgressConfigError";
}

const DEFAULT_PORT = 443;
const MAX_HEADER_BYTES = 8 * 1024;
const HEADER_END = Buffer.from("\r\n\r\n");

/** Parses allowlist entries; throws on anything that isn't `host[:port]`. */
export function parseEgressAllow(entries: readonly string[]): EgressTarget[] {
  return entries.map((entry) => {
    const target = parseHostPort(entry, DEFAULT_PORT);
    if (target === undefined)
      throw new EgressConfigError(`bad egress allowlist entry: ${JSON.stringify(entry)}`);
    return target;
  });
}

export function isAllowlisted(allow: readonly EgressTarget[], target: EgressTarget): boolean {
  return allow.some((entry) => entry.host === target.host && entry.port === target.port);
}

/** The target of a `CONNECT host:port HTTP/1.x` request line; undefined for anything else. */
export function parseConnectRequest(head: string): EgressTarget | undefined {
  const line = head.split("\r\n", 1)[0] ?? "";
  const match = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(line);
  return match?.[1] === undefined ? undefined : parseHostPort(match[1], undefined);
}

/**
 * `host:port`, `[v6]:port`, or (with a default port) a bare host. Hostnames
 * must be plain DNS labels; userinfo, paths and percent-encoding are rejected.
 */
export function parseHostPort(
  text: string,
  defaultPort: number | undefined,
): EgressTarget | undefined {
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(text);
  let host: string;
  let portText: string | undefined;
  if (bracketed?.[1] !== undefined) {
    host = bracketed[1];
    portText = bracketed[2];
    if (isIP(host) !== 6) return undefined;
  } else {
    const plain = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text);
    if (plain?.[1] === undefined) return undefined;
    host = plain[1];
    portText = plain[2];
    if (isIP(host) === 0 && !isHostname(host)) return undefined;
  }
  const port = portText === undefined ? defaultPort : Number(portText);
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: host.toLowerCase(), port };
}

function isHostname(host: string): boolean {
  return (
    host.length <= 253 &&
    host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

// One list per family: a BlockList checks an IPv4 address against its IPv6 rules too, as
// ::ffff:a.b.c.d, so ::ffff:0:0/96 in a shared list would match every IPv4 address.
const NON_PUBLIC_V4 = new BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(prefix, bits, "ipv4");
}
const NON_PUBLIC_V6 = new BlockList();
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_V6.addSubnet(prefix, bits, "ipv6");
}

/** Loopback, private, link-local, CGNAT, multicast, reserved, and v6 forms that embed v4. */
export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !NON_PUBLIC_V4.check(address, "ipv4");
    case 6:
      return !NON_PUBLIC_V6.check(address, "ipv6");
    default:
      return false;
  }
}

/**
 * Decides one CONNECT. Pure apart from `resolve`: an allowlisted IP literal
 * is used as is; an allowlisted name must resolve only to public addresses,
 * and the tunnel goes to the first one, so the address checked is the
 * address dialled.
 */
export async function decideEgress(
  allow: readonly EgressTarget[],
  target: EgressTarget | undefined,
  resolve: (host: string) => Promise<readonly string[]>,
): Promise<EgressDecision> {
  if (target === undefined) return { allowed: false, reason: "bad_request" };
  if (!isAllowlisted(allow, target)) return { allowed: false, target, reason: "not_allowlisted" };
  if (isIP(target.host) !== 0) return { allowed: true, target, address: target.host };
  let addresses: readonly string[];
  try {
    addresses = await resolve(target.host);
  } catch {
    return { allowed: false, target, reason: "resolve_failed" };
  }
  const first = addresses[0];
  if (first === undefined) return { allowed: false, target, reason: "resolve_failed" };
  if (!addresses.every(isPublicAddress))
    return { allowed: false, target, reason: "private_address" };
  return { allowed: true, target, address: first };
}

async function systemResolve(host: string): Promise<readonly string[]> {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

/** Starts the proxy on `socketPath`. Every connection is one CONNECT, then a raw tunnel. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allow = parseEgressAllow(options.allow);
  const resolve = options.resolve ?? systemResolve;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    readHead(client)
      .then(async ({ head, rest }) => {
        const decision = await decideEgress(
          allow,
          head === undefined ? undefined : parseConnectRequest(head),
          resolve,
        );
        options.onDecision?.(decision);
        if (!decision.allowed) {
          refuse(client, decision.reason === "bad_request" ? 400 : 403, decision.reason);
          return;
        }
        tunnel(client, rest, decision.address, decision.target.port, connectTimeoutMs, sockets);
      })
      .catch((error: unknown) => {
        client.destroy();
        options.onError?.(error);
      });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  return {
    socketPath: options.socketPath,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  };
}

/** Reads up to the end of the request headers; `head` is undefined when they're too long or cut off. */
function readHead(client: Socket): Promise<{ head: string | undefined; rest: Buffer }> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(HEADER_END);
      if (end !== -1) {
        finish(
          buffered.subarray(0, end).toString("latin1"),
          buffered.subarray(end + HEADER_END.length),
        );
      } else if (buffered.length > MAX_HEADER_BYTES) {
        finish(undefined, Buffer.alloc(0));
      }
    };
    const onEnd = (): void => finish(undefined, Buffer.alloc(0));
    const finish = (head: string | undefined, rest: Buffer): void => {
      client.off("data", onData);
      client.off("end", onEnd);
      client.pause();
      resolve({ head, rest });
    };
    client.on("data", onData);
    client.on("end", onEnd);
  });
}

function refuse(client: Socket, status: 400 | 403 | 502, reason: string): void {
  const text = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway";
  const body = `heel: egress refused (${reason})\n`;
  client.end(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function tunnel(
  client: Socket,
  early: Buffer,
  address: string,
  port: number,
  timeoutMs: number,
  sockets: Set<Socket>,
): void {
  const upstream = connect({ host: address, port });
  let established = false;
  sockets.add(upstream);
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("connect timeout")));
  upstream.once("connect", () => {
    established = true;
    upstream.setTimeout(0);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (early.length > 0) upstream.write(early);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  // The client sees the failure either as a 502 (before the tunnel opened) or as the tunnel closing.
  upstream.on("error", () => {
    if (!established) refuse(client, 502, "upstream_unreachable");
  });
  upstream.on("close", () => {
    sockets.delete(upstream);
    if (established) client.destroy();
  });
  client.on("close", () => upstream.destroy());
}
