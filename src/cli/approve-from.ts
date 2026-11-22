import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { isMap, isScalar, parseDocument } from "yaml";
import type { ExecFn } from "./common.ts";

/**
 * Where the owner approves from (roadmap 2.7), set up by `heel init
 * --approve-from`. A passkey only works on the address it was made on, so the
 * address is settled here, before any passkey exists, and must stay put.
 *
 * - `this-computer`: the approval page stays on 127.0.0.1; nothing to do.
 * - `tailscale`: `tailscale serve` gives both planes an HTTPS address on the
 *   tailnet (the devices its access rules let in), and keeps them up itself.
 */

export const APPROVE_FROM = ["this-computer", "tailscale"] as const;
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
    const n = match?.[1] === undefined ? null : Number(match[1]);
    return n !== null && n >= 1 && n <= 65_535 ? n : null;
  };
  return { agent: port("agent") ?? ports.agent, human: port("human") ?? ports.human };
}

/**
 * The tailnet ports (443, 8443) `tailscale serve status --json` shows serving
 * anything but heel's own planes there.
 */
export function servedElsewhere(
  statusJson: string,
  name: string,
  ports: { agent: number; human: number },
): number[] {
  let parsed: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  try {
    parsed = JSON.parse(statusJson) as typeof parsed;
  } catch {
    return [];
  }
  const taken: number[] = [];
  for (const [port, target] of [
    [443, ports.human],
    [8443, ports.agent],
  ] as const) {
    const handlers = parsed.Web?.[`${name}:${port}`]?.Handlers ?? {};
    const ours = `http://127.0.0.1:${target}`;
    if (
      Object.entries(handlers).some(
        ([path, h]) => path !== "/" || h.Proxy?.replace(/\/$/, "") !== ours,
      )
    ) {
      taken.push(port);
    }
  }
  return taken;
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
  /** Runs once the addresses are known and before anything changes; a problem stops it there. */
  precheck: (addresses: PublicAddresses) => string | null = () => null,
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
  const addresses = { approvals: `https://${name}`, agents: `https://${name}:8443` };
  const blocked = precheck(addresses);
  if (blocked !== null) return { ok: false, problem: blocked };
  // Don't take over a port something else is already served on.
  const current = await exec("tailscale", ["serve", "status", "--json"]);
  const taken = current.code === 0 ? servedElsewhere(current.output, name, ports) : [];
  if (taken.length > 0) {
    return {
      ok: false,
      problem: `Tailscale already serves something else on ${taken.map((p) => `port ${p}`).join(" and ")} of this machine, and heel won't replace it. See \`tailscale serve status\`; free the port (\`tailscale serve --https=<port> off\`) or set heel's addresses by hand.`,
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
  return { ok: true, addresses };
}

/**
 * Writes the addresses into heel.yaml, keeping everything else as it is.
 * Refuses to change an address already set: a passkey made on the old one
 * would stop working.
 */
function origin(text: string): string | null {
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

/** Why heel.yaml can't take these addresses, or null when it can. Changes nothing. */
export function addressProblem(configPath: string, addresses: PublicAddresses): string | null {
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (!isMap(doc.contents)) return `${configPath} isn't a mapping`;
  for (const [key, value] of [
    ["public_url", addresses.approvals],
    ["agent_public_url", addresses.agents],
  ] as const) {
    const current = doc.get(key);
    if (current === undefined || current === null) continue;
    if (origin(String(current)) !== origin(value)) {
      return `${configPath} already has ${key}: ${String(current)}. Changing it means making your passkey again, since a passkey only works on the address it was made on. If that's what you want, edit ${key} yourself.`;
    }
  }
  return null;
}

export function writeAddresses(
  configPath: string,
  addresses: PublicAddresses,
): { ok: true; changed: boolean } | { ok: false; problem: string } {
  const problem = addressProblem(configPath, addresses);
  if (problem !== null) return { ok: false, problem };
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (!isMap(doc.contents)) return { ok: false, problem: `${configPath} isn't a mapping` };
  let changed = false;
  const addingPublicUrl = doc.get("public_url") == null;
  for (const [key, value] of [
    ["public_url", addresses.approvals],
    ["agent_public_url", addresses.agents],
  ] as const) {
    const current = doc.get(key);
    if (current === undefined || current === null) {
      doc.set(doc.createNode(key), value);
      changed = true;
    }
  }
  if (addingPublicUrl) {
    const key = doc.contents.items.find(
      (pair) => isScalar(pair.key) && pair.key.value === "public_url",
    )?.key;
    if (isScalar(key)) {
      key.commentBefore =
        " Where you approve, and where agents connect, set by heel init.\n A passkey only works on the address it was made on: don't change these lightly.";
    }
  }
  if (changed) writeFileSync(configPath, doc.toString());
  return { ok: true, changed };
}

/**
 * Why moving heel to these addresses would orphan a passkey, or null: a
 * passkey made for another address stops working once heel moves, so heel
 * moves only when told to (`--new-address`).
 */
export function passkeyProblem(databasePath: string, addresses: PublicAddresses): string | null {
  if (!existsSync(databasePath)) return null;
  const target = new URL(addresses.approvals).hostname;
  let rpIds: (string | null)[] = [];
  try {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      rpIds = (
        db.prepare("SELECT rp_id AS rpId FROM passkeys").all() as { rpId: string | null }[]
      ).map((row) => row.rpId);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  const elsewhere = rpIds.filter((rp) => rp !== target);
  if (elsewhere.length === 0) return null;
  const where = [...new Set(elsewhere.map((rp) => rp ?? "an earlier address"))].join(", ");
  return `heel already has a passkey made for ${where}. Moving heel to ${addresses.approvals} means making your passkey again there, since a passkey only works on the address it was made on. If that's what you want, run this again with --new-address.`;
}
