import { z } from "zod";
import type { Call, HttpFields } from "../../core/call.ts";
import type { Hiding } from "../../core/hide.ts";
import {
  type Definition,
  type Normalized,
  ResponseUnparseableError,
} from "../../gateway/pipeline/ports.ts";
import { credentialForms } from "../../runner/scrub.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { type ApiDeps, accountToken } from "../api-deps.ts";
import { filterResponse } from "./hide-map.ts";
import {
  HTTP_METHODS,
  matchesOnlyIgnoringCase,
  matchOperation,
  type Operation,
} from "./openapi.ts";

/**
 * The definition for an HTTP account: an API heel
 * reaches at one base URL, with the account's credential attached.
 *
 * - The call's `tool` is `<METHOD> <path-template>`, or the raw path when no
 *   template in the account's OpenAPI file matches. Rules see `method`,
 *   `path` (raw and as the template), `query` and `body`.
 * - `action` and `kind` come only from the file's `x-heel-action` and
 *   `x-heel-kind`; without them a call has neither, so `kind: read` never
 *   matches an operation the file doesn't mark (I-20).
 * - heel forwards only the body and its content type; every header the
 *   agent sent is dropped, and the account's credential is attached.
 * - A JSON or form body must parse as UTF-8, and what is sent is the body
 *   rules saw, serialized again, so a duplicate key or a byte-order mark
 *   can't mean one thing to a rule and another upstream. A path that matches
 *   a template only when case is ignored is refused.
 * - Each path segment is encoded again when the request is built, and the
 *   result must stay below the base URL's path.
 * - Redirects are never followed, and `Set-Cookie` never reaches the agent.
 *   The credential, in every form heel can predict (raw, URL- and
 *   form-encoded, JSON-escaped, base64, the header heel sent, a basic
 *   password on its own), is scrubbed from the body and every header passed
 *   back. Responses are read with a running 25 MB cap.
 * - Hiding: an operation with an `x-heel-hide` mapping has the hidden
 *   items removed from its JSON response, with their count in a
 *   `Heel-Hidden` header (one count, no per-row markers). A
 *   response that is one hidden item answers 403 `not_available`. A mapped
 *   response heel can't read is withheld, an error answer reaches the agent
 *   as its status only, and what is returned is always what heel checked,
 *   serialized again. Mappings are only allowed on `x-heel-kind: read`
 *   operations, since a write aimed at a hidden item can't be refused before
 *   it runs (I-42). An operation without a mapping
 *   has no shape heel knows, so nothing in it is hidden (I-46).
 * - Only the `/http` surface reaches it; an MCP call naming the account is
 *   refused.
 */

