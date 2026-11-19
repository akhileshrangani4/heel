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
/**
 * `drafting:` turns on `heel rules draft` (D13b): any OpenAI-compatible
 * endpoint. Without it, drafting is off and nothing else changes (I-17).
 */
const DraftingSectionSchema = z.strictObject({
  /** The API base, e.g. https://api.openai.com/v1; https, or http on localhost. */
  base_url: secureUrl,
  model: z.string().min(1).max(200),
  /** HEEL_DRAFTING_API_KEY in the environment takes precedence. Relative paths resolve against $HEEL_HOME. */
  api_key_file: z.string().min(1).optional(),
});

/**
 * `adapters.approval`: approval adapters, which add advisory hints to the
 * approval page for a pending request (core/hints.ts). They can't change a
 * verdict. Off by default; `jev` sends pending calls to TypeSafe.
 */
const ApprovalAdapterSchema = z.strictObject({
  jev: z.strictObject({
    model: z.string().min(1).max(100).default("jev-latest"),
    /** HEEL_TYPESAFE_API_KEY in the environment takes precedence. Relative to $HEEL_HOME. */
    api_key_file: z.string().min(1).optional(),
  }),
});

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
/**
 * Where approval notifications go (spec: Notifications). Web push is always
 * available once someone turns it on from the approval page; email and Slack
 * are on when their section is present. Secrets live in files, with an
 * environment variable taking precedence, like the SIEM token.
 */
