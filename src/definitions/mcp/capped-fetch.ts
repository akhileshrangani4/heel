import type { FetchLike } from "@modelcontextprotocol/client";
import { MAX_MESSAGE_BYTES, MessageTooLargeError } from "./sandbox-transport.ts";

/**
 * A fetch for a remote MCP server that won't read more than `maxBytes` of
 * one message, as local ones stop at MAX_MESSAGE_BYTES. A JSON reply is one message. An event
 * stream stays open for many messages, so the limit applies to each event
 * (the bytes since the last blank line), not to the stream's lifetime.
 *
 * Past the limit the body errors with MessageTooLargeError and `failure`
 * remembers it, so the pool can tell the agent heel withheld the reply.
 */
export interface CappedFetch {
  fetch: FetchLike;
  failure: MessageTooLargeError | null;
  /**
   * Called when a reply runs past the limit. The pool closes the connection
   * here, as a local server is stopped: otherwise the request waiting on the
   * stream would wait until its deadline.
   */
  onExceeded?: () => void;
}

export function cappedFetch(
  inner: FetchLike = fetch,
  maxBytes: number = MAX_MESSAGE_BYTES,
): CappedFetch {
  const state: CappedFetch = {
    failure: null,
    fetch: async (input, init) => {
      const response = await inner(input, init);
      if (response.body === null) return response;
      const stream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      const limited = response.body.pipeThrough(byteLimit(maxBytes, stream, state));
      return new Response(limited, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
  return state;
}

/** Counts bytes, resetting at each event boundary for a stream, and errors past `maxBytes`. */
function byteLimit(
  maxBytes: number,
  eventStream: boolean,
  state: CappedFetch,
): TransformStream<Uint8Array, Uint8Array> {
  let count = 0;
  // The two bytes before this chunk, so a boundary split across chunks is still seen.
  let prev1 = -1;
  let prev2 = -1;
  return new TransformStream({
    transform(chunk, controller) {
      if (eventStream) {
        // Count byte by byte: an event ends at a blank line (\n\n or \n\r\n).
        for (const byte of chunk) {
          count++;
          if (byte === 0x0a && (prev1 === 0x0a || (prev1 === 0x0d && prev2 === 0x0a))) count = 0;
          prev2 = prev1;
          prev1 = byte;
          if (count > maxBytes) break;
        }
      } else {
        count += chunk.length;
      }
      if (count > maxBytes) {
        const error = new MessageTooLargeError(maxBytes);
        state.failure = error;
        controller.error(error);
        state.onExceeded?.();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
