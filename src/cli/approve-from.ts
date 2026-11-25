import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isMap, isScalar, parseDocument } from "yaml";
import type { ExecFn } from "./common.ts";

/**
 * Where the owner approves from, set up by `heel init
 * --approve-from`. A passkey only works on the address it was made on, so the
 * address is settled here, before any passkey exists, and must stay put.
 *
 * - `this-computer`: the approval page stays on 127.0.0.1; nothing to do.
 * - `tailscale`: `tailscale serve` gives both planes an HTTPS address on the
 *   tailnet (the devices its access rules let in), and keeps them up itself.
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
    const n = match?.[1] === undefined ? null : Number(match[1]);
    return n !== null && n >= 1 && n <= 65_535 ? n : null;
  };
  return { agent: port("agent") ?? ports.agent, human: port("human") ?? ports.human };
}

/** `public_url` and `agent_public_url` as heel.yaml has them, or null where it doesn't. */
export function configuredAddresses(configText: string | null): {
  approvals: string | null;
  agents: string | null;
} {
  if (configText === null) return { approvals: null, agents: null };
  const doc = parseDocument(configText);
  const get = (key: string) => {
    const value = doc.get(key);
    return value === undefined || value === null ? null : String(value);
  };
  return { approvals: get("public_url"), agents: get("agent_public_url") };
}

/** The JSON a tailscale command printed. Its output is stdout then stderr, so a warning may follow. */
function tailscaleJson(output: string): { ok: true; value: unknown } | { ok: false } {
  const text = output.trim();
  for (const json of [text, text.slice(0, text.lastIndexOf("}") + 1), text.split("\n")[0]]) {
    if (json === undefined || json === "") continue;
    try {
      return { ok: true, value: JSON.parse(json) as unknown };
    } catch {
      // Try the next reading.
    }
  }
  return { ok: false };
}

/** The parts of `tailscale serve status --json` heel reads (Tailscale's ipn.ServeConfig). */
interface ServeConfig {
  TCP?: Record<
    string,
    { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; TerminateTLS?: string } | null
  >;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | null> } | null>;
  Foreground?: Record<string, ServeConfig | null>;
}

/** What a tailnet port of this machine serves: one of heel's planes, or something else. */
export type ServedBy = "approvals" | "agents" | "other";

/**
 * Who serves each tailnet port of this machine, from `tailscale serve status
 * --json`. A port not in the map is free. A port is heel's only when all it
 * serves is one of heel's planes at `/`; a TCP forward, a foreground `tailscale
 * serve`, another path or another name on it make it someone else's. Null when
 * the output can't be read, so nothing is known to be free.
 */
export function servedPorts(
  output: string,
  name: string,
  ports: { agent: number; human: number },
): Map<number, ServedBy> | null {
  const parsed = tailscaleJson(output);
  if (!parsed.ok) return null;
  // Nothing served at all prints `null`.
  if (parsed.value === null) return new Map();
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) return null;
  const config = parsed.value as ServeConfig;
  const served = new Map<number, ServedBy>();
  const mark = (port: number | null, by: ServedBy) => {
    if (port === null || !Number.isInteger(port) || port < 1 || port > 65_535) return;
    const before = served.get(port);
    served.set(port, before === undefined || before === by ? by : "other");
  };
  const portOf = (hostPort: string) => {
    const match = /:(\d+)$/.exec(hostPort);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  for (const session of Object.values(config.Foreground ?? {})) {
    for (const port of Object.keys(session?.TCP ?? {})) mark(Number(port), "other");
    for (const hostPort of Object.keys(session?.Web ?? {})) mark(portOf(hostPort), "other");
  }
  for (const [port, handler] of Object.entries(config.TCP ?? {})) {
    const httpsOnly =
      handler?.HTTPS === true &&
      handler.HTTP !== true &&
      !handler.TCPForward &&
      !handler.TerminateTLS;
    if (!httpsOnly) mark(Number(port), "other");
  }
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const port = portOf(hostPort);
    const handlers = Object.entries(web?.Handlers ?? {});
    const proxy = handlers.length === 1 && handlers[0]?.[0] === "/" ? handlers[0][1]?.Proxy : null;
    const target = proxy?.replace(/\/$/, "");
    const plane =
      hostPort !== `${name}:${port}`
        ? "other"
        : target === `http://127.0.0.1:${ports.human}`
          ? "approvals"
          : target === `http://127.0.0.1:${ports.agent}`
            ? "agents"
            : "other";
    mark(port, plane);
  }
  // An HTTPS port with nothing behind it is still Tailscale's to answer.
  for (const port of Object.keys(config.TCP ?? {})) {
    if (!served.has(Number(port))) mark(Number(port), "other");
  }
  return served;
}

/** Each plane's preferred tailnet port; past those, heel tries 7443 up to 7499. */
const PREFERRED = { approvals: 443, agents: 8443 } as const;
const SPARE_PORTS = Array.from({ length: 57 }, (_, i) => 7443 + i);

