import { parse } from "yaml";
import { z } from "zod";

/**
 * What a CLI account stores (D8b; spec: CLI runner): the command name
 * agents use, the absolute binary heel runs (never looked up on PATH, so the
 * agent can't swap it, I-34), the hosts it may reach through heel's egress
 * proxy, and how its credential reaches it.
 *
 * - `gh`: a placeholder in `GH_TOKEN`, and heel's egress proxy adds the token
 *   to requests to GitHub's API and site, never to an extra egress host.
 * - `kubectl`: the credential is a kubeconfig, written into the sandbox,
 *   with `KUBECONFIG` pointing at it; egress to its cluster's API server.
 * - any other CLI: the credential in the environment variable the operator
 *   names, and egress only to the hosts the operator lists.
 */

export const CliSettingsSchema = z.object({
  transport: z.literal("cli"),
  command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  bin: z.string().startsWith("/"),
  egress: z.array(z.string()).default([]),
  /** For a CLI heel doesn't know: where its credential goes. */
  credentialEnv: z.string().nullable().default(null),
});
export type CliSettings = z.output<typeof CliSettingsSchema>;

export function cliSettings(settings: Record<string, unknown>): CliSettings | null {
  const parsed = CliSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

/** GitHub's hosts `gh` needs (spec: CLI runner, "Network"). */
export const GH_EGRESS = ["api.github.com", "github.com"] as const;

/** The API server hosts a kubeconfig names, as `host:port`; null when it doesn't parse. */
export function kubeconfigServers(kubeconfig: string): string[] | null {
  let doc: unknown;
  try {
    doc = parse(kubeconfig);
  } catch {
    return null;
  }
  const clusters = (doc as { clusters?: unknown } | null)?.clusters;
  if (!Array.isArray(clusters)) return null;
  const hosts: string[] = [];
  for (const entry of clusters) {
    const server = (entry as { cluster?: { server?: unknown } })?.cluster?.server;
    if (typeof server !== "string" || !URL.canParse(server)) return null;
    const url = new URL(server);
    if (url.protocol !== "https:") return null;
    hosts.push(`${url.hostname}:${url.port === "" ? "443" : url.port}`);
  }
  return hosts.length === 0 ? null : hosts;
}
