import type { ListenAddress } from "../config/schema.ts";

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
}

export interface ExposureWarning {
  code:
    | "agent_plane_exposed"
    | "human_plane_exposed"
    | "same_user_as_agents"
    | "credential_in_sandbox";
  message: string;
}

/** An account whose credential a sandboxed program uses, and how it gets there. */
export interface SandboxedAccount {
  alias: string;
  /** A local MCP server, or a CLI for `heel run`. */
  kind: "mcp" | "cli";
  /** `env`: the program holds the credential; `proxy`: heel adds it on the wire. */
  delivery: "proxy" | "env" | null;
}

/**
 * Accounts connected before heel could keep their credential out of the
 * sandbox. They still work: the program gets the credential in its
 * environment, where anything it runs can read it.
 */
export function credentialDeliveryWarnings(
  accounts: readonly SandboxedAccount[],
): ExposureWarning[] {
  return accounts
    .filter((account) => account.delivery === "env")
    .map((account) => ({
      code: "credential_in_sandbox" as const,
      message:
        account.kind === "mcp"
          ? `account "${account.alias}" gives its local MCP server the credential in its environment, ` +
            "where anything the server runs can read it. Name the hosts it authenticates to and " +
            `heel adds it on the wire instead: heel account set ${account.alias} ` +
            "--credential-host <host> [--credential-auth bearer|basic|header:<name>]"
          : `account "${account.alias}" gives its CLI the credential in its environment, where ` +
            "anything the command runs can read it. heel can keep it out of the sandbox only for " +
            "gh so far; until then, connect only credentials scoped to what the agent may do.",
    }));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
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
  const { agent, human } = facts.listen;
  if (!isLoopbackHost(agent.host)) {
    warnings.push({
      code: "agent_plane_exposed",
      message:
        `the agent port listens on ${agent.host}:${agent.port}, not just this machine. ` +
        "Anyone who can reach it can try agent tokens. Keep it on 127.0.0.1 or a private " +
        "network such as Tailscale; in a container, publish it only to the host's loopback " +
        "(-p 127.0.0.1:7300:7300).",
    });
  }
  if (!isLoopbackHost(human.host)) {
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
