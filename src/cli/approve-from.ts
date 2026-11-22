import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import type { ExecFn } from "./common.ts";

/**
 * Where the owner approves from (roadmap 2.7), set up by `heel init
 * --approve-from`. A passkey only works on the address it was made on, so the
 * address is settled here, before any passkey exists, and must stay put.
 *
 * - `this-computer`: the approval page stays on 127.0.0.1; nothing to do.
 * - `tailscale`: `tailscale serve` gives both planes an HTTPS address on the
 *   tailnet (only the owner's devices reach it), and keeps them up itself.
 * - `cloudflare`: a named tunnel on the owner's own domain, whose address
 *   never changes. heel creates it, routes DNS, writes the cloudflared
 *   config, and runs the tunnel alongside itself (src/gateway/tunnel.ts).
 */

export const APPROVE_FROM = ["this-computer", "tailscale", "cloudflare"] as const;
export type ApproveFrom = (typeof APPROVE_FROM)[number];

export function isApproveFrom(value: string): value is ApproveFrom {
  return (APPROVE_FROM as readonly string[]).includes(value);
}

export interface PublicAddresses {
  /** The approval page: becomes `public_url`. */
  approvals: string;
  /** The agent plane: becomes `agent_public_url`. */
  agents: string;
}

export type SetupOutcome =
  | { ok: true; addresses: PublicAddresses | null }
  | { ok: false; problem: string };

/** The ports heel.yaml listens on, defaults when it doesn't say. */
export function listenPorts(configText: string | null): { agent: number; human: number } {
  const ports = { agent: 7300, human: 7301 };
  if (configText === null) return ports;
  const doc = parseDocument(configText);
  const port = (key: "agent" | "human") => {
    const value = doc.getIn(["listen", key]);
    const match = typeof value === "string" ? /:(\d+)$/.exec(value) : null;
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  return { agent: port("agent") ?? ports.agent, human: port("human") ?? ports.human };
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string };
  CertDomains?: string[] | null;
}

/**
 * Serves both planes on the tailnet with `tailscale serve`: the approval page
 * on https://<machine>.<tailnet>.ts.net and the agent plane on port 8443.
 */
export async function setUpTailscale(
  exec: ExecFn,
  ports: { agent: number; human: number },
): Promise<SetupOutcome> {
  const status = await exec("tailscale", ["status", "--json"]);
  if (status.code === 127) {
    return {
      ok: false,
      problem:
        "Tailscale isn't installed here. Install it from https://tailscale.com/download, sign in with `tailscale up`, then run this again.",
    };
  }
  let parsed: TailscaleStatus;
  try {
    parsed = JSON.parse(status.output) as TailscaleStatus;
  } catch {
    return {
      ok: false,
      problem: `\`tailscale status\` didn't answer as expected: ${status.output.trim().slice(0, 300)}`,
    };
  }
  if (parsed.BackendState !== "Running") {
    return {
      ok: false,
      problem: `Tailscale isn't connected (${parsed.BackendState ?? "unknown"}). Run \`tailscale up\`, then run this again.`,
    };
  }
  const name = parsed.Self?.DNSName?.replace(/\.$/, "");
  if (name === undefined || name === "") {
    return {
      ok: false,
      problem:
        "Tailscale didn't give this machine a name. Turn on MagicDNS in the Tailscale admin console (DNS page), then run this again.",
    };
  }
  if ((parsed.CertDomains ?? []).length === 0) {
    return {
      ok: false,
      problem:
        "Your tailnet doesn't have HTTPS certificates turned on, and a passkey needs HTTPS. Turn them on at https://login.tailscale.com/admin/dns (HTTPS Certificates), then run this again.",
    };
  }
  for (const [port, target] of [
    [443, ports.human],
    [8443, ports.agent],
  ] as const) {
    const served = await exec("tailscale", [
      "serve",
      "--bg",
      `--https=${port}`,
      `http://127.0.0.1:${target}`,
    ]);
    if (served.code !== 0) {
      return {
        ok: false,
        problem: `\`tailscale serve --https=${port}\` failed: ${served.output.trim().slice(0, 300)}`,
      };
    }
  }
  return { ok: true, addresses: { approvals: `https://${name}`, agents: `https://${name}:8443` } };
}

/**
 * Writes the addresses into heel.yaml, keeping everything else as it is.
 * Refuses to change an address already set: a passkey made on the old one
 * would stop working.
 */
