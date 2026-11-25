/** Sends a GET by calling `send`, and once more if the answer was 429 or 5xx. */
export async function getWithRetry(send: () => Promise<Response>): Promise<Response> {
  const response = await send();
  return response.status === 429 || response.status >= 500 ? send() : response;
}

/**
 * Throws if a write failed. A write is never retried, and a 5xx or a 408
 * doesn't prove nothing happened, so the outcome is unknown (a plain Error).
 * Any other non-2xx is `Refused`: the write didn't happen.
 */
export async function throwIfWriteFailed(
  response: Response,
  service: string,
  Refused: new (status: number, body: unknown) => Error,
): Promise<void> {
  if (response.status >= 500 || response.status === 408) {
    throw new Error(`${service} answered ${response.status}; the write may have happened`);
  }
  if (!response.ok) throw new Refused(response.status, await response.json().catch(() => null));
}
