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
      // A value given twice, or one that isn't a number, is refused, not dropped.
      if (Object.values(query).some(Array.isArray)) return null;
      const max = int(one(query["maxResults"]));
      if (query["maxResults"] !== undefined && max === undefined) return null;
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

/** A JSON object body with only the given keys, or null. */
function bodyWith(json: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  return Object.keys(json).every((k) => allowed.includes(k))
    ? (json as Record<string, unknown>)
    : null;
}

/** Query values as single strings, with page numbers checked; null when any isn't. */
function singleQuery(query: RestRequest["query"]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) return null;
    out[key] = value;
  }
  return out;
}

function paging(q: Record<string, string>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const key of ["page", "per_page"] as const) {
    if (q[key] === undefined) continue;
    const n = int(q[key]);
    if (n === undefined) return null;
    out[key] = n;
  }
  return out;
}

const REPO = "/repos/([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})";
const N = "([1-9][0-9]{0,9})";
const without = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

interface GitHubRoute {
  method: string;
  path: RegExp;
  query: readonly string[];
  /** Null refuses the request: the route matched, but not in a form heel's tool takes. */
  build(m: RegExpExecArray, q: Record<string, string>, json: unknown): RestCall | null;
}

const repo = (m: RegExpExecArray) => `${m[1]}/${m[2]}`;
const listing =
  (tool: string, withState: boolean) =>
  (m: RegExpExecArray, q: Record<string, string>): RestCall | null => {
    const page = paging(q);
    if (page === null) return null;
    return {
      tool,
      args: without({ repo: repo(m), ...page, ...(withState ? { state: q["state"] } : {}) }),
    };
  };

const GITHUB_ROUTES: readonly GitHubRoute[] = [
  {
    method: "GET",
    path: new RegExp(`^${REPO}/pulls$`),
    query: ["state", "page", "per_page"],
    build: listing("list_pull_requests", true),
  },
  {
    method: "POST",
    path: new RegExp(`^${REPO}/pulls$`),
    query: [],
    build: (m, _q, json) => {
      const b = bodyWith(json, ["title", "head", "base", "body", "draft"]);
      return b === null ? null : { tool: "create_pull_request", args: { repo: repo(m), ...b } };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^${REPO}/pulls/${N}$`),
    query: [],
    build: (m) => ({ tool: "get_pull_request", args: { repo: repo(m), number: Number(m[3]) } }),
  },
  {
    method: "PATCH",
    path: new RegExp(`^${REPO}/pulls/${N}$`),
    query: [],
    build: (m, _q, json) => {
      const b = bodyWith(json, ["title", "body", "state", "base"]);
      return b === null
        ? null
        : { tool: "update_pull_request", args: { repo: repo(m), number: Number(m[3]), ...b } };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^${REPO}/pulls/${N}/files$`),
    query: ["page", "per_page"],
    build: (m, q) => {
      const page = paging(q);
      return page === null
        ? null
        : {
            tool: "list_pull_request_files",
            args: { repo: repo(m), number: Number(m[3]), ...page },
          };
    },
  },
  {
    method: "PUT",
    path: new RegExp(`^${REPO}/pulls/${N}/merge$`),
    query: [],
    build: (m, _q, json) => {
      const b =
        json === undefined
          ? {}
          : bodyWith(json, ["merge_method", "commit_title", "commit_message", "sha"]);
      if (b === null) return null;
      return {
        tool: "merge_pull_request",
        args: without({
          repo: repo(m),
          number: Number(m[3]),
          method: b["merge_method"],
          commit_title: b["commit_title"],
          commit_message: b["commit_message"],
          expected_sha: b["sha"],
        }),
      };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^${REPO}/issues$`),
    query: ["state", "page", "per_page"],
    build: listing("list_issues", true),
  },
  {
    method: "POST",
    path: new RegExp(`^${REPO}/issues$`),
    query: [],
    build: (m, _q, json) => {
      const b = bodyWith(json, ["title", "body", "labels"]);
      return b === null ? null : { tool: "create_issue", args: { repo: repo(m), ...b } };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^${REPO}/issues/${N}$`),
    query: [],
    build: (m) => ({ tool: "get_issue", args: { repo: repo(m), number: Number(m[3]) } }),
  },
  {
    method: "PATCH",
    path: new RegExp(`^${REPO}/issues/${N}$`),
    query: [],
    build: (m, _q, json) => {
      const b = bodyWith(json, ["title", "body", "state", "labels"]);
      return b === null
        ? null
        : { tool: "update_issue", args: { repo: repo(m), number: Number(m[3]), ...b } };
    },
  },
  {
    method: "POST",
    path: new RegExp(`^${REPO}/issues/${N}/comments$`),
    query: [],
    build: (m, _q, json) => {
      const b = bodyWith(json, ["body"]);
      return b === null
        ? null
        : { tool: "add_comment", args: { repo: repo(m), number: Number(m[3]), ...b } };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^${REPO}/contents/(.+)$`),
    query: ["ref"],
    build: (m, q) => ({
      tool: "get_file_contents",
      args: without({ repo: repo(m), path: m[3], ref: q["ref"] }),
    }),
  },
  {
    method: "PUT",
    path: new RegExp(`^${REPO}/contents/(.+)$`),
    query: [],
    build: (m, _q, json) => {
      const b = bodyWith(json, ["message", "content", "branch", "sha"]);
      if (
        b === null ||
        typeof b["content"] !== "string" ||
        !/^[A-Za-z0-9+/\n]*={0,2}\n?$/.test(b["content"])
      ) {
        return null;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          Buffer.from(b["content"], "base64"),
        );
      } catch {
        return null;
      }
      return {
        tool: "put_file",
        args: without({
          repo: repo(m),
          path: m[3],
          content,
          message: b["message"],
          branch: b["branch"],
          sha: b["sha"],
        }),
      };
    },
  },
  {
    method: "GET",
    path: new RegExp(`^${REPO}/commits/([^/]+)/check-runs$`),
    query: ["page", "per_page"],
    build: (m, q) => {
      const page = paging(q);
      return page === null
        ? null
        : { tool: "list_check_runs", args: { repo: repo(m), ref: m[3], ...page } };
    },
  },
];

/**
 * GitHub's REST API. A mapped route becomes heel's own tool; a route that
 * matches but carries something the tool doesn't take is refused. Anything
 * else is `github.api`: sent as it is, and let through only by a rule that
 * names `github.api` (spec: GitHub, "Actions").
 */
export function githubRest(request: RestRequest): RestCall | null {
  const q = singleQuery(request.query);
  if (q === null) return null;
  for (const route of GITHUB_ROUTES) {
    if (route.method !== request.method) continue;
    const m = route.path.exec(request.path);
    if (m === null) continue;
    if (!Object.keys(q).every((k) => route.query.includes(k))) return null;
    return route.build(m, q, request.json);
  }
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return null;
  return {
    tool: "github_api",
    args: {
      method: request.method,
      path: request.path,
      query: q,
      ...(request.json === undefined ? {} : { body: request.json }),
    },
  };
}

/** The REST map for a built-in provider, or undefined when it has none. */
export function restMapFor(
  provider: string,
): ((request: RestRequest) => RestCall | null) | undefined {
  if (provider === "gmail") return gmailRest;
  if (provider === "github") return githubRest;
  return undefined;
}
