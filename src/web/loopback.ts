import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The loopback redirects for heel's built-in Google client (roadmap 1.14).
 * A desktop OAuth client can only send people back to
 * `http://127.0.0.1:<port>`, so each sign-in gets a short-lived listener on
 * heel's host, on a random port.
 *
 * The listener is deliberately dumb. It never finishes a sign-in itself: it
 * forwards `code`, `state` and `error` to heel's own callback route on the
 * approval page, which checks the session and that the person finishing is
 * the one who started. It never echoes anything from the request.
 *
 * When the browser isn't on heel's host (heel on a server, or in Docker),
 * the redirect can't load; the person pastes that address on the Connections
 * page instead, and it ends up at the same callback route.
 */

const LISTENER_TTL_MS = 10 * 60 * 1000;
/** The query keys passed on; anything else Google adds is dropped. */
const FORWARDED = ["code", "state", "error"] as const;

interface Listener {
  server: Server;
  timer: NodeJS.Timeout;
}

export class LoopbackRedirects {
  readonly #byAccount = new Map<string, Listener>();
  readonly #callback: URL;

  /** `callback`: heel's own route that finishes the sign-in, on `public_url`. */
  constructor(callback: URL) {
    this.#callback = callback;
  }

  /**
   * Starts a listener for one account's sign-in, closing any earlier one for
   * that account, and returns its exact redirect URI.
   */
  async open(accountId: string): Promise<string> {
    this.close(accountId);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const headers = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-type": "text/plain; charset=utf-8",
      };
      if (request.method !== "GET" || url.pathname !== "/") {
        response.writeHead(404, headers).end("Not found.");
        return;
      }
      const target = new URL(this.#callback);
      for (const key of FORWARDED) {
        const value = url.searchParams.get(key);
        if (value !== null) target.searchParams.set(key, value);
      }
      response.writeHead(302, { ...headers, location: target.toString() }).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const timer = setTimeout(() => this.close(accountId), LISTENER_TTL_MS);
    timer.unref();
    this.#byAccount.set(accountId, { server, timer });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Stops an account's listener, once its sign-in finished or failed. */
  close(accountId: string): void {
    const listener = this.#byAccount.get(accountId);
    if (listener === undefined) return;
    this.#byAccount.delete(accountId);
    clearTimeout(listener.timer);
    listener.server.close();
    listener.server.closeAllConnections();
  }

  /** Stops every listener, when heel shuts down. */
  closeAll(): void {
    for (const accountId of [...this.#byAccount.keys()]) this.close(accountId);
  }
}
