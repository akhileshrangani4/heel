import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

/** A TCP listen address, `host:port` or `[ipv6]:port`. */
export interface ListenAddress {
  host: string;
  port: number;
}

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LISTEN_PATTERN = /^(?:\[(?<v6>[0-9A-Fa-f:.]+)\]|(?<host>[^\s:[\]]+)):(?<port>\d{1,5})$/;

/** Pure: parses `host:port`; returns null when the text is not one. */
export function parseListenAddress(text: string): ListenAddress | null {
  const groups = LISTEN_PATTERN.exec(text)?.groups;
  if (!groups) return null;
  const port = Number(groups["port"]);
  const host = groups["v6"] ?? groups["host"];
  if (host === undefined || !Number.isInteger(port) || port > 65_535) return null;
  return { host, port };
}

const listenAddress = z.string().transform((text, ctx): ListenAddress => {
  const parsed = parseListenAddress(text);
  if (parsed) return parsed;
  ctx.addIssue({ code: "custom", message: `expected host:port, got "${text}"` });
  return z.NEVER;
});

const httpUrl = z.url({ protocol: /^https?$/, error: "expected an http:// or https:// URL" });

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Pure: true for http(s) URLs on this host, the one place plain http is tolerated. */
export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * An endpoint heel sends secrets or audit rows to: https://, or http:// on
 * loopback only (for development and in-process tests).
 */
const secureUrl = httpUrl.refine(
  (text) => {
    const url = new URL(text);
    return url.protocol === "https:" || isLoopbackUrl(url);
  },
  { error: "expected an https:// URL (http:// is allowed only on localhost)" },
);

/** An HTTP header field name (RFC 9110 token). */
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "expected a header name");

const groupName = z.string().min(1);

/**
 * `oidc:` turns on team sign-in (spec: Teams, "Sign-in"). Without it the
 * install is single-user and passkey-only. `roles` maps IdP groups to heel
 * roles; at least one admin group is required, or nobody could edit org rules.
 */
const OidcSectionSchema = z.strictObject({
  issuer: secureUrl,
  client_id: z.string().min(1),
  /**
   * Confidential clients only. HEEL_OIDC_CLIENT_SECRET in the environment
   * takes precedence. Without either, heel is a public client and relies on
   * PKCE alone. Relative paths resolve against $HEEL_HOME.
   */
  client_secret_file: z.string().min(1).optional(),
  scopes: z
    .array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "expected a scope token"))
    .default(["openid", "profile", "email"])
    .refine((scopes) => scopes.includes("openid"), { error: 'scopes must include "openid"' }),
  /** The ID token or userinfo claim holding the user's groups; dotted paths reach nested claims. */
  groups_claim: z.string().min(1).default("groups"),
  roles: z.strictObject({
    admin: z.array(groupName).min(1),
    member: z.array(groupName).default([]),
  }),
});

/**
 * The optional SIEM sink (spec: Teams, "Audit"): batched HTTPS POSTs of JSON
 * Lines, retried with backoff, with a backlog alert when it falls behind.
 */
const SiemSectionSchema = z.strictObject({
  url: secureUrl,
  auth: z
    .strictObject({
      header: headerName.default("Authorization"),
      /** Prefix before the token, e.g. "Bearer" or "Splunk"; "" sends the bare token. */
      scheme: z
        .string()
        .regex(/^[A-Za-z0-9._~+/-]*$/, "expected an auth scheme")
        .default("Bearer"),
      /** HEEL_SIEM_TOKEN in the environment takes precedence. Relative to $HEEL_HOME. */
      token_file: z.string().min(1),
    })
    .optional(),
  batch_size: z.int().min(1).max(5_000).default(500),
  /** How often an idle sink looks for new rows. */
  interval_seconds: z.number().positive().max(3_600).default(5),
  timeout_seconds: z.number().positive().max(300).default(10),
  /** Alert admins when undelivered rows exceed `rows`, or the oldest is older than `minutes`. */
  backlog_alert: z
    .strictObject({
      rows: z.int().min(1).default(10_000),
      minutes: z.number().positive().default(15),
    })
    .prefault({}),
});

/**
 * The on-disk shape of `heel.yaml`. Keys are snake_case as written by
 * operators; unknown keys are errors so a typo never silently falls back to a
 * default. Later deliverables add their own sections (`drafting`, …).
 */