export function writeAddresses(
  configPath: string,
  addresses: PublicAddresses,
): { ok: true; changed: boolean } | { ok: false; problem: string } {
  const text = readFileSync(configPath, "utf8");
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) return { ok: false, problem: `${configPath} isn't a mapping` };
  let changed = false;
  for (const [key, value] of [
    ["public_url", addresses.approvals],
    ["agent_public_url", addresses.agents],
  ] as const) {
    const current = doc.get(key);
    if (current === undefined || current === null) {
      doc.set(doc.createNode(key), value);
      changed = true;
    } else if (current !== value) {
      return {
        ok: false,
        problem: `${configPath} already has ${key}: ${String(current)}. Changing it means making your passkey again, since a passkey only works on the address it was made on. If that's what you want, edit ${key} yourself.`,
      };
    }
  }
  if (changed) {
    const key = doc.contents.items.find(
      (pair) => isScalar(pair.key) && pair.key.value === "public_url",
    )?.key;
    if (isScalar(key)) {
      key.commentBefore =
        " Where you approve, and where agents connect, set by heel init.\n A passkey only works on the address it was made on: don't change these lightly.";
    }
    writeFileSync(configPath, doc.toString());
  }
  return { ok: true, changed };
}

/** Where the agent plane goes for a Cloudflare approval hostname: a sibling, so the free certificate covers it. */
export function agentHostnameFor(hostname: string): string {
  const [first, ...rest] = hostname.split(".");
  return `${first}-agents.${rest.join(".")}`;
}

/** A hostname heel can route: lower case labels, at least a name and a domain. */
export function isHostname(text: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text);
}

/** The cloudflared config heel writes: both planes by hostname, and nothing else. */
export function cloudflaredConfig(input: {
  tunnelId: string;
  credentialsFile: string;
  hostname: string;
  agentHostname: string;
  ports: { agent: number; human: number };
}): string {
  return [
    "# Written by heel init --approve-from cloudflare. heel runs this tunnel itself.",
    `tunnel: ${input.tunnelId}`,
    `credentials-file: ${JSON.stringify(input.credentialsFile)}`,
    "ingress:",
    `  - hostname: ${input.hostname}`,
    `    service: http://127.0.0.1:${input.ports.human}`,
    `  - hostname: ${input.agentHostname}`,
    `    service: http://127.0.0.1:${input.ports.agent}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

/**
 * Creates a named tunnel for both planes, with its credentials in heel's
 * home, and routes the two hostnames to it. Needs `cloudflared tunnel login`
 * done once, in the browser, for the domain.
 */
export async function setUpCloudflare(
  exec: ExecFn,
  input: {
    home: string;
    hostname: string;
    agentHostname: string;
    ports: { agent: number; human: number };
    /** Whether cloudflared's login certificate is there (`~/.cloudflared/cert.pem`). */
    loggedIn: boolean;
    /** A short random suffix for the tunnel's name. */
    suffix: string;
  },
): Promise<SetupOutcome & { config?: string; credentialsFile?: string }> {
  const version = await exec("cloudflared", ["--version"]);
  if (version.code === 127) {
    return {
      ok: false,
      problem:
        "cloudflared isn't installed here. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), run `cloudflared tunnel login` once to pick your domain, then run this again.",
    };
  }
  if (!input.loggedIn) {
    return {
      ok: false,
      problem:
        "cloudflared isn't signed in to Cloudflare yet. Run `cloudflared tunnel login`, choose the domain heel's address is on, then run this again.",
    };
  }
  const credentialsFile = join(input.home, "cloudflared", `heel-${input.suffix}.json`);
  const created = await exec("cloudflared", [
    "tunnel",
    "create",
    "--output",
    "json",
    "--credentials-file",
    credentialsFile,
    `heel-${input.suffix}`,
  ]);
  let tunnelId: string | undefined;
  try {
    tunnelId = (JSON.parse(created.output) as { id?: string }).id;
  } catch {
    tunnelId = undefined;
  }
  if (created.code !== 0 || tunnelId === undefined) {
    return {
      ok: false,
      problem: `\`cloudflared tunnel create\` failed: ${created.output.trim().slice(0, 300)}`,
    };
  }
  for (const hostname of [input.hostname, input.agentHostname]) {
    const routed = await exec("cloudflared", ["tunnel", "route", "dns", tunnelId, hostname]);
    if (routed.code !== 0) {
      return {
        ok: false,
        problem: `\`cloudflared tunnel route dns\` for ${hostname} failed: ${routed.output.trim().slice(0, 300)}. If a DNS record for it already exists, remove it in Cloudflare's dashboard, then run this again.`,
      };
    }
  }
  return {
    ok: true,
    addresses: { approvals: `https://${input.hostname}`, agents: `https://${input.agentHostname}` },
    config: cloudflaredConfig({
      tunnelId,
      credentialsFile,
      hostname: input.hostname,
      agentHostname: input.agentHostname,
      ports: input.ports,
    }),
    credentialsFile,
  };
}

/** Points heel.yaml at the cloudflared config, so heel runs the tunnel. */
export function writeTunnelConfig(configPath: string, file: string): void {
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  doc.setIn(["tunnel", "cloudflare", "config"], file);
  writeFileSync(configPath, doc.toString());
}
