import { z } from "zod";
import type { Call, HttpFields } from "../../core/call.ts";
import type { Definition, Normalized } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import type { FetchFn } from "../sign-in.ts";
import { HTTP_METHODS, matchOperation, type Operation } from "./openapi.ts";

/**
 * The definition for an HTTP account (D7a; spec: HTTP proxy): an API heel
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
 * - Redirects are never followed, and `Set-Cookie` never reaches the agent.
 * - heel doesn't know these responses' shapes, so it can't hide items in
 *   them (I-46).
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
  "content-length",
  "etag",
  "last-modified",
  "location",
  "cache-control",
  "retry-after",
  "link",
]);

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/** The body as rules see it: parsed from JSON or a form, absent for anything else. */
function parsedBody(args: HttpArgs): unknown {
  if (args.body === undefined) return undefined;
  const text = Buffer.from(args.body, "base64").toString("utf8");
  const type = (args.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/json" || type?.endsWith("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(text)) {
      const prior = out[key];
      out[key] =
        prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
    }
    return out;
  }
  return undefined;
}

export interface HttpDeps {
  vault: Vault;
  fetch: FetchFn;
}

export function httpDefinition(account: AccountRecord, deps: HttpDeps): Definition | null {
  const settings = httpSettings(account.settings);
  if (settings === null) return null;
  const operations = settings.operations as Operation[];

  return {
    async normalize(base: Call): Promise<Normalized> {
      // Only the proxy route reaches an HTTP account, so a rule keyed on `surface: http` sees every request.
      if (base.surface !== "http") return { ok: false, reason: "unsupported" };
      const parsed = HttpArgsSchema.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      const args = parsed.data;
      const op = matchOperation(operations, args.method, args.path);
      const body = parsedBody(args);
      const http: HttpFields = {
        method: args.method,
        path: args.path,
        ...(op === null ? {} : { pathTemplate: op.template }),
        query: args.query,
        ...(body === undefined ? {} : { body }),
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

    async execute(call, signal): Promise<HttpResponse> {
      const args = HttpArgsSchema.parse(call.args);
      const credential = (await deps.vault.accessToken(account.id)).reveal();
      const base = new URL(settings.baseUrl);
      // The path is appended below the base URL's own path; the host can't change.
      const url = new URL(base.toString());
      url.pathname = `${base.pathname.replace(/\/$/, "")}${args.path}`;
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
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_RESPONSE_BYTES)
        throw new Error("the upstream answered more than 25 MB");
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (RESPONSE_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
      });
      // A credential the upstream echoed never reaches the agent.
      const text = bytes.toString("latin1");
      const scrubbed =
        credential !== "" && text.includes(credential)
          ? Buffer.from(text.replaceAll(credential, "[redacted by heel]"), "latin1")
          : bytes;
      return { status: response.status, headers: out, body: scrubbed.toString("base64") };
    },
  };
}
