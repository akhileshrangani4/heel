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
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceededError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}