/** What an HTTP account stores in `settings`. */
export const HttpSettingsSchema = z.object({
  transport: z.literal("http"),
  baseUrl: z.string().url(),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("bearer") }),
    z.object({ type: z.literal("basic") }),
    z.object({ type: z.literal("header"), name: z.string().min(1) }),
    z.object({ type: z.literal("query"), name: z.string().min(1) }),
  ]),
  operations: z
    .array(
      z.object({
        method: z.enum(HTTP_METHODS),
        template: z.string(),
        operationId: z.string().optional(),
        action: z.string().optional(),
        kind: z.enum(["read", "write"]).optional(),
        hide: z
          .object({
            items: z.string(),
            from: z.string().optional(),
            to: z.string().optional(),
            subject: z.string().optional(),
            labels: z.string().optional(),
            body: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});
export type HttpSettings = z.output<typeof HttpSettingsSchema>;

export function httpSettings(settings: Record<string, unknown>): HttpSettings | null {
  const parsed = HttpSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

/** A request as the proxy route hands it to the pipeline, before any rule sees it. */
export const HttpArgsSchema = z.strictObject({
  method: z.enum(HTTP_METHODS),
  /** The path below the account, starting with `/`, already checked by the route. */
  path: z.string().startsWith("/"),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  contentType: z.string().optional(),
  /** The request body, base64; absent for none. */
  body: z.string().optional(),
});
export type HttpArgs = z.output<typeof HttpArgsSchema>;

/** What the upstream answered, as the proxy route returns it. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** base64 */
  body: string;
}

/** Response headers passed back to the agent; everything else (cookies, auth challenges) is dropped. */
const RESPONSE_HEADERS = new Set([
  "content-type",
  "etag",
  "last-modified",
  "location",
  "cache-control",
  "retry-after",
  "link",
]);

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * The body as rules see it, and the bytes that will be sent. JSON and form
 * bodies are parsed and serialized again, so the upstream gets exactly what
 * rules checked; one that doesn't parse, or isn't UTF-8, is refused (null).
 * Any other content type passes through unread.
 */
function canonicalBody(args: HttpArgs): { parsed?: unknown; body?: string } | null {
  if (args.body === undefined) return {};
  const [mediaType, ...params] = (args.contentType ?? "").split(";");
  const type = mediaType?.trim().toLowerCase() ?? "";
  const json = type === "application/json" || type.endsWith("+json");
  const form = type === "application/x-www-form-urlencoded";
  if (!json && !form) return { body: args.body };
  const charset = params
    .map((p) => p.trim().toLowerCase())
    .find((p) => p.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/"/g, "");
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") return null;
  const bytes = Buffer.from(args.body, "base64");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return { parsed, body: Buffer.from(JSON.stringify(parsed)).toString("base64") };
  }
  const pairs = [...new URLSearchParams(text)];
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of pairs) {
    const prior = out[key];
    out[key] =
      prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return {
    parsed: out,
    body: Buffer.from(new URLSearchParams(pairs).toString()).toString("base64"),
  };
}

const REDACTED = Buffer.from("[redacted by heel]");

/** Replaces every occurrence of any form, compared as UTF-8 bytes. */
function scrub(bytes: Buffer, forms: readonly string[]): Buffer {
  let out = bytes;
  for (const form of forms) {
    const needle = Buffer.from(form, "utf8");
    if (out.indexOf(needle) === -1) continue;
    const parts: Buffer[] = [];
    let from = 0;
    for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, from)) {
      parts.push(out.subarray(from, at), REDACTED);
      from = at + needle.length;
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
  }
  return out;
}

/** Reads a response body, aborting as soon as it passes the cap. */
async function readResponse(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("the upstream answered more than 25 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function httpDefinition(account: AccountRecord, deps: ApiDeps): Definition | null {
  const settings = httpSettings(account.settings);
  if (settings === null) return null;
  const operations = settings.operations as Operation[];

  return {
    async normalize(base: Call): Promise<Normalized> {
      // Only the proxy route reaches an HTTP account, so a rule keyed on `surface: http` sees every request.
      if (base.surface !== "http") return { ok: false, reason: "unsupported" };
      const parsed = HttpArgsSchema.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      const agentArgs = parsed.data;
      if (matchesOnlyIgnoringCase(operations, agentArgs.method, agentArgs.path)) {
        return { ok: false, reason: "unsupported" };
      }
      const canonical = canonicalBody(agentArgs);
      if (canonical === null) return { ok: false, reason: "unsupported" };
      // The query-auth parameter is heel's: an agent's copy, in any case, is dropped.
      const authParam = settings.auth.type === "query" ? settings.auth.name.toLowerCase() : null;
      const query = Object.fromEntries(
        Object.entries(agentArgs.query).filter(([key]) => key.toLowerCase() !== authParam),
      );
      const { body: _sent, ...rest } = agentArgs;
      const args: HttpArgs = {
        ...rest,
        query,
        ...(canonical.body === undefined ? {} : { body: canonical.body }),
      };
      const op = matchOperation(operations, args.method, args.path);
      const body = canonical.parsed;
      const http: HttpFields = {
        method: args.method,
        path: args.path,
        ...(op === null ? {} : { pathTemplate: op.template }),
        query: args.query,
        ...(body === undefined ? {} : { body }),
        ...(body === undefined && canonical.body !== undefined && { bodyUnreadable: true }),
      };
      return {
        ok: true,
        call: {
          ...base,
          tool: `${args.method} ${op?.template ?? args.path}`,
          args,
          http,
          items: 1,
          ...(op?.action === undefined ? {} : { action: op.action }),
          ...(op?.kind === undefined ? {} : { kind: op.kind }),
        },
      };
    },

    async hide(call, result, hiding: Hiding): Promise<HttpResponse> {
      const response = result as HttpResponse;
      if (hiding.entries.length === 0) return response;
      const args = HttpArgsSchema.parse(call.args);
      const mapping = matchOperation(operations, args.method, args.path)?.hide;
      if (mapping === undefined) return response;
      const jsonBody = (status: number, value: unknown, extra: Record<string, string> = {}) => ({
        status,
        headers: { "content-type": "application/json", ...extra },
        body: Buffer.from(JSON.stringify(value)).toString("base64"),
      });
      // An error answer on a mapped operation may echo an item; only its status reaches the agent.
      if (response.status < 200 || response.status >= 300) {
        return jsonBody(response.status, {
          status: "upstream_error",
          upstreamStatus: response.status,
        });
      }
      const type = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json" && type?.endsWith("+json") !== true) {
        throw new ResponseUnparseableError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(response.body, "base64").toString("utf8"));
      } catch {
        throw new ResponseUnparseableError();
      }
      const filtered = filterResponse(parsed, mapping, (c) => hiding.isHidden(c), hiding.needsBody);
      if (filtered.kind === "unreadable") throw new ResponseUnparseableError();
      if (filtered.kind === "hidden_item") {
        return jsonBody(
          403,
          { status: "denied", reason: "not_available", rule: null },
          { "heel-decision": "deny" },
        );
      }
      // Always what heel checked, serialized again: never the upstream's own bytes, which a
      // duplicate key could make mean something else.
      const { "content-length": _dropped, ...headers } = response.headers;
      return {
        status: response.status,
        headers: {
          ...headers,
          ...(filtered.hidden === 0 ? {} : { "heel-hidden": String(filtered.hidden) }),
        },
        body: Buffer.from(JSON.stringify(filtered.value)).toString("base64"),
      };
    },

    async execute(call, signal): Promise<HttpResponse> {
      const args = HttpArgsSchema.parse(call.args);
      const credential = await accountToken(deps, account);
      const base = new URL(settings.baseUrl);
      // The path is appended below the base URL's own path, each segment encoded again.
      const basePath = base.pathname.replace(/\/$/, "");
      const url = new URL(base.toString());
      url.pathname =
        args.path === "/"
          ? `${basePath}/`
          : `${basePath}/${args.path.slice(1).split("/").map(encodeURIComponent).join("/")}`;
      if (!url.pathname.startsWith(`${basePath}/`)) {
        throw new Error("the request left the account's base path");
      }
      for (const [key, value] of Object.entries(args.query)) {
        for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
      }
      const headers: Record<string, string> = { accept: "*/*" };
      if (args.contentType !== undefined) headers["content-type"] = args.contentType;
      switch (settings.auth.type) {
        case "bearer":
          headers["authorization"] = `Bearer ${credential}`;
          break;
        case "basic":
          headers["authorization"] = `Basic ${Buffer.from(credential).toString("base64")}`;
          break;
        case "header":
          headers[settings.auth.name.toLowerCase()] = credential;
          break;
        case "query":
          url.searchParams.set(settings.auth.name, credential);
          break;
      }
      if (url.origin !== base.origin) throw new Error("the request left the account's base URL");
      const response = await deps.fetch(url, {
        method: args.method,
        headers,
        ...(args.body === undefined ? {} : { body: Buffer.from(args.body, "base64") }),
        redirect: "manual",
        signal,
      });
      const bytes = await readResponse(response);
      // A credential the upstream echoed, in any form heel can predict, never reaches the agent.
      const forms = [
        ...credentialForms(credential, settings.auth),
        ...Object.entries(headers)
          .filter(([name]) => name !== "accept" && name !== "content-type")
          .map(([, value]) => value),
      ].sort((a, b) => b.length - a.length);
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (RESPONSE_HEADERS.has(key.toLowerCase())) {
          out[key.toLowerCase()] = scrub(Buffer.from(value, "utf8"), forms).toString("utf8");
        }
      });
      return {
        status: response.status,
        headers: out,
        body: scrub(bytes, forms).toString("base64"),
      };
    },
  };
}
