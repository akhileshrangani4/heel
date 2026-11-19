/**
 * Credential injection at heel's egress proxy (spec: CLI runner,
 * "Credential delivery"). The sandbox never holds the credential: the
 * program gets an inert placeholder, and for the hosts the credential is
 * meant for, the proxy terminates TLS with the sandbox's own CA, reads each
 * HTTP/1.1 request, and puts the real credential in the one place it belongs.
 *
 * The rules, each of which closes a way to get the credential back out:
 *
 * - Only the auth position is rewritten: the `Authorization` header (bearer,
 *   token or basic) or one named header. The placeholder anywhere else (the
 *   body, the query, another header) goes upstream unchanged, so a server
 *   that reflects a request can't be made to reflect the credential.
 * - That header must be absent or carry exactly the placeholder. Any other
 *   value is refused (`credential_mismatch`): it is not heel's to pass on,
 *   and a request with two of them is ambiguous.
 * - An absent header is forwarded without a credential; heel never adds one
 *   the program didn't ask for.
 * - `Host` must name the CONNECT target, and the request target must be a
 *   path, so one tunnel can't address another host.
 * - The upstream dial goes to the address the egress decision checked, and
 *   its TLS certificate is verified for the target host.
 * - HTTP/1.1 only: ALPN offers nothing else, and h2c upgrades and nested
 *   CONNECTs are refused. A websocket upgrade is rewritten like any request,
 *   then piped.
 * - Responses are scrubbed of the credential's predictable forms, headers
 *   always and bodies when they arrive unencoded (heel asks for identity).
 */
import { randomBytes } from "node:crypto";
import {
  type ClientRequest,
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { Transform } from "node:stream";
import {
  checkServerIdentity,
  createServer as createTlsServer,
  type PeerCertificate,
} from "node:tls";
import { hostRoots, type SandboxCa } from "./ca.ts";
import type { EgressTarget } from "./egress.ts";
import { base64Middles, createScrubber, credentialForms, scrubAll } from "./scrub.ts";

/** Where the credential goes in a request. */
export type CredentialAuth =
  /** `Authorization: <scheme> <credential>`, for any of these schemes. */
  | { readonly type: "authorization"; readonly schemes: readonly AuthScheme[] }
  /** One header that carries the credential alone, e.g. `X-Api-Key`. Lower-case. */
  | { readonly type: "header"; readonly name: string };

export type AuthScheme = "bearer" | "token" | "basic";

/** The placeholder every sandbox credential variable carries instead of the credential. */
export const PLACEHOLDER_PREFIX = "heel-placeholder-";

/** A fresh, random placeholder; it means nothing to any upstream. */
export function newPlaceholder(): string {
  return `${PLACEHOLDER_PREFIX}${randomBytes(20).toString("hex")}`;
}

/** Headers that frame a request; never a credential's header. */
const FRAMING_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "accept",
  "accept-encoding",
  "te",
  "upgrade",
  "trailer",
  "cookie",
  "proxy-authorization",
]);

/**
 * `bearer`, `basic` or `header:<Name>`, as `--credential-auth` takes it; null
 * for anything else. A query parameter is never accepted: heel would have to
 * rewrite the URL, and the placeholder in a URL is easy to reflect.
 */
export function parseCredentialAuth(text: string): CredentialAuth | null {
  if (text === "bearer" || text === "basic") return { type: "authorization", schemes: [text] };
  const match = /^header:([A-Za-z0-9-]{1,64})$/.exec(text);
  if (match?.[1] === undefined) return null;
  const name = match[1].toLowerCase();
  if (name === "authorization") return { type: "authorization", schemes: ["bearer"] };
  if (FRAMING_HEADERS.has(name)) return null;
  return { type: "header", name };
}

export type RewriteRefusal = "credential_mismatch" | "credential_unusable";

export type RewriteResult =
  | { readonly ok: true; readonly headers: string[]; readonly injected: boolean }
  | { readonly ok: false; readonly reason: RewriteRefusal };

