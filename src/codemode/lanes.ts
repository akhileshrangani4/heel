import { totalmem } from "node:os";
import { CodemodeHost, type CodemodeHostOptions, HostedCodeWorker } from "./hosted.ts";
import type { StubModule } from "./stubs.ts";
import type { CodeWorker, ScriptLimits, Step } from "./worker.ts";

/**
 * One code-mode helper per agent, with a cap on how many run at once.
 *
 * One helper for every agent would mean a script that broke out of Monty
 * and WebAssembly could see other agents' scripts. One helper per agent
 * forever would cost a Node process per agent. Lanes sit between:
 *
 * - A lane is one helper process (`CodemodeHost`), bound to one agent while
 *   that agent has scripts running. An agent's scripts all run on its lane,
 *   side by side. Two agents never share a process.
 * - At most `maxLanes` run at once. An agent without a lane takes a free
 *   one; when none is free, its script waits for the first lane to come
 *   free, in the order agents asked.
 * - A lane with nothing running stays bound to its agent for `idleMs`, so
 *   the agent's next script starts at once, then it closes. A lane is never
 *   handed to another agent: the helper process ends with the lane.
 * - One spare helper is kept started and unused, so an agent's first script
 *   doesn't wait for a process to start.
 *
 * Memory is then about `maxLanes + 1` Node processes at most (about 60 MB
 * each, plus about 60 MB per script running), whatever the number of agents.
 */

export interface CodemodeLanesOptions extends CodemodeHostOptions {
  /** Helpers running at once, not counting the spare. */
  maxLanes?: number;
  /** How long a lane with nothing running stays with its agent. */
  idleMs?: number;
  /** Makes a helper; tests pass a stand-in. */
  makeHost?: (options: CodemodeHostOptions) => CodemodeHost;
}

/** One lane per 2 GB of memory, between 2 and 8. */
export function defaultLanes(memory = totalmem()): number {
  return Math.max(2, Math.min(8, Math.floor(memory / 2 ** 31)));
}

const DEFAULT_IDLE_MS = 60_000;

interface Lane {
  agentId: string;
  host: CodemodeHost;
  /** Scripts running on it. */
  running: number;
  idle: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  agentId: string;
  take: (lane: Lane | null) => void;
}

export class CodemodeLanes {
  readonly #options: CodemodeHostOptions;
  readonly #maxLanes: number;
  readonly #idleMs: number;
  readonly #makeHost: (options: CodemodeHostOptions) => CodemodeHost;
  readonly #lanes = new Map<string, Lane>();
  readonly #waiting: Waiter[] = [];
  #spare: CodemodeHost | null = null;
  #closed = false;

  constructor(options: CodemodeLanesOptions) {
    const { maxLanes, idleMs, makeHost, ...host } = options;
    this.#options = host;
    this.#maxLanes = Math.max(1, maxLanes ?? defaultLanes());
    this.#idleMs = idleMs ?? DEFAULT_IDLE_MS;
    this.#makeHost = makeHost ?? ((o) => new CodemodeHost(o));
  }

  /** A script for this agent, on the agent's lane. */
  worker(agentId: string): CodeWorker {
    return new LaneWorker(this, agentId);
  }

