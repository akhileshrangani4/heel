import { and, eq, inArray, lte } from "drizzle-orm";
import { type AuthenticatedAgent, agentStillLive } from "../gateway/agent-tokens.ts";
import type { Pipeline } from "../gateway/pipeline/pipeline.ts";
import { type SandboxSlots, UNLIMITED_SLOT } from "../gateway/sandbox-slots.ts";
import type { Logger } from "../log.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import {
  agents,
  agentTokens,
  approvals,
  type BackgroundScriptStatus,
  backgroundScripts,
} from "../store/schema.ts";
import { modulesHash, openParked, releaseParked, type Sealer, stopParked } from "./parking.ts";
import { type CallRecord, runScript, type ScriptResult } from "./run.ts";
import type { StubModule } from "./stubs.ts";
import type { CodeWorker } from "./worker.ts";

/**
 * Background code-mode scripts (code mode round 2, C6; Avi's design, Nov 22):
 *
 * - `run_code({ background: true })` starts a script and answers at once
 *   with its id; heel runs it with no request held open, up to 10 minutes
 *   of compute (time waiting in heel doesn't count) and 30 minutes in all,
 *   per segment (from a start or a resume to the next park or the end).
 * - An agent has one running or parked at a time (a unique index).
 * - A call that asks parks it (C2). When the owner approves, heel resumes it
 *   by itself: the parked call goes through the pipeline again, so the
 *   approval, rules and pauses still decide it. A denial ends the script, so
 *   no code runs because someone pressed Deny.
 * - Before each call heel checks the token that started it, its agent and
 *   owner are still good; a revoked agent's script stops at its next call.
 * - What it printed and returned is sealed with the vault's key, kept a day,
 *   and readable only by its agent (`heel_status({ script_id })`).
 * - The owner sees running and parked scripts on the Agents page and in
 *   `heel status`, and can stop them.
 */

/** Compute a background script may use, per segment between parks. */
export const BACKGROUND_MAX_SECONDS = 10 * 60;
/** Everything a segment may take, waiting in heel included. */
export const BACKGROUND_WALL_MS = 30 * 60 * 1000;
/** How long a finished script's result is kept for its agent. */
export const BACKGROUND_RESULT_MS = 24 * 60 * 60 * 1000;
/** How soon an approved script that found no free sandbox is tried again. */
const RESUME_RETRY_MS = 5_000;

export interface BackgroundDeps {
  db: HeelDb;
  sealer: Sealer;
  pipeline: Pipeline;
  codeWorker: (agentId: string) => CodeWorker;
  slots?: SandboxSlots | undefined;
  /** The modules the agent's scripts may import, as `run_code` builds them. */
  modulesFor: (agent: AuthenticatedAgent) => Promise<(StubModule & { account: string })[]>;
  log: Logger;
  now: () => Date;
}

/** What a script's sealed result holds. */
interface StoredResult {
  stdout: string;
  output?: unknown;
  calls: CallRecord[];
  error: string | null;
}

/** A background script as its agent reads it through heel_status. */
export interface BackgroundView {
  scriptId: string;
  status: BackgroundScriptStatus;
  approvalId?: string;
  stdout?: string;
  output?: unknown;
  calls?: CallRecord[];
  error?: string | null;
}

/** A running or parked script, for the owner's list. */
export interface ActiveScript {
  id: string;
  agentId: string;
  agentName: string;
  status: BackgroundScriptStatus;
  approvalId: string | null;
  calls: number;
  startedAt: Date;
}

export type StartOutcome = { ok: true; id: string } | { ok: false; message: string };

const context = (id: string, agentId: string) => `background-script:${id}:${agentId}`;

export class BackgroundRunner {
  readonly #deps: BackgroundDeps;
  /** Scripts running in this process, by id, with what stops them. */
  readonly #running = new Map<string, { worker: CodeWorker; stopped: string | null }>();
  /** Approvals whose resume is waiting for a free sandbox, retried on a timer. */
  readonly #retrying = new Set<string>();
  #closed = false;

  constructor(deps: BackgroundDeps) {
    this.#deps = deps;
  }