/**
 * Pure: `rawHeaders` (name, value, name, value…) with the placeholder in the
 * auth position replaced by `credential`. Nothing else is touched.
 */
export function rewriteAuth(
  rawHeaders: readonly string[],
  auth: CredentialAuth,
  placeholder: string,
  credential: string,
): RewriteResult {
  // A credential that could end the header line would let it write headers of its own.
  if (credential === "" || /[\r\n\0]/.test(credential)) {
    return { ok: false, reason: "credential_unusable" };
  }
  const name = auth.type === "authorization" ? "authorization" : auth.name;
  const at: number[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name) at.push(i);
  }
  if (at.length === 0) return { ok: true, headers: [...rawHeaders], injected: false };
  if (at.length > 1) return { ok: false, reason: "credential_mismatch" };
  const index = at[0] as number;
  const value = (rawHeaders[index + 1] ?? "").trim();
  let replaced: string | undefined;
  if (auth.type === "header") replaced = value === placeholder ? credential : undefined;
  else replaced = rewriteAuthorization(value, auth.schemes, placeholder, credential);
  if (replaced === undefined) return { ok: false, reason: "credential_mismatch" };
  const headers = [...rawHeaders];
  headers[index + 1] = replaced;
  return { ok: true, headers, injected: true };
}

function rewriteAuthorization(
  value: string,
  schemes: readonly AuthScheme[],
  placeholder: string,
  credential: string,
): string | undefined {
  const match = /^([A-Za-z]+) +(\S+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const scheme = match[1];
  const lower = scheme.toLowerCase();
  if (!(schemes as readonly string[]).includes(lower)) return undefined;
  if (lower !== "basic") return match[2] === placeholder ? `${scheme} ${credential}` : undefined;
  const userinfo = decodeBase64Strict(match[2]);
  if (userinfo === undefined) return undefined;
  const colon = userinfo.indexOf(":");
  if (colon === -1) return undefined;
  const user = userinfo.slice(0, colon);
  const password = userinfo.slice(colon + 1);
  let rewritten: string;
  if (credential.includes(":")) {
    // A credential that is a whole `user:password` replaces the userinfo, from either slot.
    if (user === placeholder && password === "") rewritten = credential;
    else if (password === placeholder && user === "") rewritten = credential;
    else return undefined;
  } else if (password === placeholder && user !== placeholder) {
    rewritten = `${user}:${credential}`;
  } else if (user === placeholder && password !== placeholder) {
    rewritten = `${credential}:${password}`;
  } else {
    return undefined;
  }
  return `${scheme} ${Buffer.from(rewritten, "utf8").toString("base64")}`;
}

/** Base64 that decodes to valid UTF-8 and encodes back to exactly the same text. */
function decodeBase64Strict(text: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) return undefined;
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : undefined;
}

/** Pure: whether a `Host` header names the CONNECT target (port 443 may be left out). */
export function hostMatches(host: string | undefined, target: EgressTarget): boolean {
  if (host === undefined) return false;
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(host);
  const plain = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
  const parts = bracketed ?? plain;
  if (parts?.[1] === undefined) return false;
  const port = parts[2] === undefined ? 443 : Number(parts[2]);
  return parts[1].toLowerCase() === target.host && port === target.port;
}

/** Request headers that belong to one hop and are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

/**
 * Pure: the headers sent upstream: hop-by-hop ones dropped, identity encoding
 * asked for. `chunked` puts back the framing of a chunked request body: Node
 * decoded it, and without the header it would write the body raw, where the
 * upstream would read whatever it holds as the next request.
 */
export function forwardHeaders(
  rawHeaders: readonly string[],
  upgrade: boolean,
  chunked = false,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? "";
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "accept-encoding") continue;
    out.push(name, rawHeaders[i + 1] ?? "");
  }
  // Bodies heel can read are bodies heel can scrub.
  out.push("Accept-Encoding", "identity");
  if (chunked) out.push("Transfer-Encoding", "chunked");
  if (upgrade) out.push("Connection", "Upgrade", "Upgrade", "websocket");
  return out;
}