/** An HTTPS address on this machine's tailnet name; 443 needs no port. */
function tailnetAddress(name: string, port: number): string {
  return port === 443 ? `https://${name}` : `https://${name}:${port}`;
}

/** The tailnet port an address uses when it's on this machine's name, or null. */
function tailnetPort(address: string | null, name: string): number | null {
  if (address === null || !URL.canParse(address)) return null;
  const url = new URL(address);
  if (url.protocol !== "https:" || url.hostname !== name.toLowerCase()) return null;
  return url.port === "" ? 443 : Number(url.port);
}

type TailnetPorts = { approvals: number; agents: number };

/**
 * The tailnet ports for heel's two planes. An address heel.yaml already has on
 * this machine stays (a passkey is tied to it); then a port Tailscale already
 * serves that plane on (a rerun); then 443 for approvals and 8443 for agents;
 * then the first free port from 7443. Never a port something else serves.
 */
export function chooseTailnetPorts(
  served: ReadonlyMap<number, ServedBy>,
  configured: { approvals: number | null; agents: number | null },
):
  | { ok: true; ports: TailnetPorts }
  | { ok: false; why: "none" | "taken" | "same"; plane: "approvals" | "agents"; port: number } {
  const pick = (plane: "approvals" | "agents", not: number | null): number | null => {
    const ours = [...served]
      .filter(([port, by]) => by === plane && port !== not)
      .map(([port]) => port)
      .sort((a, b) => a - b);
    if (ours.length > 0)
      return ours.includes(PREFERRED[plane]) ? PREFERRED[plane] : (ours[0] ?? null);
    return [PREFERRED[plane], ...SPARE_PORTS].find((p) => p !== not && !served.has(p)) ?? null;
  };
  const approvals = configured.approvals ?? pick("approvals", configured.agents);
  if (approvals === null) return { ok: false, why: "none", plane: "approvals", port: 0 };
  const agents = configured.agents ?? pick("agents", approvals);
  if (agents === null) return { ok: false, why: "none", plane: "agents", port: 0 };
  if (approvals === agents) return { ok: false, why: "same", plane: "agents", port: agents };
  for (const [plane, port] of [
    ["approvals", approvals],
    ["agents", agents],
  ] as const) {
    const by = served.get(port);
    if (by !== undefined && by !== plane) return { ok: false, why: "taken", plane, port };
  }
  return { ok: true, ports: { approvals, agents } };
}

/** The commands and heel.yaml lines that set up Tailscale for heel by hand, ready to copy. */
export function tailscaleByHand(
  name: string,
  ports: { agent: number; human: number },
  tailnet: TailnetPorts,
  configPath: string,
): string {
  return [
    "To set it up yourself, run:",
    `  tailscale serve --bg --https=${tailnet.approvals} http://127.0.0.1:${ports.human}`,
    `  tailscale serve --bg --https=${tailnet.agents} http://127.0.0.1:${ports.agent}`,
    `then set these in ${configPath}, and restart heel if it's running:`,
    `  public_url: ${tailnetAddress(name, tailnet.approvals)}`,
    `  agent_public_url: ${tailnetAddress(name, tailnet.agents)}`,
  ].join("\n");
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string };
  CertDomains?: string[] | null;
}

/**
 * Serves both planes on the tailnet with `tailscale serve`: the approval page
 * on https://<machine>.<tailnet>.ts.net and the agent plane on port 8443. When
 * Tailscale already serves something else on one of those ports, heel takes a
 * free one from 7443 instead and says so in `note`; it never replaces what's
 * there. A rerun keeps the ports heel.yaml and Tailscale already have.
 */