  /**
   * At start: scripts left running by an earlier process can't be restored,
   * so they're ended; parked ones whose approval was decided meanwhile are
   * resumed or ended, as if the decision had just been made.
   */
  recover(): void {
    const now = this.#deps.now();
    this.#deps.db
      .update(backgroundScripts)
      .set({
        status: "ended",
        updatedAt: now,
        expiresAt: new Date(now.getTime() + BACKGROUND_RESULT_MS),
      })
      .where(eq(backgroundScripts.status, "running"))
      .run();
    this.#deps.db.delete(backgroundScripts).where(lte(backgroundScripts.expiresAt, now)).run();
    const parked = this.#deps.db
      .select({ approvalId: backgroundScripts.approvalId })
      .from(backgroundScripts)
      .where(eq(backgroundScripts.status, "parked"))
      .all();
    for (const { approvalId } of parked) if (approvalId !== null) this.approvalDecided(approvalId);
  }

  /**
   * Acts on parked scripts whose approval was decided, or ran out, without the
   * decision reaching the runner: approvals expire lazily, and a resume may have
   * found no free sandbox. Called whenever scripts are started, read or listed.
   */
  #sweep(): void {
    const parked = this.#deps.db
      .select({ approvalId: backgroundScripts.approvalId })
      .from(backgroundScripts)
      .where(eq(backgroundScripts.status, "parked"))
      .all();
    for (const { approvalId } of parked) if (approvalId !== null) this.approvalDecided(approvalId);
  }

  /** Starts a script in the background, or says why not (the agent has one going, no slot). */
  start(
    agent: AuthenticatedAgent,
    script: { code: string; runId?: string | undefined; reason?: string | undefined },
  ): StartOutcome {
    if (this.#closed) return { ok: false, message: "heel is shutting down" };
    this.#sweep();
    const active = this.#activeOf(agent.agentId);
    if (active !== null) {
      return {
        ok: false,
        message: `you already have a background script ${active.status === "parked" ? "waiting for approval" : "running"} (${active.id}); follow it with heel_status, or wait for it to end`,
      };
    }
    const slot = this.#deps.slots?.tryAcquire(agent.agentId) ?? UNLIMITED_SLOT;
    if (!slot.ok) return { ok: false, message: slot.message };
    const id = newId("script");
    const now = this.#deps.now();
    try {
      this.#deps.db
        .insert(backgroundScripts)
        .values({
          id,
          orgId: agent.orgId,
          agentId: agent.agentId,
          ownerId: agent.ownerId,
          tokenId: agent.tokenId,
          status: "running",
          startedAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + BACKGROUND_WALL_MS + BACKGROUND_RESULT_MS),
        })
        .run();
    } catch {
      // Another start won the unique index between the check and here.
      slot.release();
      return {
        ok: false,
        message: "you already have a background script going; follow it with heel_status",
      };
    }
    void this.#segment(id, agent, slot.release, {
      code: script.code,
      runId: script.runId,
      reason: script.reason,
    });
    return { ok: true, id };
  }

  /**
   * Called once an approval's decision has committed. A background script
   * parked on it resumes (approved) or ends (denied, expired).
   */
  approvalDecided(approvalId: string): void {
    if (this.#closed) return;
    const row = this.#deps.db
      .select()
      .from(backgroundScripts)
      .where(
        and(eq(backgroundScripts.approvalId, approvalId), eq(backgroundScripts.status, "parked")),
      )
      .get();
    if (row === undefined || row.parkedId === null) return;
    const approval = this.#deps.db
      .select({ status: approvals.status, expiresAt: approvals.expiresAt })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .get();
    if (approval === undefined) return;
    // Approvals expire lazily: a pending one past its time is expired.
    const status =
      approval.status === "pending" && approval.expiresAt.getTime() <= this.#deps.now().getTime()
        ? "expired"
        : approval.status;
    if (status === "pending") return;
    if (status !== "approved") {
      stopParked(this.#deps.db, row.orgId, approvalId);
      this.#finish(row.id, row.agentId, "stopped", {
        stdout: "",
        calls: [],
        error:
          status === "denied"
            ? "the owner denied the call the script was waiting on"
            : "the approval the script was waiting on expired",
      });
      return;
    }
    const agent = this.#agentOf(row.tokenId);
    if (agent === null || !agentStillLive(this.#deps.db, agent, this.#deps.now())) {
      stopParked(this.#deps.db, row.orgId, approvalId);
      this.#finish(row.id, row.agentId, "stopped", {
        stdout: "",
        calls: [],
        error: "the agent's access was revoked or expired before the script could carry on",
      });
      return;
    }
    const slot = this.#deps.slots?.tryAcquire(agent.agentId) ?? UNLIMITED_SLOT;
    if (!slot.ok) {
      // No room right now: it stays parked and is tried again shortly, and on every sweep.
      this.#deps.log.warn(
        { script: row.id },
        "background script approved, but no sandbox is free to resume it",
      );
      if (!this.#retrying.has(approvalId)) {
        this.#retrying.add(approvalId);
        const retry = setTimeout(() => {
          this.#retrying.delete(approvalId);
          this.approvalDecided(approvalId);
        }, RESUME_RETRY_MS);
        retry.unref?.();
      }
      return;
    }
    const parkedId = row.parkedId;
    this.#deps.db
      .update(backgroundScripts)
      .set({ status: "running", approvalId: null, parkedId: null, updatedAt: this.#deps.now() })
      .where(eq(backgroundScripts.id, row.id))
      .run();
    void this.#segment(row.id, agent, slot.release, { parkedId });
  }

  /** Whether a background script is parked on this approval. */
  waitsOn(approvalId: string): boolean {
    return (
      this.#deps.db
        .select({ id: backgroundScripts.id })
        .from(backgroundScripts)
        .where(
          and(eq(backgroundScripts.approvalId, approvalId), eq(backgroundScripts.status, "parked")),
        )
        .get() !== undefined
    );
  }

  /** Whether a parked script id belongs to a background script (heel resumes those, not the agent). */
  isParkedBackground(parkedId: string): boolean {
    return (
      this.#deps.db
        .select({ id: backgroundScripts.id })
        .from(backgroundScripts)
        .where(eq(backgroundScripts.parkedId, parkedId))
        .get() !== undefined
    );
  }

  /** Ends the background script parked on this approval (the approval page's Stop the script). */
  stopWaitingOn(approvalId: string): void {
    const row = this.#deps.db
      .select({ id: backgroundScripts.id, orgId: backgroundScripts.orgId })
      .from(backgroundScripts)
      .where(
        and(eq(backgroundScripts.approvalId, approvalId), eq(backgroundScripts.status, "parked")),
      )
      .get();
    if (row !== undefined) this.stop(row.id, row.orgId);
  }

  /** Stops a script, running or parked (the owner's Stop, a revoke). False when it wasn't going. */
  stop(id: string, orgId: string, reason = "stopped by its owner"): boolean {
    const row = this.#deps.db
      .select()
      .from(backgroundScripts)
      .where(and(eq(backgroundScripts.id, id), eq(backgroundScripts.orgId, orgId)))
      .get();
    if (row === undefined) return false;
    const running = this.#running.get(id);
    if (running !== undefined) {
      running.stopped = reason;
      void running.worker.stop();
      return true;
    }
    if (row.status === "parked") {
      if (row.approvalId !== null) stopParked(this.#deps.db, row.orgId, row.approvalId);
      this.#finish(row.id, row.agentId, "stopped", {
        stdout: "",
        calls: [],
        error: reason,
      });
      return true;
    }
    return false;
  }

  /** Stops every script of an agent (it was revoked or its token rotated). */
  stopAgent(orgId: string, agentId: string): void {
    for (const s of this.list([agentId], "agent")) {
      this.stop(s.id, orgId, "its agent was revoked, or its token replaced");
    }
  }

  /** What the agent that started a script may read about it; null for anyone else's. */
  view(agent: AuthenticatedAgent, id: string): BackgroundView | null {
    this.#sweep();
    const row = this.#deps.db
      .select()
      .from(backgroundScripts)
      .where(and(eq(backgroundScripts.id, id), eq(backgroundScripts.agentId, agent.agentId)))
      .get();
    if (row === undefined) return null;
    const view: BackgroundView = {
      scriptId: row.id,
      status: row.status,
      ...(row.approvalId === null ? {} : { approvalId: row.approvalId }),
    };
    if (row.result === null) return view;
    try {
      const stored = JSON.parse(
        this.#deps.sealer.openBytes(context(row.id, row.agentId), row.result).toString("utf8"),
      ) as StoredResult;
      return { ...view, ...stored };
    } catch {
      return { ...view, error: "heel couldn't read this script's result" };
    }
  }

  /** Running and parked scripts of these agents or owners, for the Agents page and heel status. */
  list(ids: readonly string[] | null, by: "owner" | "agent" = "owner"): ActiveScript[] {
    if (by === "owner") this.#sweep();
    const active = inArray(backgroundScripts.status, ["running", "parked"]);
    const where =
      ids === null
        ? active
        : and(
            active,
            inArray(by === "owner" ? backgroundScripts.ownerId : backgroundScripts.agentId, [
              ...ids,
            ]),
          );
    return this.#deps.db
      .select({
        id: backgroundScripts.id,
        agentId: backgroundScripts.agentId,
        agentName: agents.name,
        status: backgroundScripts.status,
        approvalId: backgroundScripts.approvalId,
        calls: backgroundScripts.calls,
        startedAt: backgroundScripts.startedAt,
      })
      .from(backgroundScripts)
      .innerJoin(agents, eq(agents.id, backgroundScripts.agentId))
      .where(where)
      .all();
  }

  /** Stops every running script; called when heel shuts down. */
  async close(): Promise<void> {
    this.#closed = true;
    const running = [...this.#running.values()];
    for (const r of running) r.stopped = "heel shut down";
    await Promise.all(running.map((r) => r.worker.stop().catch(() => {})));
  }

  /** One segment: from a start or a resume to the end or the next park. */
  async #segment(
    id: string,
    agent: AuthenticatedAgent,
    release: () => void,
    from:
      | { code: string; runId?: string | undefined; reason?: string | undefined }
      | { parkedId: string },
  ): Promise<void> {
    const worker = this.#deps.codeWorker(agent.agentId);
    const entry: { worker: CodeWorker; stopped: string | null } = { worker, stopped: null };
    this.#running.set(id, entry);
    const wall = setTimeout(() => void worker.stop(), BACKGROUND_WALL_MS);
    let result: ScriptResult;
    try {
      const modules = await this.#deps.modulesFor(agent);
      const parking = { db: this.#deps.db, sealer: this.#deps.sealer, now: this.#deps.now };
      const common = {
        agent,
        modules,
        pipeline: this.#deps.pipeline,
        worker,
        limits: { maxSeconds: BACKGROUND_MAX_SECONDS, maxWallMs: BACKGROUND_WALL_MS },
        parking,
        scriptId: id,
        stillLive: () => agentStillLive(this.#deps.db, agent, this.#deps.now()),
      };
      if ("parkedId" in from) {
        const claimed = openParked(
          this.#deps.db,
          this.#deps.sealer,
          agent,
          from.parkedId,
          this.#deps.now(),
        );
        if (claimed === null || claimed.modulesHash !== modulesHash(modules)) {
          result = {
            status: "error",
            stdout: "",
            calls: [],
            error:
              claimed === null
                ? "the parked script was gone"
                : "the agent's accounts changed since the script parked",
          };
        } else {
          result = await runScript({
            ...common,
            code: "",
            resume: claimed,
            ...(claimed.runId === undefined ? {} : { runId: claimed.runId }),
            ...(claimed.reason === undefined ? {} : { reason: claimed.reason }),
            onRestored: () => releaseParked(this.#deps.db, agent, from.parkedId),
          });
        }
      } else {
        result = await runScript({
          ...common,
          code: from.code,
          ...(from.runId === undefined ? {} : { runId: from.runId }),
          ...(from.reason === undefined ? {} : { reason: from.reason }),
        });
      }
    } catch (error) {
      result = {
        status: "error",
        stdout: "",
        calls: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(wall);
      this.#running.delete(id);
      release();
    }
    if (entry.stopped !== null) {
      if (result.resume !== undefined)
        stopParked(this.#deps.db, agent.orgId, result.approvalId ?? "");
      this.#finish(id, agent.agentId, "stopped", {
        ...stored(result),
        error: entry.stopped,
      });
      return;
    }
    if (
      result.status === "pending" &&
      result.resume !== undefined &&
      result.approvalId !== undefined
    ) {
      const sofar = this.#merged(id, agent.agentId, stored(result));
      this.#deps.db
        .update(backgroundScripts)
        .set({
          status: "parked",
          approvalId: result.approvalId,
          parkedId: result.resume,
          calls: sofar.calls.length,
          result: this.#seal(id, agent.agentId, sofar),
          updatedAt: this.#deps.now(),
        })
        .where(eq(backgroundScripts.id, id))
        .run();
      // Decided while it was parking? Act on it now.
      this.approvalDecided(result.approvalId);
      return;
    }
    const status: BackgroundScriptStatus =
      result.status === "completed" ? "completed" : result.status === "paused" ? "paused" : "error";
    const error =
      result.status === "pending"
        ? `a call needs approval (${result.approvalId ?? "unknown"}) and the script couldn't wait for it: ${result.notParked ?? "it wasn't saved"}`
        : result.error;
    this.#finish(id, agent.agentId, status, { ...stored(result), error });
  }

  /**
   * What the script has produced so far: what earlier segments stored, then
   * this one's, so a script that parked keeps its earlier output and calls. A
   * resumed segment makes the parked call again, so the earlier record of that
   * call (the last one, still waiting then) gives way to the new one.
   */
  #merged(id: string, agentId: string, latest: StoredResult): StoredResult {
    const row = this.#deps.db
      .select({ result: backgroundScripts.result })
      .from(backgroundScripts)
      .where(eq(backgroundScripts.id, id))
      .get();
    if (row?.result == null) return latest;
    let earlier: StoredResult;
    try {
      earlier = JSON.parse(
        this.#deps.sealer.openBytes(context(id, agentId), row.result).toString("utf8"),
      ) as StoredResult;
    } catch {
      return latest;
    }
    return {
      stdout: earlier.stdout + latest.stdout,
      ...(latest.output === undefined ? {} : { output: latest.output }),
      calls: [
        ...(latest.calls.length > 0 ? earlier.calls.slice(0, -1) : earlier.calls),
        ...latest.calls,
      ],
      error: latest.error,
    };
  }

  #finish(id: string, agentId: string, status: BackgroundScriptStatus, latest: StoredResult): void {
    const now = this.#deps.now();
    const result = this.#merged(id, agentId, latest);
    this.#deps.db
      .update(backgroundScripts)
      .set({
        status,
        approvalId: null,
        parkedId: null,
        calls: result.calls.length,
        result: this.#seal(id, agentId, result),
        updatedAt: now,
        expiresAt: new Date(now.getTime() + BACKGROUND_RESULT_MS),
      })
      .where(eq(backgroundScripts.id, id))
      .run();
  }

  #seal(id: string, agentId: string, result: StoredResult): Buffer {
    return this.#deps.sealer.sealBytes(
      context(id, agentId),
      Buffer.from(JSON.stringify(result), "utf8"),
    );
  }

  #activeOf(agentId: string): { id: string; status: BackgroundScriptStatus } | null {
    return (
      this.#deps.db
        .select({ id: backgroundScripts.id, status: backgroundScripts.status })
        .from(backgroundScripts)
        .where(
          and(
            eq(backgroundScripts.agentId, agentId),
            inArray(backgroundScripts.status, ["running", "parked"]),
          ),
        )
        .get() ?? null
    );
  }

  /** The agent a stored token belongs to, rebuilt from the database for a resume. */
  #agentOf(tokenId: string): AuthenticatedAgent | null {
    const row = this.#deps.db
      .select({
        orgId: agents.orgId,
        agentId: agents.id,
        agentName: agents.name,
        ownerId: agents.ownerId,
        clientName: agentTokens.clientName,
      })
      .from(agentTokens)
      .innerJoin(agents, eq(agents.id, agentTokens.agentId))
      .where(eq(agentTokens.id, tokenId))
      .get();
    return row === undefined ? null : { ...row, tokenId };
  }
}

function stored(result: ScriptResult): StoredResult {
  return {
    stdout: result.stdout,
    ...(result.output === undefined ? {} : { output: result.output }),
    calls: result.calls,
    error: result.error,
  };
}