/** Defaults for the deadlines a sandboxed client gets inside a tunnel. */
const HEADER_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;

export interface InterceptOptions {
  readonly ca: SandboxCa;
  readonly auth: CredentialAuth;
  readonly placeholder: string;
  /** Read for each request, so a refreshed, revoked or paused credential takes effect at once. */
  readonly credential: () => Promise<string>;
  /** Trust roots for the upstream's certificate; the host's own when absent. Tests only. */
  readonly upstreamCa?: readonly string[];
  readonly connectTimeoutMs: number;
  /** How long a request's headers may take to arrive, from the first byte or the last response. */
  readonly headerTimeoutMs?: number;
  /** How long a tunnel may sit with no traffic either way. */
  readonly idleTimeoutMs?: number;
  /** One event per request heel read inside a tunnel, for audit. */
  readonly onRequest?: (event: InterceptEvent) => void;
}

export interface InterceptEvent {
  readonly target: EgressTarget;
  readonly method: string;
  /** The credential went upstream with this request. */
  readonly injected: boolean;
  /** Why heel answered the request itself instead of forwarding it. */
  readonly refused?: InterceptRefusal;
}

export type InterceptRefusal =
  | RewriteRefusal
  | "host_mismatch"
  | "bad_target"
  | "bad_framing"
  | "unsupported_upgrade"
  | "nested_connect"
  | "credential_unavailable"
  | "upstream_unreachable"
  | "upstream_bad_response";

/** One tunnel's context, shared by every request on it. */
interface Tunnel {
  readonly target: EgressTarget;
  readonly address: string;
  readonly options: InterceptOptions;
  /** Every socket the proxy owns, so closing it closes the upstream side too. */
  readonly sockets: Set<Socket>;
}

/**
 * Takes over a CONNECT tunnel to a credential host: answers it, terminates
 * TLS with a leaf from the sandbox CA, and serves HTTP/1.1 on it, forwarding
 * each request to `address` once its credential is in place.
 *
 * The http server here never listens, so Node's own header and request
 * timeouts never run: the deadlines are heel's.
 */
