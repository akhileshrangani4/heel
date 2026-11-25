import type { ListenAddress } from "../config/schema.ts";
import {
  deliveryFix,
  type SandboxCredentialDelivery,
  type SandboxedKind,
} from "../definitions/credential-delivery.ts";

/**
 * Startup warnings about setups that weaken heel's protection (docs/running.md,
 * "Keep agents out of heel's files"). Pure: the caller gathers the facts.
 *
 * heel can't see which OS user an agent runs as, so these warn and never
 * refuse: a heel on a laptop for trying things out is fine, as long as the
 * person knows a local agent with a shell can get around it.
 */

export interface ExposureFacts {
  listen: { agent: ListenAddress; human: ListenAddress };
  /** HEEL_HOME, absolute. */
  home: string;
  /** The OS user heel runs as, and the one that owns HEEL_HOME; null where there are no uids. */
  uid: number | null;
  homeOwnerUid: number | null;
  /** The running user's home directory. */
  userHome: string;
  /**
   * Running in heel's OCI image (it sets HEEL_CONTAINER=1). Inside a
   * container, 0.0.0.0 is the only way to be reachable at all; who can reach
   * the ports is decided by `docker run -p`, which heel can't see.
   */
  container: boolean;
  /** heel runs a Cloudflare tunnel: both planes are on the public internet. */
  publicTunnel?: boolean;
}

export interface ExposureWarning {
  code:
    | "agent_plane_exposed"
    | "human_plane_exposed"
    | "same_user_as_agents"
    | "credential_in_sandbox"
    | "credential_delivery_refused"
    | "container_ports"
    | "public_tunnel";
  /** "info" for a reminder about a setup that is fine when done as the docs say. */
  level?: "info";
  message: string;
}

/** An account whose credential a sandboxed program uses, and how it gets there. */
export interface SandboxedAccount {
  alias: string;
  /** A local MCP server, or a CLI for `heel run`. */
  kind: SandboxedKind;
  /** See `definitions/credential-delivery.ts`. */
  delivery: SandboxCredentialDelivery | null;
}

/**
 * Accounts whose credential would sit in a sandboxed program's environment:
 *
 * - `env`: the operator chose that (`--credential-delivery env`). They work,
 *   but anything the program runs can read the credential, so heel says so
 *   at every start, with how to move it to the proxy.
 * - `refused`: connected before heel refused that by default, and never
 *   moved. Their calls are refused until the operator chooses; this is where
 *   an upgrading operator first hears of it.
 */
export function credentialDeliveryWarnings(
  accounts: readonly SandboxedAccount[],
): ExposureWarning[] {
  const warnings: ExposureWarning[] = [];
  for (const account of accounts) {
    const program = account.kind === "mcp" ? "local MCP server" : "CLI";
    if (account.delivery === "env") {
      warnings.push({
        code: "credential_in_sandbox",
        message:
          `account "${account.alias}" gives its ${program} the credential in its environment ` +
          "(--credential-delivery env), where anything the program runs can read it. " +
          "Name the hosts it authenticates to and heel adds it on the wire instead: " +
          `heel account set ${account.alias} --credential-host <host> ` +
          "[--credential-auth bearer|basic|header:<Name>]",
      });
    } else if (account.delivery === "refused") {
      warnings.push({
        code: "credential_delivery_refused",
        message:
          `account "${account.alias}" would give its ${program} the credential in its environment, ` +
          `which heel no longer does unless asked, so its calls are refused. To fix it, ${deliveryFix(account.alias)}`,
      });
    }
  }
  return warnings;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/** Every interface: inside a container, the only bind the host can publish. */
function isWildcardHost(host: string): boolean {
  return WILDCARD.has(host);
}

/**
 * Strictly inside: `~/.heel` is inside `~`. A service user whose home *is*
 * HEEL_HOME (the OCI image's `heel` user, /var/lib/heel) is the setup the
 * docs recommend, so it doesn't count.
 */
function inside(path: string, dir: string): boolean {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return path !== dir && path.startsWith(base);
}

export function exposureWarnings(facts: ExposureFacts): ExposureWarning[] {
  const warnings: ExposureWarning[] = [];
  if (facts.publicTunnel === true) {
    warnings.push({
      code: "public_tunnel",
      message:
        "heel's approval page and agent plane are on the public internet through its Cloudflare tunnel. Every agent call still needs a token and every decision a passkey, but anyone can reach them: consider Cloudflare Access in front of the approval page's hostname, and a rate-limit rule.",
    });
  }
  const { agent, human } = facts.listen;
  // In the image, 0.0.0.0 is required and the -p flag decides exposure, so a
  // warning would fire on every correct setup. Say what matters once instead.
  const containerBind = (host: string) => facts.container && isWildcardHost(host);
  if (containerBind(agent.host) || containerBind(human.host)) {
    warnings.push({
      code: "container_ports",
      level: "info",
      message:
        "in a container: who can reach heel's ports depends on how they are published. " +
        "Publish them to the host's loopback (-p 127.0.0.1:7300:7300 -p 127.0.0.1:7301:7301), " +
        "or to a private network such as Tailscale; a bare -p 7300:7300 opens them to the network.",
    });
  }
  if (!isLoopbackHost(agent.host) && !containerBind(agent.host)) {
    warnings.push({
      code: "agent_plane_exposed",
      message:
        `the agent port listens on ${agent.host}:${agent.port}, not just this machine. ` +
        "Anyone who can reach it can try agent tokens. Keep it on 127.0.0.1 or a private " +
        "network such as Tailscale; in a container, publish it only to the host's loopback " +
        "(-p 127.0.0.1:7300:7300).",
    });
  }
  if (!isLoopbackHost(human.host) && !containerBind(human.host)) {
    warnings.push({
      code: "human_plane_exposed",
      message:
        `the approval page listens on ${human.host}:${human.port}. Put it behind HTTPS ` +
        "(Tailscale, Cloudflare Tunnel or a reverse proxy) rather than exposing the port itself.",
    });
  }
  if (
    facts.uid !== null &&
    facts.uid !== 0 &&
    facts.uid === facts.homeOwnerUid &&
    inside(facts.home, facts.userHome)
  ) {
    warnings.push({
      code: "same_user_as_agents",
      message:
        `heel runs as your own user with its files in ${facts.home}. A local agent running as ` +
        "the same user (Claude Code, Codex) can read the master key, the database and the " +
        "rules, so heel can't control it. That's fine for trying heel out; to keep local " +
        "agents out, run heel on another machine, as its own user, or in Docker (docs/running.md).",
    });
  }
  return warnings;
}
