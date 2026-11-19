import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { HeelDb, HeelTx } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { agents } from "../store/schema.ts";
import { issueAgentToken, revokeAgentTokens } from "./agent-tokens.ts";

/**
 * Agent lifecycle behind `heel agent add|rotate|revoke|list` (spec: MCP and
 * code mode, "Agent authentication"). Every change takes effect on the next
 * call, because authentication reads the store on every request.
 */

/** Agent names appear in rules (`agent: inbox-bot`) and audit rows. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME.test(name);
}

export type AgentErrorCode = "invalid_name" | "name_taken" | "not_found" | "revoked";

export class AgentError extends Error {
  override readonly name = "AgentError";
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AgentSummary {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface IssuedAgent {
  agentId: string;
  name: string;
  /** Shown once; heel stores only its hash. */
  token: string;
}

function findAgent(tx: HeelDb | HeelTx, orgId: string, name: string) {
  return tx
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.name, name)))
    .get();
}

/** The id of the agent with this name, revoked or not; pausing a revoked agent is harmless. */
export function agentIdByName(db: HeelDb, orgId: string, name: string): string {
  const agent = findAgent(db, orgId, name);
  if (!agent) throw new AgentError("not_found", `no agent named "${name}"`);
  return agent.id;
}

function requireLiveAgent(tx: HeelTx, orgId: string, name: string) {
  const agent = findAgent(tx, orgId, name);
  if (!agent) throw new AgentError("not_found", `no agent named "${name}"`);
  if (agent.revokedAt) throw new AgentError("revoked", `agent "${name}" is revoked`);
  return agent;
}

export function addAgent(
  db: HeelDb,
  input: { orgId: string; ownerId: string; name: string },
  now: Date,
): IssuedAgent {
  if (!isValidAgentName(input.name)) {
    throw new AgentError(
      "invalid_name",
      "agent names are 1–64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  }
  return db.transaction((tx) => {
    // Names stay reserved after revocation so audit history keeps one meaning.
    if (findAgent(tx, input.orgId, input.name)) {
      throw new AgentError("name_taken", `an agent named "${input.name}" already exists`);
    }
    const agentId = newId("agent");
    tx.insert(agents)
      .values({
        id: agentId,
        orgId: input.orgId,
        ownerId: input.ownerId,
        name: input.name,
        createdAt: now,
        revokedAt: null,
      })
      .run();
    const token = issueAgentToken(tx, { orgId: input.orgId, agentId }, now);
    return { agentId, name: input.name, token };
  });
}

/** Replaces every token of a live agent with one new token. */
export function rotateAgentToken(db: HeelDb, orgId: string, name: string, now: Date): IssuedAgent {
  return db.transaction((tx) => {
    const agent = requireLiveAgent(tx, orgId, name);
    revokeAgentTokens(tx, agent.id, now);
    const token = issueAgentToken(tx, { orgId, agentId: agent.id }, now);
    return { agentId: agent.id, name: agent.name, token };
  });
}

/** Revokes an agent and all its tokens. Irreversible: add a new agent instead. */
export function revokeAgent(db: HeelDb, orgId: string, name: string, now: Date): void {
  db.transaction((tx) => {
    const agent = requireLiveAgent(tx, orgId, name);
    tx.update(agents).set({ revokedAt: now }).where(eq(agents.id, agent.id)).run();
    revokeAgentTokens(tx, agent.id, now);
  });
}

export function listAgents(db: HeelDb, orgId: string): AgentSummary[] {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      ownerId: agents.ownerId,
      createdAt: agents.createdAt,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .where(eq(agents.orgId, orgId))
    .orderBy(agents.name)
    .all();
}

/**
 * Sets the directories an agent's `heel run` may use (D8b). An empty list
 * means the agent can't run commands at all. Each root:
 *
 * - must exist, and is stored resolved (symlinks followed), so a later swap
 *   of the path is caught when a command runs;
 * - can't be `/`, `/var`, `/home` or `/tmp` themselves, or sit inside a
 *   system directory (`/usr`, `/etc`, `/proc`, ...);
 * - can't overlap heel's own state (`protectedPaths`, e.g. its home) or a
 *   root of another owner's agent, since the root is writable in the sandbox.
 *
 * A root and its parents must not be writable by the agent's own OS user,
 * or it could rename them between heel's check and the sandbox's mount.
 */
export function setWorkRoots(
  db: HeelDb,
  orgId: string,
  name: string,
  roots: readonly string[],
  protectedPaths: readonly string[] = [],
): { name: string; workRoots: string[] } {
  const guarded = protectedPaths.map((p) => realOrSelf(p));
  const normalized = roots.map((root) => {
    const refuse = (why: string) =>
      new AgentError("invalid_name", `not a usable work root: ${root} (${why})`);
    if (!isAbsolute(root) || resolve(root) !== root.replace(/(.)\/$/, "$1")) {
      throw refuse("an absolute, normalized path");
    }
    let real: string;
    try {
      real = realpathSync(resolve(root));
    } catch {
      throw refuse("it doesn't exist");
    }
    if (EXACT_SYSTEM_DIRS.has(real) || SYSTEM_TREES.some((dir) => within(real, dir))) {
      throw refuse("a system directory");
    }
    if (guarded.some((p) => overlaps(real, p))) throw refuse("it overlaps heel's own files");
    return real;
  });
  return db.transaction((tx) => {
    const agent = requireLiveAgent(tx, orgId, name);
    const others = tx
      .select({ ownerId: agents.ownerId, workRoots: agents.workRoots })
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .all()
      .filter((a) => a.ownerId !== agent.ownerId)
      .flatMap((a) => a.workRoots);
    for (const root of normalized) {
      if (others.some((other) => overlaps(root, other))) {
        throw new AgentError(
          "invalid_name",
          `not a usable work root: ${root} (it overlaps another owner's agent)`,
        );
      }
    }
    tx.update(agents).set({ workRoots: normalized }).where(eq(agents.id, agent.id)).run();
    return { name, workRoots: normalized };
  });
}

/** Directories that can never be a work root themselves: the agent would see too much. */
const EXACT_SYSTEM_DIRS = new Set([
  "/",
  "/var",
  "/home",
  "/tmp",
  "/private",
  "/private/var",
  "/private/tmp",
]);
/** Directories nothing inside of can be a work root. */
const SYSTEM_TREES = [
  "/usr",
  "/etc",
  "/private/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/root",
  "/run",
];

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `heel agent workdir <name>`: the agent's work roots, as stored (resolved). */
export function workRootsByName(
  db: HeelDb,
  orgId: string,
  name: string,
): { name: string; workRoots: string[] } {
  const agent = findAgent(db, orgId, name);
  if (!agent) throw new AgentError("not_found", `no agent named "${name}"`);
  return { name, workRoots: agent.workRoots };
}

/** An agent's work roots (D8b); empty for an unknown agent. */
export function workRootsOf(db: HeelDb, agentId: string): string[] {
  const row = db
    .select({ workRoots: agents.workRoots })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return row?.workRoots ?? [];
}