export async function intercept(
  client: Socket,
  target: EgressTarget,
  address: string,
  options: InterceptOptions,
  sockets: Set<Socket>,
): Promise<void> {
  const leaf = await options.ca.leaf(target.host);
  const tunnelContext: Tunnel = { target, address, options, sockets };
  const headerTimeoutMs = options.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
  const deadlines = new WeakMap<Socket, NodeJS.Timeout>();
  const arm = (socket: Socket): void => {
    clearTimeout(deadlines.get(socket));
    deadlines.set(
      socket,
      setTimeout(() => socket.destroy(), headerTimeoutMs),
    );
  };
  const disarm = (socket: Socket): void => clearTimeout(deadlines.get(socket));

  const http = createHttpServer({ requireHostHeader: true, joinDuplicateHeaders: false });
  http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    disarm(req.socket);
    // The next request on a kept-alive connection gets its own deadline.
    res.once("finish", () => arm(req.socket));
    handleRequest(req, res, tunnelContext).catch(() => res.destroy());
  });
  http.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    disarm(socket);
    handleUpgrade(req, socket, head, tunnelContext).catch(() => socket.destroy());
  });
  // A CONNECT inside the tunnel would open a tunnel heel can't see into.
  http.on("connect", (req: IncomingMessage, socket: Socket) => {
    disarm(socket);
    report(options, target, req.method ?? "CONNECT", "nested_connect");
    answer(socket, 405, "nested_connect");
  });
  // Anything Node's parser can't read as HTTP/1.x, including an HTTP/2 preface.
  http.on("clientError", (_error: Error, socket: Socket) => answer(socket, 400, "bad_request"));

  const tls = createTlsServer({
    cert: leaf.cert,
    key: leaf.key,
    ALPNProtocols: ["http/1.1"],
    minVersion: "TLSv1.2",
  });
  tls.on("secureConnection", (secure) => {
    // The http server drops its own listeners on an upgrade or a CONNECT; a reset must not go unhandled.
    secure.on("error", () => secure.destroy());
    secure.setTimeout(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => secure.destroy());
    sockets.add(secure);
    secure.on("close", () => {
      disarm(secure);
      sockets.delete(secure);
    });
    arm(secure);
    http.emit("connection", secure);
  });
  // A client that offers only h2, or doesn't trust the CA, never gets a request through.
  tls.on("tlsClientError", () => client.destroy());

  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  tls.emit("connection", client);
  client.resume();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tunnel: Tunnel,
): Promise<void> {
  const { target, options } = tunnel;
  const method = req.method ?? "GET";
  // Registered before the credential is read: a client gone by then gets nothing sent on its behalf.
  let gone = false;
  res.once("close", () => {
    gone = true;
  });
  const prepared = await prepare(req, tunnel);
  if (gone) return;
  if (!prepared.ok) {
    report(options, target, method, prepared.reason);
    req.resume();
    reply(res, prepared.status, prepared.reason);
    return;
  }
  const { headers, forms, injected, chunked } = prepared;
  const upstream = dial(tunnel, method, req.url ?? "/", forwardHeaders(headers, false, chunked));
  upstream.on("error", () => {
    if (!res.headersSent) {
      report(options, target, method, "upstream_unreachable");
      reply(res, 502, "upstream_unreachable");
    } else {
      res.destroy();
    }
  });
  upstream.on("response", (response) => {
    // Nothing thrown here may escape: this listener runs outside any promise heel awaits.
    try {
      const status = response.statusCode ?? 0;
      if (!isForwardableStatus(status)) {
        response.resume();
        upstream.destroy();
        report(options, target, method, "upstream_bad_response");
        reply(res, 502, "upstream_bad_response");
        return;
      }
      report(options, target, method, undefined, injected);
      const scrubBody = method !== "HEAD" && isIdentity(response.headers);
      res.writeHead(
        status,
        STATUS_CODES[status] ?? "Unknown",
        responseHeaders(response.rawHeaders, forms, scrubBody),
      );
      response.on("error", () => res.destroy());
      if (scrubBody) response.pipe(scrubbing(forms)).pipe(res);
      else response.pipe(res);
    } catch {
      upstream.destroy();
      res.destroy();
    }
  });
  res.once("close", () => upstream.destroy());
  req.pipe(upstream);
}

