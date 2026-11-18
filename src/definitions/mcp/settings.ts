import { z } from "zod";
import { MAX_WALL_TIME_MS, type SandboxSpec } from "../../runner/plan.ts";

/**
 * Where an MCP passthrough account's server lives, as `heel connect mcp`
 * stored it in the account's settings (never a secret; those are in the
 * vault). Two kinds (spec: Upstream MCP servers):
 *
 * - `http`: a remote server at a URL. heel is its HTTP client.
 * - `stdio`: a local program heel starts under bubblewrap, talking MCP over
 *   its stdin and stdout. It gets its own work directory, reaches only the
 *   hosts its egress list names, and gets the account's credential in one
 *   environment variable and nowhere else (N-8).
 */

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

const HttpSettings = z.object({
  transport: z.literal("http").default("http"),
  url: z.string().min(1),
});

const StdioSettings = z.object({
  transport: z.literal("stdio"),
  /** Absolute path; never looked up on PATH, never run through a shell. */
  command: z.string().startsWith("/"),
  args: z.array(z.string()).max(64).default([]),
  /** `host[:port]` entries the server may reach; empty means no network at all. */
  egress: z.array(z.string()).max(32).default([]),
  /** The variable the account's credential is put in, e.g. NOTION_TOKEN. */
  credentialEnv: z.string().regex(ENV_NAME).nullable().default(null),
  /** Host paths the server needs to read (its code, its dependencies), mounted read-only. */
  mounts: z.array(z.string().startsWith("/")).max(16).default([]),
});

const UpstreamSettingsSchema = z.union([StdioSettings, HttpSettings]);

export type UpstreamSettings = z.output<typeof UpstreamSettingsSchema>;
export type StdioUpstream = z.output<typeof StdioSettings>;

/** The account's upstream settings, or null when they don't describe one. */
export function upstreamSettings(settings: Record<string, unknown>): UpstreamSettings | null {
  const parsed = UpstreamSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

export function isEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

/**
 * Pure: how a stdio server runs in the sandbox. It is long-lived, so the wall
 * time is the runner's maximum and output has no cap (stdout is the MCP
 * stream); if the server exits, heel starts it again on the next call.
 */
export function stdioSandboxSpec(
  upstream: StdioUpstream,
  options: { workRoot: string; credential: string | null },
): SandboxSpec {
  return {
    binary: upstream.command,
    args: upstream.args,
    workRoot: options.workRoot,
    cwd: options.workRoot,
    stdin: "pipe",
    readOnlyPaths: upstream.mounts,
    ...(upstream.credentialEnv !== null && options.credential !== null
      ? { secretEnv: { [upstream.credentialEnv]: options.credential } }
      : {}),
    network:
      upstream.egress.length === 0 ? { kind: "none" } : { kind: "egress", allow: upstream.egress },
    limits: { wallTimeMs: MAX_WALL_TIME_MS, maxOutputBytes: Number.MAX_SAFE_INTEGER },
  };
}
