import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/client";
import { isPublicAddress } from "../../runner/egress.ts";

/**
 * Keeping heel on the public internet for a server an agent named
 * (roadmap 2.5). An approved connection request must not give the agent
 * heel's place on the network: the server it named, every redirect it
 * answers with, and every OAuth endpoint its metadata names, must be https
 * on a public host name that resolves only to public addresses.
 *
 * Servers the operator connects with `heel connect` aren't held to this:
 * a local MCP server on http://localhost is a normal setup there.
 */

/** Names that only mean something on a private network. */
const PRIVATE_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
];

/**
 * Pure: whether a URL may be contacted for an agent. https only, a host name
 * (no IP address), not `localhost` or a single-label or private-only name,
 * and no user name or password (`https://good.com@evil.com`). Null when it
 * may; what the name resolves to is checked separately (`publicHostProblem`).
 */
export function publicUrlProblem(text: string): string | null {
  if (!URL.canParse(text)) return "the url doesn't parse";
  const url = new URL(text);
  if (url.protocol !== "https:") return "the url must be https://";
  if (url.username !== "" || url.password !== "")
    return "the url can't carry a user name or password";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0)
    return "the url must name a host, not an IP address";
  if (
    host === "localhost" ||
    !host.includes(".") ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return "the url must name a public host";
  }
  return null;
}

/** Every address a host name resolves to. */
export async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/** Whether a URL's host resolves only to public addresses. Null when it does. */
export async function publicHostProblem(
  url: string,
  resolve: (host: string) => Promise<readonly string[]>,
): Promise<string | null> {
  const host = new URL(url).hostname;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return `${host} doesn't resolve`;
  }
  if (addresses.length === 0) return `${host} doesn't resolve`;
  if (!addresses.every(isPublicAddress)) {
    return `${host} points to a private address, so heel won't connect to it for an agent`;
  }
  return null;
}

/** A hop heel refused: the URL, and why. */
export class NotPublicError extends Error {
  override readonly name = "NotPublicError";
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * A fetch that contacts only public https hosts, and follows redirects
 * itself so every hop is checked the same way. A redirect to another origin
 * drops the Authorization header, as browsers do. TLS certificate checks
 * keep a public name from being re-pointed at an internal https server
 * between the check and the connection.
 */
export function publicOnlyFetch(
  inner: FetchLike = fetch,
  resolve: (host: string) => Promise<readonly string[]> = resolveAll,
): FetchLike {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    if (input instanceof Request && input.body !== null) {
      // A stream body can't be checked hop by hop or sent again after a redirect.
      throw new NotPublicError("heel sends a request with a body to this server only as text");
    }
    let request: RequestInit =
      input instanceof Request ? { ...requestInit(input), ...init } : { ...init };
    if (request.body instanceof ReadableStream) {
      throw new NotPublicError("heel sends a request with a body to this server only as text");
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const problem = publicUrlProblem(url.href) ?? (await publicHostProblem(url.href, resolve));
      if (problem !== null) throw new NotPublicError(`heel won't contact ${url.href}: ${problem}`);
      const response = await inner(url, { ...request, redirect: "manual" });
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null) return response;
      // Free the connection: the redirect's own body is never read.
      await response.body?.cancel().catch(() => {});
      const next = new URL(location, url);
      const method = (request.method ?? "GET").toUpperCase();
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        const headers = new Headers(request.headers);
        for (const name of ["content-type", "content-length", "content-encoding"])
          headers.delete(name);
        request = { ...request, method: "GET", body: null, headers };
      }
      if (next.origin !== url.origin) {
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        request = { ...request, headers };
      }
      url = next;
    }
    throw new NotPublicError(`heel stopped after ${MAX_REDIRECTS} redirects`);
  };
}

function requestInit(request: Request): RequestInit {
  return { method: request.method, headers: request.headers, signal: request.signal };
}