async function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  tunnel: Tunnel,
): Promise<void> {
  const { target, options } = tunnel;
  const method = req.method ?? "GET";
  let gone = false;
  socket.once("close", () => {
    gone = true;
  });
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    // h2c, or anything else that would change the protocol under heel.
    report(options, target, method, "unsupported_upgrade");
    answer(socket, 400, "unsupported_upgrade");
    return;
  }
  // An upgrade carries no body; one that claims to would leave bytes heel didn't frame.
  if (
    req.headers["transfer-encoding"] !== undefined ||
    Number(req.headers["content-length"] ?? 0) > 0
  ) {
    report(options, target, method, "bad_framing");
    answer(socket, 400, "bad_framing");
    return;
  }
  const prepared = await prepare(req, tunnel);
  if (gone) return;
  if (!prepared.ok) {
    report(options, target, method, prepared.reason);
    answer(socket, prepared.status, prepared.reason);
    return;
  }
  const { headers, forms, injected } = prepared;
  const upstream = dial(tunnel, method, req.url ?? "/", forwardHeaders(headers, true));
  socket.once("close", () => upstream.destroy());
  upstream.on("error", () => {
    report(options, target, method, "upstream_unreachable");
    answer(socket, 502, "upstream_unreachable");
  });
  // The upstream refused the upgrade: pass its answer back and end.
  upstream.on("response", (response) => {
    try {
      const status = response.statusCode ?? 0;
      if (!isForwardableStatus(status)) {
        response.resume();
        upstream.destroy();
        report(options, target, method, "upstream_bad_response");
        answer(socket, 502, "upstream_bad_response");
        return;
      }
      report(options, target, method, undefined, injected);
      socket.write(statusBlock(status, response.rawHeaders, forms, false));
      response.on("error", () => socket.destroy());
      response.pipe(scrubbing(forms)).pipe(socket);
    } catch {
      upstream.destroy();
      socket.destroy();
    }
  });
  upstream.on("upgrade", (response, upstreamSocket: Socket, upstreamHead: Buffer) => {
    try {
      tunnel.sockets.add(upstreamSocket);
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.on("close", () => {
        tunnel.sockets.delete(upstreamSocket);
        socket.destroy();
      });
      socket.on("error", () => upstreamSocket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      report(options, target, method, undefined, injected);
      socket.write(statusBlock(101, response.rawHeaders, forms, true));
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    } catch {
      upstreamSocket.destroy();
      socket.destroy();
    }
  });
  upstream.end();
}

type Prepared =
  | { ok: true; headers: string[]; forms: string[]; injected: boolean; chunked: boolean }
  | { ok: false; status: 400 | 403 | 503; reason: InterceptRefusal };

/** The checks every request inside the tunnel passes, then its rewritten headers. */
async function prepare(req: IncomingMessage, tunnel: Tunnel): Promise<Prepared> {
  const { target, options } = tunnel;
  // Origin-form only: an absolute URL could name a host other than the tunnel's.
  if (!(req.url ?? "").startsWith("/")) return { ok: false, status: 400, reason: "bad_target" };
  if (!hostMatches(singleHost(req.rawHeaders), target)) {
    return { ok: false, status: 403, reason: "host_mismatch" };
  }
  // Node only accepts `chunked` as the last coding; anything layered under it heel won't re-create.
  const encoding = req.headers["transfer-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "chunked") {
    return { ok: false, status: 400, reason: "bad_framing" };
  }
  let credential: string;
  try {
    credential = await options.credential();
  } catch {
    // Disconnected, revoked, paused, or a refresh that failed: nothing goes upstream.
    return { ok: false, status: 503, reason: "credential_unavailable" };
  }
  const rewritten = rewriteAuth(req.rawHeaders, options.auth, options.placeholder, credential);
  if (!rewritten.ok) return { ok: false, status: 403, reason: rewritten.reason };
  const sent = rewritten.injected ? authValue(rewritten.headers, options.auth) : undefined;
  return {
    ok: true,
    headers: rewritten.headers,
    forms: scrubForms(credential, options.auth, sent),
    injected: rewritten.injected,
    chunked: encoding !== undefined,
  };
}

/** The one `Host` header's value; undefined when there are none or several. */
function singleHost(rawHeaders: readonly string[]): string | undefined {
  const hosts: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "host") hosts.push(rawHeaders[i + 1] ?? "");
  }
  return hosts.length === 1 ? hosts[0] : undefined;
}

/** The value heel put in the auth position. */
function authValue(rawHeaders: readonly string[], auth: CredentialAuth): string | undefined {
  const name = auth.type === "authorization" ? "authorization" : auth.name;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name) return rawHeaders[i + 1];
  }
  return undefined;
}

/**
 * What the response scrub looks for: the credential's predictable forms, its
 * base64 at every byte alignment (an upstream that encodes what it received
 * puts it at an offset the sandbox can steer), and the exact value heel sent,
 * which for basic auth is base64 of a user name the sandbox chose followed by
 * the credential, aligned however that name makes it.
 */
