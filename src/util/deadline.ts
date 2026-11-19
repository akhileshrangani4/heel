/** A step outlived its deadline; the caller treats its outcome as unknown. */
export class DeadlineExceededError extends Error {
  readonly ms: number;

  constructor(ms: number) {
    super(`deadline of ${ms} ms exceeded`);
    this.name = "DeadlineExceededError";
    this.ms = ms;
  }
}

/**
 * Runs `work` with an abort signal and rejects with `DeadlineExceededError`
 * after `ms`, whether or not `work` honours the signal. A result that arrives
 * after the deadline is ignored: the caller has already acted on the timeout.
 * `Promise.race` subscribes to `work`'s promise, so a late rejection is
 * handled there instead of surfacing as an unhandled rejection.
 */
export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  /** Also stop when this aborts: the request that asked for the work went away. */
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  // The request went away: tell the work, and stop waiting for it, so whatever
  // the caller holds for it (a sandbox slot) is let go even if the work is slow to notice.
  const gone = new Promise<never>((_, reject) => {
    if (outer === undefined) return;
    const stop = () => {
      controller.abort(outer.reason);
      reject(outer.reason ?? new Error("aborted"));
    };
    if (outer.aborted) stop();
    else outer.addEventListener("abort", stop, { once: true });
  });
  gone.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceededError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired, gone]);
  } finally {
    clearTimeout(timer);
  }
}
