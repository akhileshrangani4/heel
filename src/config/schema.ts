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

/**
 * The on-disk shape of `heel.yaml`. Keys are snake_case as written by
 * operators; unknown keys are errors so a typo never silently falls back to a
 * default. Later deliverables add their own sections (`oidc`, `drafting`, …).
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
});

export type HeelConfigFile = z.output<typeof HeelConfigFileSchema>;

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
  };
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Pure: why the human plane must not start on this public URL, or null when
 * it may. Passkeys are bound to the RP ID, so a plain-http origin anywhere but
 * localhost would let a network attacker phish approvals.
 */
export function humanPlaneUrlProblem(publicUrl: URL): string | null {
  if (publicUrl.protocol === "https:") return null;
  if (LOCAL_HOSTNAMES.has(publicUrl.hostname)) return null;
  return `public_url must be https:// (got ${publicUrl.origin}); only localhost may use http://`;
}