function scrubForms(credential: string, auth: CredentialAuth, sent: string | undefined): string[] {
  const forms = new Set(credentialForms(credential, authType(auth)));
  for (const middle of base64Middles(credential)) forms.add(middle);
  if (sent !== undefined) {
    forms.add(sent);
    const space = sent.indexOf(" ");
    if (space !== -1) forms.add(sent.slice(space + 1));
  }
  return [...forms].filter((form) => form.length >= 4).sort((a, b) => b.length - a.length);
}

function dial(tunnel: Tunnel, method: string, path: string, headers: string[]): ClientRequest {
  const { target, address, options, sockets } = tunnel;
  const named = isIP(target.host) === 0;
  const requestOptions = {
    // The address the egress decision checked; never resolved again.
    host: address,
    port: target.port,
    ...(named ? { servername: target.host } : {}),
    ALPNProtocols: ["http/1.1"],
    agent: false,
    setHost: false,
    rejectUnauthorized: true,
    checkServerIdentity: (_host: string, cert: PeerCertificate) =>
      checkServerIdentity(target.host, cert),
    // The same roots the sandbox trusts for hosts heel tunnels blind.
    ca: options.upstreamCa === undefined ? hostRoots() : [...options.upstreamCa],
    method,
    path,
    headers,
  };
  const upstream = httpsRequest(requestOptions);
  upstream.once("socket", (socket: Socket) => {
    sockets.add(socket);
    // Gives up on an upstream that hasn't finished its TLS handshake in time; a slow answer is fine.
    const timer = setTimeout(
      () => upstream.destroy(new Error("connect timeout")),
      options.connectTimeoutMs,
    );
    socket.once("secureConnect", () => clearTimeout(timer));
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  return upstream;
}

/** A final status heel will pass on: informational and out-of-range ones become a 502. */
function isForwardableStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status <= 599;
}

function authType(auth: CredentialAuth): { type: string } {
  return {
    type: auth.type === "authorization" && auth.schemes.includes("basic") ? "basic" : "bearer",
  };
}

function isIdentity(headers: IncomingHttpHeaders): boolean {
  const encoding = headers["content-encoding"];
  return encoding === undefined || encoding.trim().toLowerCase() === "identity";
}

/** Response headers with hop-by-hop ones dropped and the credential's forms scrubbed. */
function responseHeaders(
  rawHeaders: readonly string[],
  forms: readonly string[],
  scrubBody: boolean,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? "";
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // A scrubbed body can change length; Node frames it instead.
    if (scrubBody && lower === "content-length") continue;
    out.push(
      name,
      scrubAll(Buffer.from(rawHeaders[i + 1] ?? "", "latin1"), forms).toString("latin1"),
    );
  }
  return out;
}

/**
 * A raw status line and headers, for a socket heel writes to directly. The
 * reason phrase is the standard one, never the upstream's.
 */
function statusBlock(
  status: number,
  rawHeaders: readonly string[],
  forms: readonly string[],
  upgrade: boolean,
): string {
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Unknown"}`];
  const headers = responseHeaders(rawHeaders, forms, false);
  for (let i = 0; i < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`);
  if (upgrade) lines.push("Connection: Upgrade", "Upgrade: websocket");
  else lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function scrubbing(forms: readonly string[]): Transform {
  const scrubber = createScrubber(forms);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, scrubber.push(chunk));
    },
    flush(callback) {
      callback(null, scrubber.end());
    },
  });
}

function report(
  options: InterceptOptions,
  target: EgressTarget,
  method: string,
  refused: InterceptRefusal | undefined,
  injected = false,
): void {
  try {
    options.onRequest?.({
      target,
      method,
      injected,
      ...(refused === undefined ? {} : { refused }),
    });
  } catch {
    // An audit hook that throws must not take a request, or heel, down with it.
  }
}

function reply(res: ServerResponse, status: number, reason: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = `heel: request refused (${reason})\n`;
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function answer(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return;
  const body = `heel: request refused (${reason})\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
