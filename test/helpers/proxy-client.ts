import { connect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

/**
 * A sandboxed client's view of heel's egress proxy, for tests: CONNECT
 * through its socket, TLS inside the tunnel, raw HTTP/1.1 on top.
 */

/** Opens a CONNECT tunnel through the proxy socket; resolves with the status line and the socket. */
export async function tunnel(
  socketPath: string,
  target: string,
): Promise<{ status: string; socket: Socket }> {
  const socket = connect(socketPath);
  const status = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    socket.once("error", reject);
    socket.once("close", () => resolve(buffered.split("\r\n")[0] ?? ""));
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end !== -1) {
        socket.off("data", onData);
        resolve(buffered.slice(0, end).split("\r\n")[0] ?? "");
      }
    };
    socket.on("data", onData);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
  return { status, socket };
}

export function secure(
  socket: Socket,
  ca: string,
  alpn: string[] = ["http/1.1"],
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, host: "127.0.0.1", ca, ALPNProtocols: alpn }, () =>
      resolve(tls),
    );
    tls.once("error", reject);
  });
}

/** Sends raw bytes and reads until the server closes; `Connection: close` requests end that way. */
export function exchange(
  tls: TLSSocket,
  raw: string | Buffer,
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    tls.on("data", (chunk: Buffer) => chunks.push(chunk));
    tls.once("error", reject);
    tls.once("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const end = text.indexOf("\r\n\r\n");
      const head = end === -1 ? text : text.slice(0, end);
      resolve({
        status: Number(head.split(" ")[1]),
        head,
        body: end === -1 ? "" : text.slice(end + 4),
      });
    });
    tls.write(raw);
  });
}

/** A request with `Content-Length` and `Connection: close`; `{target}` in a line is replaced. */
export function request(target: string, lines: string[], body = ""): string {
  return [
    ...lines.map((l) => l.replace("{target}", target)),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}
