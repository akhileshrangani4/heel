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
  code: "agent_plane_exposed" | "human_plane_exposed" | "same_user_as_agents";
  message: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
}

function inside(path: string, dir: string): boolean {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return path === dir || path.startsWith(base);
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
        "the same user (Claude Code, Codex) can read the master key and edit the rules, so " +
        "heel can't stop it. That's fine for trying heel out; to keep local agents out, run " +
        "heel as its own user or in Docker (docs/running.md).",
    });
  }
  return warnings;
}
