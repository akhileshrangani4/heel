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
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { Transform } from "node:stream";
import {
  checkServerIdentity,
  createServer as createTlsServer,
  type PeerCertificate,
} from "node:tls";
import type { SandboxCa } from "./ca.ts";
import type { EgressTarget } from "./egress.ts";
import { createScrubber, credentialForms, scrubAll } from "./scrub.ts";

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

/** Pure: the headers sent upstream: hop-by-hop ones dropped, identity encoding asked for. */
export function forwardHeaders(rawHeaders: readonly string[], upgrade: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? "";
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "accept-encoding") continue;
    out.push(name, rawHeaders[i + 1] ?? "");
  }
  // Bodies heel can read are bodies heel can scrub.
  out.push("Accept-Encoding", "identity");
  if (upgrade) out.push("Connection", "Upgrade", "Upgrade", "websocket");
  return out;
}

export interface InterceptOptions {
  readonly ca: SandboxCa;
  readonly auth: CredentialAuth;
  readonly placeholder: string;
  /** Read for each request, so a refreshed or revoked credential takes effect at once. */
  readonly credential: () => Promise<string>;
  /** Trust roots for the upstream's certificate; Node's own when absent. Tests only. */
  readonly upstreamCa?: readonly string[];
  readonly connectTimeoutMs: number;
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
  | "unsupported_upgrade"
  | "nested_connect"
  | "credential_unavailable"
  | "upstream_unreachable";

/**
 * Takes over a CONNECT tunnel to a credential host: answers it, terminates
 * TLS with a leaf from the sandbox CA, and serves HTTP/1.1 on it, forwarding
 * each request to `address` once its credential is in place.
 */
export async function intercept(
  client: Socket,
  target: EgressTarget,
  address: string,
  options: InterceptOptions,
  sockets: Set<Socket>,
): Promise<void> {
  const leaf = await options.ca.leaf(target.host);
  const http = createHttpServer({ requireHostHeader: true, joinDuplicateHeaders: false });
  http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, target, address, options).catch(() => res.destroy());
  });
  http.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void handleUpgrade(req, socket, head, target, address, options).catch(() => socket.destroy());
  });
  // A CONNECT inside the tunnel would open a tunnel heel can't see into.
  http.on("connect", (req: IncomingMessage, socket: Socket) => {
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
    sockets.add(secure);
    secure.on("close", () => sockets.delete(secure));
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
  target: EgressTarget,
  address: string,
  options: InterceptOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  const prepared = await prepare(req, target, options);
  if (!prepared.ok) {
    report(options, target, method, prepared.reason);
    req.resume();
    reply(res, prepared.status, prepared.reason);
    return;
  }
  const { headers, credential, injected } = prepared;
  const upstream = httpsRequest({
    ...dialOptions(target, address, options),
    method,
    path: req.url,
    headers: forwardHeaders(headers, false),
  });
  connectTimeout(upstream, options.connectTimeoutMs);
  upstream.on("error", () => {
    if (!res.headersSent) {
      report(options, target, method, "upstream_unreachable");
      reply(res, 502, "upstream_unreachable");
    } else {
      res.destroy();
    }
  });
  upstream.on("response", (response) => {
    report(options, target, method, undefined, injected);
    const forms = credentialForms(credential, authType(options.auth));
    const scrubBody = method !== "HEAD" && isIdentity(response.headers);
    res.writeHead(
      response.statusCode ?? 502,
      response.statusMessage,
      responseHeaders(response.rawHeaders, forms, scrubBody),
    );
    if (scrubBody) response.pipe(scrubbing(forms)).pipe(res);
    else response.pipe(res);
    response.on("error", () => res.destroy());
  });
  req.pipe(upstream);
  res.on("close", () => upstream.destroy());
}

async function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: EgressTarget,
  address: string,
  options: InterceptOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    // h2c, or anything else that would change the protocol under heel.
    report(options, target, method, "unsupported_upgrade");
    answer(socket, 400, "unsupported_upgrade");
    return;
  }
  const prepared = await prepare(req, target, options);
  if (!prepared.ok) {
    report(options, target, method, prepared.reason);
    answer(socket, prepared.status, prepared.reason);
    return;
  }
  const { headers, credential, injected } = prepared;
  const forms = credentialForms(credential, authType(options.auth));
  const upstream = httpsRequest({
    ...dialOptions(target, address, options),
    method,
    path: req.url,
    headers: forwardHeaders(headers, true),
  });
  connectTimeout(upstream, options.connectTimeoutMs);
  upstream.on("error", () => {
    report(options, target, method, "upstream_unreachable");
    answer(socket, 502, "upstream_unreachable");
  });
  // The upstream refused the upgrade: pass its answer back and end.
  upstream.on("response", (response) => {
    report(options, target, method, undefined, injected);
    socket.write(statusBlock(response, forms, false));
    response.pipe(scrubbing(forms)).pipe(socket);
  });
  upstream.on("upgrade", (response, upstreamSocket: Socket, upstreamHead: Buffer) => {
    report(options, target, method, undefined, injected);
    socket.write(statusBlock(response, forms, true));
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => socket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
  });
  upstream.end();
}