  /** Lanes running now, by agent (for status and tests). */
  agents(): string[] {
    return [...this.#lanes.keys()];
  }

  /** How many scripts are waiting for a lane. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * A lane for this agent with one more script counted on it, or null once
   * closed or when the wait is called off. Waits while every lane is busy
   * with other agents' scripts.
   */
  acquire(agentId: string): { lane: Promise<Lane | null>; cancel: () => void } {
    const now = this.#take(agentId);
    if (now !== undefined) return { lane: Promise.resolve(now), cancel: () => {} };
    let waiter: Waiter | null = null;
    const lane = new Promise<Lane | null>((take) => {
      waiter = { agentId, take };
      this.#waiting.push(waiter);
    });
    const cancel = () => {
      const at = waiter === null ? -1 : this.#waiting.indexOf(waiter);
      if (at < 0) return;
      this.#waiting.splice(at, 1);
      waiter?.take(null);
    };
    return { lane, cancel };
  }

  /**
   * The lane this agent can use now, counted, or undefined when it must
   * wait; null once closed.
   */
  #take(agentId: string): Lane | null | undefined {
    if (this.#closed) return null;
    const own = this.#lanes.get(agentId);
    if (own !== undefined) return this.#use(own);
    if (this.#lanes.size >= this.#maxLanes) {
      // A lane another agent left idle can go now, rather than make this script wait.
      const idle = [...this.#lanes.values()].find((lane) => lane.running === 0);
      if (idle === undefined) return undefined;
      this.#retire(idle);
    }
    const host = this.#spare ?? this.#makeHost(this.#options);
    this.#spare = null;
    const lane: Lane = { agentId, host, running: 0, idle: null };
    this.#lanes.set(agentId, lane);
    this.#refillSpare();
    return this.#use(lane);
  }

  #use(lane: Lane): Lane {
    if (lane.idle !== null) clearTimeout(lane.idle);
    lane.idle = null;
    lane.running += 1;
    return lane;
  }

  /** One script on this lane ended; its worker is already gone. */
  release(lane: Lane): void {
    lane.running -= 1;
    if (lane.running > 0 || this.#lanes.get(lane.agentId) !== lane) return;
    // Someone else is waiting and no lane is free: this one goes now so theirs can start.
    if (this.#serveWaiters()) return;
    lane.idle = setTimeout(() => {
      this.#retire(lane);
      this.#serveWaiters();
    }, this.#idleMs);
    lane.idle.unref?.();
  }

  /** Hands lanes to waiting scripts, in order, while any can start. True if one did. */
  #serveWaiters(): boolean {
    let served = false;
    while (this.#waiting.length > 0) {
      const next = this.#waiting[0];
      if (next === undefined) break;
      const lane = this.#take(next.agentId);
      if (lane === undefined) break;
      this.#waiting.shift();
      next.take(lane);
      served = true;
    }
    return served;
  }

  /** Ends a lane's helper for good. */
  #retire(lane: Lane): void {
    if (lane.idle !== null) clearTimeout(lane.idle);
    this.#lanes.delete(lane.agentId);
    void lane.host.close();
  }

  #refillSpare(): void {
    if (this.#closed || this.#spare !== null) return;
    this.#spare = this.#makeHost(this.#options);
    this.#spare.warm();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter.take(null);
    const hosts = [...this.#lanes.values()].map((lane) => {
      if (lane.idle !== null) clearTimeout(lane.idle);
      return lane.host;
    });
    this.#lanes.clear();
    if (this.#spare !== null) hosts.push(this.#spare);
    this.#spare = null;
    await Promise.all(hosts.map((host) => host.close()));
  }
}

/** One script: waits for its agent's lane, runs on it, and gives it back when stopped. */
class LaneWorker implements CodeWorker {
  readonly #lanes: CodemodeLanes;
  readonly #agentId: string;
  #inner: HostedCodeWorker | null = null;
  #lane: Lane | null = null;
  #cancel: (() => void) | null = null;
  #stopped = false;
  #stopping: Promise<void> | null = null;

  constructor(lanes: CodemodeLanes, agentId: string) {
    this.#lanes = lanes;
    this.#agentId = agentId;
  }

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
  ): Promise<Step> {
    if (this.#stopped) return { kind: "failed", error: "the script was stopped" };
    const { lane, cancel } = this.#lanes.acquire(this.#agentId);
    this.#cancel = cancel;
    const got = await lane;
    this.#cancel = null;
    if (got === null) return { kind: "failed", error: "the script was stopped" };
    this.#lane = got;
    // Stopped while it waited: the lane it just got goes straight back.
    if (this.#stopped) {
      this.#giveBack();
      return { kind: "failed", error: "the script was stopped" };
    }
    this.#inner = new HostedCodeWorker(got.host);
    return this.#inner.start(code, modules, limits, stdout);
  }

  #giveBack(): void {
    const lane = this.#lane;
    this.#lane = null;
    if (lane !== null) this.#lanes.release(lane);
  }

  stop(): Promise<void> {
    this.#stopped = true;
    this.#cancel?.();
    this.#stopping ??= (async () => {
      await this.#inner?.stop();
      this.#giveBack();
    })();
    return this.#stopping;
  }
}