export const HeelConfigFileSchema = z.strictObject({
  /** SQLite file. Relative paths resolve against $HEEL_HOME. */
  database: z.string().min(1).default("heel.db"),
  /**
   * The human plane's public origin; its host becomes the WebAuthn RP ID.
   * Only https:// may serve the human plane, except localhost (spec:
   * Architecture, "Listeners").
   */
  public_url: httpUrl.default("http://localhost:7301"),
  listen: z
    .strictObject({
      agent: listenAddress.default({ host: "127.0.0.1", port: 7300 }),
      human: listenAddress.default({ host: "127.0.0.1", port: 7301 }),
    })
    .prefault({}),
  /** Unix socket for `heel connect`, `heel agent`, `heel pause`, … */
  admin_socket: z.string().min(1).default("/run/heel/admin.sock"),
  vault: z
    .strictObject({
      /**
       * File holding the base64 master key. HEEL_MASTER_KEY in the
       * environment takes precedence. Relative paths resolve against
       * $HEEL_HOME.
       */
      key_file: z.string().min(1).default("master.key"),
    })
    .prefault({}),
  log: z
    .strictObject({
      level: z.enum(LOG_LEVELS).default("info"),
    })
    .prefault({}),
  oidc: OidcSectionSchema.optional(),
  audit: z
    .strictObject({
      siem: SiemSectionSchema.optional(),
    })
    .prefault({}),
});

export type HeelConfigFile = z.output<typeof HeelConfigFileSchema>;

/** Where the IdP sends people back after sign-in; D13b mounts the route here. */
export const OIDC_CALLBACK_PATH = "/auth/oidc/callback";

/** IdP groups that grant each heel role. */
export interface RoleGroups {
  admin: readonly string[];
  member: readonly string[];
}

export interface OidcConfig {
  issuer: URL;
  clientId: string;
  /** Null when only the environment, or nothing (a public client), supplies the secret. */
  clientSecretFile: string | null;
  /** `public_url` + OIDC_CALLBACK_PATH. */
  redirectUri: URL;
  scopes: readonly string[];
  groupsClaim: string;
  roles: RoleGroups;
}

export interface SiemConfig {
  url: URL;
  auth: { header: string; scheme: string; tokenFile: string } | null;
  batchSize: number;
  intervalMs: number;
  timeoutMs: number;
  backlogAlert: { rows: number; ageMs: number };
}

/** The resolved configuration every other module receives. */
export interface HeelConfig {
  home: string;
  /** The file this config came from, or null when built from defaults. */
  configFile: string | null;
  databasePath: string;
  publicUrl: URL;
  listen: { agent: ListenAddress; human: ListenAddress };
  adminSocketPath: string;
  vault: { keyFile: string };
  log: { level: LogLevel };
  /** Null on a single-user, passkey-only install. */
  oidc: OidcConfig | null;
  audit: { siem: SiemConfig | null };
}

/** Pure: resolves relative paths against `home` and renames to camelCase. */
export function resolveConfig(
  file: HeelConfigFile,
  home: string,
  configFile: string | null,
): HeelConfig {
  const fromHome = (path: string): string => (isAbsolute(path) ? path : resolve(home, path));
  return {
    home,
    configFile,
    databasePath: fromHome(file.database),
    publicUrl: new URL(file.public_url),
    listen: { agent: file.listen.agent, human: file.listen.human },
    adminSocketPath: fromHome(file.admin_socket),
    vault: { keyFile: fromHome(file.vault.key_file) },
    log: { level: file.log.level },
    oidc: file.oidc ? resolveOidc(file.oidc, new URL(file.public_url), fromHome) : null,
    audit: { siem: file.audit.siem ? resolveSiem(file.audit.siem, fromHome) : null },
  };
}

function resolveOidc(
  oidc: NonNullable<HeelConfigFile["oidc"]>,
  publicUrl: URL,
  fromHome: (path: string) => string,
): OidcConfig {
  return {
    issuer: new URL(oidc.issuer),
    clientId: oidc.client_id,
    clientSecretFile: oidc.client_secret_file ? fromHome(oidc.client_secret_file) : null,
    redirectUri: new URL(OIDC_CALLBACK_PATH, publicUrl),
    scopes: oidc.scopes,
    groupsClaim: oidc.groups_claim,
    roles: { admin: oidc.roles.admin, member: oidc.roles.member },
  };
}

function resolveSiem(
  siem: NonNullable<HeelConfigFile["audit"]["siem"]>,
  fromHome: (path: string) => string,
): SiemConfig {
  return {
    url: new URL(siem.url),
    auth: siem.auth
      ? {
          header: siem.auth.header,
          scheme: siem.auth.scheme,
          tokenFile: fromHome(siem.auth.token_file),
        }
      : null,
    batchSize: siem.batch_size,
    intervalMs: Math.round(siem.interval_seconds * 1_000),
    timeoutMs: Math.round(siem.timeout_seconds * 1_000),
    backlogAlert: {
      rows: siem.backlog_alert.rows,
      ageMs: Math.round(siem.backlog_alert.minutes * 60_000),
    },
  };
}

/**
 * Pure: why the human plane must not start on this public URL, or null when
 * it may. Passkeys are bound to the RP ID, so a plain-http origin anywhere but
 * localhost would let a network attacker phish approvals.
 */
export function humanPlaneUrlProblem(publicUrl: URL): string | null {
  if (publicUrl.protocol === "https:") return null;
  if (isLoopbackUrl(publicUrl)) return null;
  return `public_url must be https:// (got ${publicUrl.origin}); only localhost may use http://`;
}