export async function setUpTailscale(
  exec: ExecFn,
  ports: { agent: number; human: number },
  options: {
    /** Runs once the addresses are known and before anything changes; a problem stops it there. */
    precheck?: (addresses: PublicAddresses) => string | null;
    /** `public_url` and `agent_public_url` heel.yaml already has. */
    configured?: { approvals: string | null; agents: string | null };
    /** heel.yaml, named in the lines to set by hand. */
    configPath?: string;
  } = {},
): Promise<SetupOutcome & { note?: string }> {
  const configPath = options.configPath ?? "heel.yaml";
  const status = await exec("tailscale", ["status", "--json"]);
  if (status.code === 127) {
    return {
      ok: false,
      problem:
        "Tailscale isn't installed here. Install it from https://tailscale.com/download, sign in with `tailscale up`, then run this again.",
    };
  }
  const read = tailscaleJson(status.output);
  const parsed = (
    read.ok && typeof read.value === "object" ? read.value : null
  ) as TailscaleStatus | null;
  if (parsed === null) {
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
  // What's served already decides the ports, so it's read before anything changes.
  const current = await exec("tailscale", ["serve", "status", "--json"]);
  const served = current.code === 0 ? servedPorts(current.output, name, ports) : null;
  if (served === null) {
    const said = current.output.trim().slice(0, 300) || `exit ${current.code}`;
    return {
      ok: false,
      problem: `heel couldn't read what Tailscale already serves here (\`tailscale serve status --json\`: ${said}), so it changed nothing. Check \`tailscale serve status\` first: if something else is on port 443 or 8443, use a free port instead, like 7443 or 7444, in both places below.\n${tailscaleByHand(name, ports, PREFERRED, configPath)}`,
    };
  }
  const configured = {
    approvals: tailnetPort(options.configured?.approvals ?? null, name),
    agents: tailnetPort(options.configured?.agents ?? null, name),
  };
  const chosen = chooseTailnetPorts(served, configured);
  if (!chosen.ok) {
    const key = chosen.plane === "approvals" ? "public_url" : "agent_public_url";
    const moving =
      chosen.plane === "approvals"
        ? "a passkey only works on the address it was made on, so moving it means making your passkey again"
        : "moving it means adding heel to your agents again";
    return {
      ok: false,
      problem:
        chosen.why === "none"
          ? `Tailscale already serves something on ports 443, 8443 and 7443 to 7499 of this machine, so heel found no free port for ${chosen.plane}. See \`tailscale serve status\`, free a port (\`tailscale serve --https=<port> off\`), then run this again.`
          : chosen.why === "same"
            ? `${configPath} has public_url and agent_public_url on the same port, ${chosen.port}, and heel's two planes need a port each. Put agent_public_url on another port yourself (${moving}), then run this again.`
            : `${configPath} has ${key} on port ${chosen.port}, but Tailscale serves something else there, and heel won't replace it. See \`tailscale serve status\`; free the port (\`tailscale serve --https=${chosen.port} off\`) and run this again. heel won't move ${key} itself: ${moving}.`,
    };
  }
  const tailnet = chosen.ports;
  const addresses = {
    approvals: tailnetAddress(name, tailnet.approvals),
    agents: tailnetAddress(name, tailnet.agents),
  };
  const blocked = options.precheck?.(addresses) ?? null;
  if (blocked !== null) return { ok: false, problem: blocked };
  for (const [plane, port, target] of [
    ["approvals", tailnet.approvals, ports.human],
    ["agents", tailnet.agents, ports.agent],
  ] as const) {
    // Already heel's from an earlier run: nothing to change.
    if (served.get(port) === plane) continue;
    const set = await exec("tailscale", [
      "serve",
      "--bg",
      `--https=${port}`,
      `http://127.0.0.1:${target}`,
    ]);
    if (set.code !== 0) {
      return {
        ok: false,
        problem: `\`tailscale serve --https=${port}\` failed: ${set.output.trim().slice(0, 300)}\n${tailscaleByHand(name, ports, tailnet, configPath)}`,
      };
    }
  }
  const taken = [PREFERRED.approvals, PREFERRED.agents].filter((p) => served.get(p) === "other");
  const moved = tailnet.approvals !== PREFERRED.approvals || tailnet.agents !== PREFERRED.agents;
  if (!moved || taken.length === 0) return { ok: true, addresses };
  return {
    ok: true,
    addresses,
    note: `Tailscale already serves something else on port${taken.length > 1 ? "s" : ""} ${taken.join(" and ")}, so heel used ports ${tailnet.approvals} (approvals) and ${tailnet.agents} (agents).`,
  };
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
 * Where the agent plane goes for a Cloudflare approval hostname: a sibling on
 * the same domain, so the free certificate covers it. Null for a bare domain
 * (`example.com`), whose sibling would be another domain (`example-agents.com`).
 */
export function agentHostnameFor(hostname: string): string | null {
  const [first, ...rest] = hostname.split(".");
  if (rest.length < 2) return null;
  return `${first}-agents.${rest.join(".")}`;
}

/** Whether two hostnames sit side by side under the same parent (`a.example.com`, `b.example.com`). */
export function sameParent(a: string, b: string): boolean {
  const parent = (h: string) => h.split(".").slice(1).join(".");
  return a !== b && parent(a) !== "" && parent(a) === parent(b) && parent(a).includes(".");
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
    // cloudflared names the record it added; a name outside the zone comes back with the zone added.
    const added = /Added CNAME (\S+)/.exec(routed.output)?.[1];
    const wrong = added !== undefined && added.toLowerCase().replace(/\.$/, "") !== hostname;
    if (routed.code !== 0 || wrong) {
      // Leave nothing half made: the tunnel goes, and with it any route it got.
      await exec("cloudflared", ["tunnel", "delete", "--force", tunnelId]);
      return {
        ok: false,
        problem: wrong
          ? `Cloudflare routed ${added} rather than ${hostname}: ${hostname} isn't on the domain cloudflared is signed in to. Use hostnames on that domain.`
          : `\`cloudflared tunnel route dns\` for ${hostname} failed: ${routed.output.trim().slice(0, 300)}. heel removed the tunnel it had just made. If a DNS record with that name already exists for something else, pick another hostname.`,
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
