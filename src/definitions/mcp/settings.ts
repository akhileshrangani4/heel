import { z } from "zod";
import { newPlaceholder, parseCredentialAuth } from "../../runner/intercept.ts";
import { MAX_WALL_TIME_MS, type SandboxNetwork, type SandboxSpec } from "../../runner/plan.ts";
import {
  CredentialDeliveryChoice,
  CredentialDeliveryRefused,
  effectiveDelivery,
  type SandboxCredentialDelivery,
} from "../credential-delivery.ts";

/**
 * Where an MCP passthrough account's server lives, as `heel connect mcp`
 * stored it in the account's settings (never a secret; those are in the
 * vault). Two kinds:
 *
 * - `http`: a remote server at a URL. heel is its HTTP client.
 * - `stdio`: a local program heel starts under bubblewrap, talking MCP over
 *   its stdin and stdout. It gets its own work directory, reaches only the
 *   hosts its egress list names. With credential hosts, its credential
 *   variable holds an inert placeholder and heel's egress proxy adds the real
 *   credential to requests to those hosts, so the server never holds it.
 *   Without them, the credential would be in the variable itself: heel does
 *   that only when the operator chose it (`credentialDelivery: env`), and
 *   warns at startup; otherwise the account's calls are refused (see
 *   `../credential-delivery.ts`).
 */

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

const HttpSettings = z.object({
  transport: z.literal("http").default("http"),
  url: z.string().min(1),
  /**
   * The server wants OAuth sign-in: heel is its OAuth client, and the
   * account's tokens live in the vault. The account needs its owner to sign
   * in from the Connections page before any call works.
   */
  oauth: z.boolean().default(false),
  /**
   * Set for a server an agent asked for: heel contacts it, its
   * redirects and its sign-in endpoints only on public https hosts.
   */
  publicOnly: z.boolean().default(false),
  /** What the server registered heel as (dynamic client registration); public, never a secret. */
  oauthClient: z.looseObject({ client_id: z.string() }).optional(),
});

const StdioSettings = z.object({
  transport: z.literal("stdio"),
  /** Absolute path; never looked up on PATH, never run through a shell. */
  command: z.string().startsWith("/"),
  args: z.array(z.string()).max(64).default([]),
  /** `host[:port]` entries the server may reach; empty means no network at all. */
  egress: z.array(z.string()).max(32).default([]),
  /** The variable the account's credential (or, with credential hosts, its placeholder) is put in, e.g. NOTION_TOKEN. */
  credentialEnv: z.string().regex(ENV_NAME).nullable().default(null),
  /** `host[:port]` entries, each also in `egress`, that heel's proxy adds the credential for. */
  credentialHosts: z.array(z.string()).max(32).default([]),
  /** Where the credential goes in those requests: `bearer`, `basic` or `header:<Name>`. */
  credentialAuth: z
    .string()
    .refine((text) => parseCredentialAuth(text) !== null)
    .nullable()
    .default(null),
  /**
   * `env` when the operator chose to put the credential in the variable
   * itself; absent in accounts stored before that needed choosing.
   */
  credentialDelivery: CredentialDeliveryChoice.nullable().default(null),
  /** Host paths the server needs to read (its code, its dependencies), mounted read-only. */
  mounts: z.array(z.string().startsWith("/")).max(16).default([]),
});

const UpstreamSettingsSchema = z.union([StdioSettings, HttpSettings]);

export type UpstreamSettings = z.output<typeof UpstreamSettingsSchema>;
export type StdioUpstream = z.output<typeof StdioSettings>;
export type HttpUpstream = z.output<typeof HttpSettings>;

/** The account's upstream settings, or null when they don't describe one. */
export function upstreamSettings(settings: Record<string, unknown>): UpstreamSettings | null {
  const parsed = UpstreamSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

export function isEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

/**
 * How a local server's credential reaches it: `proxy` (heel adds it on the
 * wire; the server holds a placeholder), `env` (the server holds it, which
 * the operator chose), `refused` (it would hold it, unchosen: calls are
 * refused), or null when it has no credential variable.
 */
export function credentialDelivery(upstream: StdioUpstream): SandboxCredentialDelivery | null {
  return effectiveDelivery(upstream);
}

/**
 * How a stdio server runs in the sandbox. It is long-lived, so the wall time
 * is the runner's maximum and output has no cap (stdout is the MCP stream);
 * if the server exits, heel starts it again on the next call.
 *
 * `credential` reads the account's credential. With credential hosts it is
 * only handed to heel's egress proxy, which calls it per request; the server
 * gets a placeholder. Without them it is read once, into the variable, but
 * only when the operator chose that; otherwise this throws
 * `CredentialDeliveryRefused` and nothing starts.
 */
export async function stdioSandboxSpec(
  upstream: StdioUpstream,
  options: { workRoot: string; credential: (() => Promise<string>) | null; alias: string },
): Promise<SandboxSpec> {
  const base = {
    binary: upstream.command,
    args: upstream.args,
    workRoot: options.workRoot,
    cwd: options.workRoot,
    stdin: "pipe",
    readOnlyPaths: upstream.mounts,
    limits: { wallTimeMs: MAX_WALL_TIME_MS, maxOutputBytes: Number.MAX_SAFE_INTEGER },
  } as const;
  const network = (): SandboxNetwork =>
    upstream.egress.length === 0 ? { kind: "none" } : { kind: "egress", allow: upstream.egress };
  const env = upstream.credentialEnv;
  if (env === null || options.credential === null) return { ...base, network: network() };
  const delivery = credentialDelivery(upstream);
  if (delivery === "proxy") {
    const auth = parseCredentialAuth(upstream.credentialAuth ?? "bearer");
    if (auth === null) throw new Error(`bad credentialAuth ${upstream.credentialAuth}`);
    const placeholder = newPlaceholder();
    return {
      ...base,
      env: { [env]: placeholder },
      network: {
        kind: "egress",
        allow: upstream.egress,
        inject: {
          hosts: upstream.credentialHosts,
          auth,
          placeholder,
          credential: options.credential,
        },
      },
    };
  }
  if (delivery !== "env") throw new CredentialDeliveryRefused(options.alias, "mcp");
  return { ...base, secretEnv: { [env]: await options.credential() }, network: network() };
}
