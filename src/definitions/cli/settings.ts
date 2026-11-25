import { parse } from "yaml";
import { z } from "zod";
import { parseCredentialAuth } from "../../runner/intercept.ts";
import {
  CredentialDeliveryChoice,
  effectiveDelivery,
  type SandboxCredentialDelivery,
} from "../credential-delivery.ts";

/**
 * What a CLI account stores: the command name
 * agents use, the absolute binary heel runs (never looked up on PATH, so the
 * agent can't swap it, I-34), the hosts it may reach through heel's egress
 * proxy, and how its credential reaches it.
 *
 * - `gh`: a placeholder in `GH_TOKEN`, and heel's egress proxy adds the token
 *   to requests to GitHub's API and site, and to `GH_UPLOAD_HOSTS` when the
 *   operator allowed them; never to any other extra egress host.
 * - `kubectl`: the credential is a kubeconfig, written into the sandbox,
 *   with `KUBECONFIG` pointing at it; egress to its cluster's API server.
 * - any other CLI: egress only to the hosts the operator lists. With
 *   credential hosts (a subset of those), the variable the operator names
 *   holds a placeholder and heel's egress proxy adds the credential on the
 *   wire; for `npm`, heel also writes a user config whose `_authToken` for
 *   each credential host is that placeholder. Without credential hosts the
 *   credential would be in the variable itself: only when the operator chose
 *   that (`credentialDelivery: env`), and otherwise its commands are refused.
 */

export const CliSettingsSchema = z.object({
  transport: z.literal("cli"),
  command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  bin: z.string().startsWith("/"),
  egress: z.array(z.string()).default([]),
  /** For a CLI heel doesn't know: where its credential (or, with credential hosts, its placeholder) goes. */
  credentialEnv: z.string().nullable().default(null),
  /** `host[:port]` entries, each also in `egress`, that heel's proxy adds the credential for. */
  credentialHosts: z.array(z.string()).max(32).default([]),
  /** Where the credential goes in those requests: `bearer`, `basic` or `header:<Name>`. */
  credentialAuth: z
    .string()
    .refine((text) => parseCredentialAuth(text) !== null)
    .nullable()
    .default(null),
  /** `env` when the operator chose to put the credential in the variable itself. */
  credentialDelivery: CredentialDeliveryChoice.nullable().default(null),
});
export type CliSettings = z.output<typeof CliSettingsSchema>;

export function cliSettings(settings: Record<string, unknown>): CliSettings | null {
  const parsed = CliSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

/**
 * How a CLI account's credential reaches its sandbox (see
 * `../credential-delivery.ts`). `gh` always gets it at heel's egress proxy.
 */
export function cliCredentialDelivery(settings: CliSettings): SandboxCredentialDelivery | null {
  if (settings.command === "gh") return "proxy";
  return effectiveDelivery(settings);
}

/** GitHub's hosts `gh` needs. */
export const GH_EGRESS = ["api.github.com", "github.com"] as const;

/**
 * GitHub's hosts beyond `GH_EGRESS` that `gh` itself sends its token to, so
 * heel's proxy adds the token there too, but only when the operator put the
 * host in the account's egress. gh (2.99.0) adds the token to any request its
 * API client starts to a `*.github.com` host (go-gh's `NormalizeHostname`),
 * and starts them to `uploads.github.com` for release assets (`gh release
 * upload`, `gh release create`) and comment attachments. It reaches
 * `codeload.github.com` and `*.githubusercontent.com` only by a redirect
 * from the API, where it drops the token, and `tuf-repo.github.com` and its
 * telemetry host with clients that never carry it, so none of those get it
 * from heel either. `gh agent-task` also sends the token to a Copilot API
 * host it looks up at run time (`*.githubcopilot.com`); that isn't a fixed
 * host, so it isn't on this list and gets the placeholder.
 */
export const GH_UPLOAD_HOSTS = ["uploads.github.com"] as const;

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