type Prepared =
  | { ok: true; headers: string[]; credential: string; injected: boolean }
  | { ok: false; status: 400 | 403 | 503; reason: InterceptRefusal };

/** The checks every request inside the tunnel passes, then its rewritten headers. */
async function prepare(
  req: IncomingMessage,
  target: EgressTarget,
  options: InterceptOptions,
): Promise<Prepared> {
  // Origin-form only: an absolute URL could name a host other than the tunnel's.
  if (!(req.url ?? "").startsWith("/")) return { ok: false, status: 400, reason: "bad_target" };
  if (!hostMatches(singleHost(req.rawHeaders), target)) {
    return { ok: false, status: 403, reason: "host_mismatch" };
  }
  let credential: string;
  try {
    credential = await options.credential();
  } catch {
    // Disconnected, revoked, or a refresh that failed: nothing goes upstream.
    return { ok: false, status: 503, reason: "credential_unavailable" };
  }
  const rewritten = rewriteAuth(req.rawHeaders, options.auth, options.placeholder, credential);
  if (!rewritten.ok) return { ok: false, status: 403, reason: rewritten.reason };
  return { ok: true, headers: rewritten.headers, credential, injected: rewritten.injected };
}

/** The one `Host` header's value; undefined when there are none or several. */
function singleHost(rawHeaders: readonly string[]): string | undefined {
  const hosts: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "host") hosts.push(rawHeaders[i + 1] ?? "");
  }
  return hosts.length === 1 ? hosts[0] : undefined;
}

function dialOptions(target: EgressTarget, address: string, options: InterceptOptions) {
  const named = isIP(target.host) === 0;
  return {
    // The address the egress decision checked; never resolved again.
    host: address,
    port: target.port,
    ...(named ? { servername: target.host } : {}),
    ALPNProtocols: ["http/1.1"],
    agent: false as const,
    setHost: false,
    rejectUnauthorized: true,
    checkServerIdentity: (_host: string, cert: PeerCertificate) =>
      checkServerIdentity(target.host, cert),
    ...(options.upstreamCa === undefined ? {} : { ca: [...options.upstreamCa] }),
  };
}

/** Gives up on an upstream that hasn't finished its TLS handshake in time; a slow answer is fine. */
function connectTimeout(upstream: ClientRequest, ms: number): void {
  upstream.once("socket", (socket: Socket) => {
    const timer = setTimeout(() => upstream.destroy(new Error("connect timeout")), ms);
    socket.once("secureConnect", () => clearTimeout(timer));
    socket.once("close", () => clearTimeout(timer));
  });
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

/** A raw status line and headers, for a socket heel writes to directly. */
function statusBlock(
  response: IncomingMessage,
  forms: readonly string[],
  upgrade: boolean,
): string {
  const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}`];
  const headers = responseHeaders(response.rawHeaders, forms, false);
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
  options.onRequest?.({ target, method, injected, ...(refused === undefined ? {} : { refused }) });
}

function reply(res: ServerResponse, status: number, reason: string): void {
  if (res.headersSent) {
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

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function answer(socket: Socket, status: number, reason: string): void {
  const body = `heel: request refused (${reason})\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
