import { z } from "zod";

/**
 * The admin socket protocol: one JSON request line, one JSON response line,
 * then the server closes the connection. Only the `heel` Unix user can
 * connect (the socket is mode 0600), so this is a local control channel, not
 * an API surface; it carries credentials for `heel connect`, and the server
 * never logs request params.
 */

/** Longest request line accepted, in bytes. Large enough for a kubeconfig. */
export const ADMIN_MAX_REQUEST_BYTES = 256 * 1024;

/** A connection that sends no complete request in this time is dropped. */
export const ADMIN_IDLE_TIMEOUT_MS = 10_000;

const agentName = z.string().min(1).max(64);

/** Most audit rows one `audit.export` page returns. */
export const AUDIT_EXPORT_MAX_PAGE = 1_000;

const StaticCredentialSchema = z.strictObject({
  type: z.literal("static"),
  value: z.string().min(1),
});

export const AdminRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("ping") }),
  z.strictObject({
    method: z.literal("agent.add"),
    params: z.strictObject({
      name: agentName,
      /** The owning user's name; a single-user install defaults to its owner. */
      owner: z.string().min(1).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal("agent.rotate"),
    params: z.strictObject({ name: agentName }),
  }),
  z.strictObject({
    method: z.literal("agent.revoke"),
    params: z.strictObject({ name: agentName }),
  }),
  z.strictObject({ method: z.literal("agent.list") }),
  z.strictObject({
    method: z.literal("account.connect"),
    params: z.strictObject({
      provider: z.string().min(1),
      alias: z.string().min(1).max(64),
      owner: z.string().min(1).optional(),
      /** Optional now; OAuth connect flows arrive with the provider definitions. */
      credential: StaticCredentialSchema.optional(),
    }),
  }),
  z.strictObject({ method: z.literal("account.list") }),
  z.strictObject({
    /** `heel user enroll`: a one-time passkey enrollment link (bootstrap and recovery, Q-N2). */
    method: z.literal("user.enroll"),
    params: z.strictObject({ name: z.string().min(1).max(128) }),
  }),
  z.strictObject({
    /**
     * `heel pause`. Pausing only stops calls, so the admin socket may do it.
     * There is deliberately no `resume` method: resuming needs a fresh
     * passkey assertion on the approval page (Q-N5).
     */
    method: z.literal("pause"),
    params: z.discriminatedUnion("scope", [
      z.strictObject({ scope: z.literal("global") }),
      z.strictObject({
        scope: z.enum(["agent", "owner", "account"]),
        /** The agent's name, the owner's user name, or the account alias. */
        name: z.string().min(1).max(128),
      }),
    ]),
  }),
  z.strictObject({ method: z.literal("pause.list") }),
  z.strictObject({
    /** `heel approvals revoke <id>`: revoking a standing approval only tightens. */
    method: z.literal("standing.revoke"),
    params: z.strictObject({ id: z.string().min(1).max(64) }),
  }),
  z.strictObject({ method: z.literal("standing.list") }),
  z.strictObject({
    method: z.literal("audit.export"),
    params: z
      .strictObject({
        /** Inclusive lower bound on the row's `at`. */
        since: z.iso.datetime({ offset: true }).optional(),
        /** Exclusive upper bound on the row's `at`. */
        until: z.iso.datetime({ offset: true }).optional(),
        /** Resume after this row id; 0 (the default) starts at the beginning. */
        afterId: z.int().min(0).default(0),
        /**
         * The snapshot's last row id, from the first page's response. Omit it
         * on the first page and heel pins the newest row id.
         */
        throughId: z.int().min(0).optional(),
        limit: z.int().min(1).max(AUDIT_EXPORT_MAX_PAGE).default(AUDIT_EXPORT_MAX_PAGE),
      })
      .prefault({}),
  }),
]);

export type AdminRequest = z.output<typeof AdminRequestSchema>;
export type AdminMethod = AdminRequest["method"];

export const ADMIN_ERROR_CODES = [
  "bad_request",
  "invalid",
  "not_found",
  "conflict",
  "vault_unavailable",
  "internal",
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

export const AdminResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(ADMIN_ERROR_CODES), message: z.string() }),
  }),
]);

export type AdminResponse = z.output<typeof AdminResponseSchema>;

export function adminOk(result: unknown): AdminResponse {
  return { ok: true, result };
}

export function adminError(code: AdminErrorCode, message: string): AdminResponse {
  return { ok: false, error: { code, message } };
}

export type ParsedAdminRequest =
  | { ok: true; request: AdminRequest }
  | { ok: false; response: AdminResponse };

/**
 * Pure: parses one request line. The error names the fields that failed but
 * never echoes their values, which may be credentials.
 */
export function parseAdminRequest(line: string): ParsedAdminRequest {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, response: adminError("bad_request", "the request is not valid JSON") };
  }
  const parsed = AdminRequestSchema.safeParse(json);
  if (parsed.success) return { ok: true, request: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))];
  return {
    ok: false,
    response: adminError("bad_request", `invalid request fields: ${fields.join(", ")}`),
  };
}

/** Pure: one response line, newline-terminated. */
export function encodeAdminLine(message: AdminRequest | AdminResponse): string {
  return `${JSON.stringify(message)}\n`;
}
