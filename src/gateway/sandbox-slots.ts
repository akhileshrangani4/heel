import { totalmem } from "node:os";

/**
 * How many sandboxes agents may have running at once: code mode's workers
 * (`run_code`) and `heel run`'s commands share one count, since each is a
 * process tree with its own memory ceiling on the same host.
 *
 * Without it, one agent sending many scripts in parallel can take the
 * host's memory until the kernel starts killing processes, and every other
 * agent's work slows down or fails with it. So each agent gets at most
 * `perAgent` at once, and all agents together at most `total`. A request
 * over either limit is refused at once, never queued: the agent reads
 * `busy` and sends it again once one of its own has finished, and nothing
 * piles up inside heel while it waits.
 */

export interface SandboxSlotLimits {
  /** Sandboxes one agent may have running at once. */
  readonly perAgent: number;
  /** Sandboxes all agents together may have running at once. */
  readonly total: number;
}

export const DEFAULT_SANDBOXES_PER_AGENT = 4;

const GIB = 1024 * 1024 * 1024;

/**
 * The default overall limit: one sandbox per GiB of the host's memory,
 * leaving one GiB for heel and the system, and between 2 and 16. The
 * sandbox's 1 GiB ceiling is per process (RLIMIT_DATA), so it doesn't bound
 * a sandbox's total; what does in practice is the script's own 256 MB
 * budget plus its idle Node worker (about 90 MB), well under 1 GiB each, so
 * this many fit in memory with room to spare.
 */
export function defaultTotalSandboxes(memoryBytes: number = totalmem()): number {
  return Math.min(16, Math.max(2, Math.floor(memoryBytes / GIB) - 1));
}

export type SlotRefusal = "agent" | "total";

export type SlotAcquisition =
  | { readonly ok: true; readonly release: () => void }
  /** `message` is what the agent reads. */
  | { readonly ok: false; readonly limit: SlotRefusal; readonly message: string };

/** What an absent limiter hands out: a slot that holds nothing back. */
export const UNLIMITED_SLOT: SlotAcquisition = { ok: true, release: () => {} };

export class SandboxSlots {
  readonly limits: SandboxSlotLimits;
  readonly #byAgent = new Map<string, number>();
  #total = 0;

  constructor(limits: SandboxSlotLimits) {
    this.limits = limits;
  }

  /**
   * Takes a slot for `agentId`, or says which limit is full. The release is
   * safe to call more than once; only the first call gives the slot back.
   */
  tryAcquire(agentId: string): SlotAcquisition {
    const held = this.#byAgent.get(agentId) ?? 0;
    if (held >= this.limits.perAgent) return this.#refuse("agent");
    if (this.#total >= this.limits.total) return this.#refuse("total");
    this.#byAgent.set(agentId, held + 1);
    this.#total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#total -= 1;
        const left = (this.#byAgent.get(agentId) ?? 1) - 1;
        if (left <= 0) this.#byAgent.delete(agentId);
        else this.#byAgent.set(agentId, left);
      },
    };
  }

  #refuse(limit: SlotRefusal): SlotAcquisition {
    const message =
      limit === "agent"
        ? `this agent already has ${this.limits.perAgent} scripts or commands running, the most heel allows at once; send this again when one has finished`
        : `heel is already running ${this.limits.total} scripts or commands for its agents, the most it allows at once; send this again shortly`;
    return { ok: false, limit, message };
  }

  /**
   * Counts a local (stdio) MCP server against `total` while it runs, without
   * ever refusing it: an account's calls need its server, so a full count
   * shouldn't break that account. Scripts and commands see the room it
   * takes, as they would another sandbox. Release once, when it stops.
   */
  holdServer(): () => void {
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
    };
  }

  /** Slots in use: `agentId`'s, or everyone's. */
  inUse(agentId?: string): number {
    return agentId === undefined ? this.#total : (this.#byAgent.get(agentId) ?? 0);
  }
}