const NotifySectionSchema = z.strictObject({
  web_push: z
    .strictObject({
      /** The VAPID key pair, created on first boot. Relative to $HEEL_HOME. */
      key_file: z.string().min(1).default("vapid.json"),
      /** A `mailto:` or `https:` contact push services can reach; defaults to the public URL. */
      subject: z
        .string()
        .regex(/^(mailto:|https:\/\/)/, "expected a mailto: or https:// contact")
        .optional(),
    })
    .prefault({}),
  email: z
    .strictObject({
      host: z.string().min(1),
      port: z.int().min(1).max(65_535).default(587),
      /** true for implicit TLS (usually port 465); otherwise STARTTLS is required. */
      tls: z.boolean().default(false),
      username: z.string().min(1).optional(),
      /** HEEL_SMTP_PASSWORD in the environment takes precedence. Relative to $HEEL_HOME. */
      password_file: z.string().min(1).optional(),
      /** The From header, e.g. "heel <heel@example.com>". */
      from: z.string().min(3),
    })
    .optional(),
  slack: z
    .strictObject({
      /** A bot token with chat:write and users:read.email. HEEL_SLACK_TOKEN takes precedence. */
      token_file: z.string().min(1),
    })
    .optional(),
});

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
   * Architecture, "Listeners"). Unset, it is http://localhost on
   * `listen.human`'s port, so moving the approval page's port moves its links.
   */
  public_url: httpUrl.optional(),
  /**
   * Where cloud agents (Claude, ChatGPT, Grok connectors) reach the agent
   * plane, e.g. through a reverse proxy. Setting it turns on OAuth for
   * connectors (A2): heel's human plane becomes their authorization server.
   * https, or http on localhost.
   */
  agent_public_url: secureUrl.optional(),
  listen: z
    .strictObject({
      agent: listenAddress.default({ host: "127.0.0.1", port: 7300 }),
      human: listenAddress.default({ host: "127.0.0.1", port: 7301 }),
    })
    .prefault({}),
  /**
   * Unix socket for `heel connect`, `heel agent`, `heel pause`, … Defaults
   * to /run/heel/admin.sock for a server install (HEEL_HOME at
   * /var/lib/heel), and to $HEEL_HOME/admin.sock for any other home, so a
   * personal install needs no root-owned directory.
   */
  admin_socket: z.string().min(1).optional(),
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
  drafting: DraftingSectionSchema.optional(),
  adapters: z
    .strictObject({
      // One for now: adapters are stored by name, and the only kind is jev.
      approval: z.array(ApprovalAdapterSchema).max(1).default([]),
    })
    .prefault({}),
  audit: z
    .strictObject({
      siem: SiemSectionSchema.optional(),
    })
    .prefault({}),
  notify: NotifySectionSchema.prefault({}),
  /**
   * How many sandboxes (code-mode scripts and `heel run` commands) may run
   * at once, per agent and in all. A request over either is refused with
   * `busy`. `total` defaults to one per GiB of the host's memory, less one,
   * between 2 and 16.
   */
  sandboxes: z
    .strictObject({
      per_agent: z.int().min(1).max(1_000).default(4),
      total: z.int().min(1).max(10_000).optional(),
    })
    .prefault({}),
  providers: z
    .strictObject({
      /**
       * The operator's Google OAuth client (a "Web application" client in
       * Google Cloud), for signing in Gmail accounts. Its redirect URI is
       * `public_url` + /oauth/google/callback. Without it, Gmail accounts
       * can be connected but not signed in.
       */
      google: z
        .strictObject({
          client_id: z.string().min(1),
          /** HEEL_GOOGLE_CLIENT_SECRET in the environment takes precedence. Relative to $HEEL_HOME. */
          client_secret_file: z.string().min(1).default("google-client-secret"),
        })
        .optional(),
      /**
       * The operator's Microsoft app registration (a web platform with
       * delegated Mail permissions), for signing in Outlook accounts. Its
       * redirect URI is `public_url` + /oauth/microsoft/callback.
       */
      microsoft: z
        .strictObject({
          client_id: z.string().min(1),
          /** HEEL_MICROSOFT_CLIENT_SECRET in the environment takes precedence. Relative to $HEEL_HOME. */
          client_secret_file: z.string().min(1).default("microsoft-client-secret"),
          /** `common`, `organizations`, `consumers`, or a tenant id or domain. */
          tenant: z
            .string()
            .regex(
              /^[A-Za-z0-9.-]{1,100}$/,
              "expected common, organizations, consumers or a tenant",
            )
            .default("common"),
        })
        .optional(),
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

export interface NotifyConfig {
  webPush: { keyFile: string; subject: string };
  email: {
    host: string;
    port: number;
    tls: boolean;
    username: string | null;
    passwordFile: string | null;
    from: string;
  } | null;
  slack: { tokenFile: string } | null;
}

export interface SiemConfig {
  url: URL;
  auth: { header: string; scheme: string; tokenFile: string } | null;
  batchSize: number;
  intervalMs: number;
  timeoutMs: number;
  backlogAlert: { rows: number; ageMs: number };
}

export interface GoogleProviderConfig {
  clientId: string;
  clientSecretFile: string;
  /** `public_url` + GOOGLE_CALLBACK_PATH. */
  redirectUri: URL;
}

/** Where Google sends people back after signing in a Gmail account. */
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

/** Where Microsoft sends people back after signing in an Outlook account. */
export const MICROSOFT_CALLBACK_PATH = "/oauth/microsoft/callback";

export interface MicrosoftProviderConfig extends GoogleProviderConfig {
  tenant: string;
}

/** The resolved configuration every other module receives. */
export interface HeelConfig {
  home: string;
  /** The file this config came from, or null when built from defaults. */
  configFile: string | null;
  databasePath: string;
  publicUrl: URL;
  /** Whether heel.yaml names `public_url`; unset, it follows `listen.human`. */
  publicUrlSet: boolean;
  /** Null when OAuth for connectors is off; agents then use static tokens only. */
  agentPublicUrl: URL | null;
  listen: { agent: ListenAddress; human: ListenAddress };
  adminSocketPath: string;
  vault: { keyFile: string };
  log: { level: LogLevel };
  /** Null on a single-user, passkey-only install. */
  oidc: OidcConfig | null;
  /** Null when drafting is off (I-17). */
  drafting: { baseUrl: URL; model: string; apiKeyFile: string | null } | null;
  /** Approval adapters, in order; empty when none are configured. */
  adapters: { approval: { kind: "jev"; model: string; apiKeyFile: string | null }[] };
  audit: { siem: SiemConfig | null };
  notify: NotifyConfig;
  /** Sandboxes at once; a null `total` means the host-memory default (gateway/sandbox-slots.ts). */
  sandboxes: { perAgent: number; total: number | null };
  /** Null when the operator configured no Google client. */
  providers: { google: GoogleProviderConfig | null; microsoft: MicrosoftProviderConfig | null };
}

/** Pure: resolves relative paths against `home` and renames to camelCase. */
/** A server install's home and admin socket (spec: Architecture, "Listeners"). */
export const SERVER_HOME = "/var/lib/heel";
const SERVER_ADMIN_SOCKET = "/run/heel/admin.sock";

export function resolveConfig(
  file: HeelConfigFile,
  home: string,
  configFile: string | null,
): HeelConfig {
  const fromHome = (path: string): string => (isAbsolute(path) ? path : resolve(home, path));
  // Port 0 (any free port, in tests) has no address to link to; keep the documented default.
  const humanPort = file.listen.human.port === 0 ? 7301 : file.listen.human.port;
  const publicUrl = file.public_url ?? `http://localhost:${humanPort}`;
  return {
    home,
    configFile,
    databasePath: fromHome(file.database),
    publicUrl: new URL(publicUrl),
    publicUrlSet: file.public_url !== undefined,
    agentPublicUrl: file.agent_public_url === undefined ? null : new URL(file.agent_public_url),
    listen: { agent: file.listen.agent, human: file.listen.human },
    adminSocketPath:
      file.admin_socket !== undefined
        ? fromHome(file.admin_socket)
        : home === SERVER_HOME
          ? SERVER_ADMIN_SOCKET
          : fromHome("admin.sock"),
    vault: { keyFile: fromHome(file.vault.key_file) },
    log: { level: file.log.level },
    oidc: file.oidc ? resolveOidc(file.oidc, new URL(publicUrl), fromHome) : null,
    drafting: file.drafting
      ? {
          baseUrl: new URL(file.drafting.base_url),
          model: file.drafting.model,
          apiKeyFile:
            file.drafting.api_key_file === undefined ? null : fromHome(file.drafting.api_key_file),
        }
      : null,
    adapters: {
      approval: file.adapters.approval.map(({ jev }) => ({
        kind: "jev" as const,
        model: jev.model,
        apiKeyFile: jev.api_key_file === undefined ? null : fromHome(jev.api_key_file),
      })),
    },
    audit: { siem: file.audit.siem ? resolveSiem(file.audit.siem, fromHome) : null },
    notify: resolveNotify(file.notify, new URL(publicUrl), fromHome),
    sandboxes: { perAgent: file.sandboxes.per_agent, total: file.sandboxes.total ?? null },
    providers: {
      google: file.providers.google
        ? {
            clientId: file.providers.google.client_id,
            clientSecretFile: fromHome(file.providers.google.client_secret_file),
            redirectUri: new URL(GOOGLE_CALLBACK_PATH, publicUrl),
          }
        : null,
      microsoft: file.providers.microsoft
        ? {
            clientId: file.providers.microsoft.client_id,
            clientSecretFile: fromHome(file.providers.microsoft.client_secret_file),
            redirectUri: new URL(MICROSOFT_CALLBACK_PATH, publicUrl),
            tenant: file.providers.microsoft.tenant,
          }
        : null,
    },
  };
}

function resolveNotify(
  notify: HeelConfigFile["notify"],
  publicUrl: URL,
  fromHome: (path: string) => string,
): NotifyConfig {
  const { email, slack } = notify;
  return {
    webPush: {
      keyFile: fromHome(notify.web_push.key_file),
      subject: notify.web_push.subject ?? publicUrl.origin,
    },
    email: email
      ? {
          host: email.host,
          port: email.port,
          tls: email.tls,
          username: email.username ?? null,
          passwordFile: email.password_file ? fromHome(email.password_file) : null,
          from: email.from,
        }
      : null,
    slack: slack ? { tokenFile: fromHome(slack.token_file) } : null,
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
