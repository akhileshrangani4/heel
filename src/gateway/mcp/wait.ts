/**
 * Holding a call open until its person decides (roadmap 2.11).
 *
 * A call that needs approval used to answer `pending` at once, and the agent
 * had to be told to check again after the passkey tap. Now heel keeps the
 * request open, checking the decision every `pollMs`, and answers as soon as
 * it's made. A call no one decides within the window answers `pending` as
 * before, so a slow decision never leaves the agent hanging.
 *
 * While it waits, heel sends a notification every `beatMs`: a progress
 * notification when the client asked for progress, otherwise a log line.
 * The first one turns the response into an event stream, whose keep-alives
 * keep tunnels (Cloudflare closes an HTTP response with no bytes for 100 s)
 * and the client's idle timeout from closing it.
 */

export interface ApprovalWait {
  /** How long to hold a call for this client (its `clientInfo.name`); 0 doesn't hold. */
  windowMs: (clientName: string | null) => number;
  /** How often to look at the decision. */
  pollMs: number;
  /** How often to tell the client heel is still waiting. */
  beatMs: number;
}

/**
 * Codex gives up on a tool call after 60 seconds unless `tool_timeout_sec`
 * is raised; Claude Code allows long calls but closes a remote one that
 * sends nothing for 5 minutes. So: under a minute for Codex, four for the rest.
 */
export const CODEX_WAIT_MS = 50_000;
export const DEFAULT_WAIT_MS = 240_000;

export const DEFAULT_APPROVAL_WAIT: ApprovalWait = {
  windowMs: (clientName) =>
    clientName !== null && /codex/i.test(clientName) ? CODEX_WAIT_MS : DEFAULT_WAIT_MS,
  pollMs: 1_000,
  beatMs: 20_000,
};

/** Doesn't hold: answers at once, as heel did before 2.11. */
export const NO_APPROVAL_WAIT: ApprovalWait = { windowMs: () => 0, pollMs: 1_000, beatMs: 20_000 };

/** Tells the client heel is still waiting; `elapsedMs` since the wait began. */
export type Beat = (elapsedMs: number) => Promise<void>;

/**
 * Resolves true once `decided()` is true, false when the window ends or the
 * client goes away first. `decided` is checked before the first sleep, so a
 * decision already made answers at once.
 */
export async function waitFor(
  decided: () => boolean,
  options: { windowMs: number; pollMs: number; beatMs: number; signal: AbortSignal; beat?: Beat },
): Promise<boolean> {
  const started = Date.now();
  let nextBeat = 0;
  for (;;) {
    if (decided()) return true;
    const elapsed = Date.now() - started;
    if (options.signal.aborted || elapsed >= options.windowMs) return false;
    if (options.beat !== undefined && elapsed >= nextBeat) {
      nextBeat = elapsed + options.beatMs;
      // A client that can't take the notification still gets its answer.
      await options.beat(elapsed).catch(() => {});
    }
    await sleep(Math.min(options.pollMs, options.windowMs - elapsed), options.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
