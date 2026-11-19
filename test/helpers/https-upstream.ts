import { createServer, type Server } from "node:https";
import type { Socket } from "node:net";
import { createSandboxCa } from "../../src/runner/ca.ts";

/** One request the fake upstream saw, as it arrived on the wire. */
export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

/**
 * An HTTPS server on 127.0.0.1 with its own CA, standing in for a credential
 * host. It records every request and reflects it back as JSON (method, url,
 * headers, body), the way a hostile or careless upstream might. A websocket
 * upgrade is answered with 101 and an echo.
 *
 * `echoCredential` makes it also put the given value in a response header
 * and the body, so the proxy's response scrub has something to find.
 */
export async function httpsUpstream(options: { echo?: () => string | undefined } = {}): Promise<{
  readonly port: number;
  /** Trust roots that verify this server. */
  readonly ca: string;
  readonly seen: SeenRequest[];
  close(): Promise<void>;
}> {
  const ca = await createSandboxCa(["127.0.0.1"]);
  const leaf = await ca.leaf("127.0.0.1");
  const seen: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer({ cert: leaf.cert, key: leaf.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method ?? "",
        url: req.url ?? "",
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(request);
      const echoed = options.echo?.();
      res.writeHead(200, {
        "content-type": "application/json",
        ...(echoed === undefined ? {} : { "x-echo": echoed }),
      });
      res.end(JSON.stringify({ ...request, ...(echoed === undefined ? {} : { echoed }) }));
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      rawHeaders: req.rawHeaders,
      body: "",
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head.length > 0) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no upstream port");
  return {
    port: address.port,
    ca: ca.certificate,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The value of `name` in raw headers, or undefined; throws when it appears more than once. */
export function headerOf(rawHeaders: readonly string[], name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name.toLowerCase()) values.push(rawHeaders[i + 1] ?? "");
  }
  if (values.length > 1) throw new Error(`${name} appears ${values.length} times`);
  return values[0];
}
