import { readPlainMessage } from "../mail/raw-read.ts";

/**
 * The built-in providers' REST paths (D7b; spec: HTTP proxy, "Built-in
 * providers"): a request to a provider's own API, sent through
 * `/http/<account>/...`, becomes a call to heel's native tool for it, so
 * actions, recipients, items, state checks and hiding behave exactly as
 * over MCP. The answer is the tool's own result, as JSON. Paths heel has no
 * mapping for are refused. Pure.
 */

export interface RestCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface RestRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  /** The JSON body, parsed; undefined when there is none. */
  json?: unknown;
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? undefined : value);
const int = (value: string | undefined) =>
  value === undefined || !/^[0-9]{1,6}$/.test(value) ? undefined : Number(value);
const only = (query: RestRequest["query"], allowed: readonly string[]) =>
  Object.keys(query).every((key) => allowed.includes(key));

interface Route {
  method: string;
  /** Matched against the path below the provider's prefix. */
  path: RegExp;
  /** Query keys the route accepts; any other is refused. */
  query: readonly string[];
  build(match: RegExpExecArray, request: RestRequest): RestCall | null;
}

/** A table of routes under one prefix, as a REST map. */
function restMap(prefix: string, routes: readonly Route[]) {
  return (request: RestRequest): RestCall | null => {
    if (!request.path.startsWith(`${prefix}/`)) return null;
    const below = request.path.slice(prefix.length);
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.path.exec(below);
      if (match === null) continue;
      return only(request.query, route.query) ? route.build(match, request) : null;
    }
    return null;
  };
}

const ID = "([A-Za-z0-9_-]{1,256})";

/** Gmail's REST API (`users.messages`, `users.threads`, `users.labels`), for the account's own mailbox. */
export const gmailRest = restMap("/gmail/v1/users/me", [
  {
    method: "GET",
    path: /^\/messages$/,
    query: ["q", "maxResults", "pageToken"],
    build: (_m, { query }) => {
      const max = int(one(query["maxResults"]));
      const page = one(query["pageToken"]);
      return {
        tool: "search",
        args: {
          query: one(query["q"]) ?? "",
          ...(max === undefined ? {} : { max_results: max }),
          ...(page === undefined ? {} : { page_token: page }),
        },
      };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^/messages/${ID}$`),
    query: [],
    build: (m) => ({ tool: "get_message", args: { message_id: m[1] } }),
  },
  {
    method: "GET",
    path: new RegExp(`^/threads/${ID}$`),
    query: [],
    build: (m) => ({ tool: "get_thread", args: { thread_id: m[1] } }),
  },
  {
    method: "GET",
    path: /^\/labels$/,
    query: [],
    build: () => ({ tool: "list_labels", args: {} }),
  },
  {
    method: "POST",
    path: new RegExp(`^/messages/${ID}/trash$`),
    query: [],
    build: (m) => ({ tool: "trash", args: { message_ids: [m[1]] } }),
  },
  {
    method: "POST",
    path: /^\/messages\/send$/,
    query: [],
    build: (_m, { json }) => {
      if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
      // Only `raw`: a threadId, labels or anything else would change the send in ways heel didn't read.
      const raw = (json as Record<string, unknown>)["raw"];
      if (Object.keys(json).length !== 1 || typeof raw !== "string") return null;
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null;
      const message = readPlainMessage(Buffer.from(raw, "base64url"));
      return message === null ? null : { tool: "send", args: { ...message } };
    },
  },
]);

/** The REST map for a built-in provider, or undefined when it has none. */
export function restMapFor(
  provider: string,
): ((request: RestRequest) => RestCall | null) | undefined {
  return provider === "gmail" ? gmailRest : undefined;
}
