/**
 * The egress relay, run by Node inside the sandbox (spec: CLI runner,
 * "Network"). The sandbox's network namespace has only loopback, and CLIs
 * expect an HTTP proxy on a TCP port, not a Unix socket. The relay listens on
 * `127.0.0.1:<port>` in that namespace, pipes every connection to heel's
 * egress proxy through the bind-mounted socket, then runs the real command
 * and exits with its status.
 *
 * Only this file is mounted into the sandbox, so it imports nothing but Node
 * built-ins. It decides nothing: the allowlist lives in the host-side proxy,
 * out of the sandboxed program's reach.
 *
 *   node relay.ts --socket /heel/run/egress.sock --port 3128 -- <binary> [args…]
 */
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { constants } from "node:os";

export interface RelayArgs {
  readonly socket: string;
  readonly port: number;
  readonly command: readonly [string, ...string[]];
}

/** Exit status when the relay itself can't start (EX_SOFTWARE, as for other heel errors). */
export const RELAY_FAILURE_EXIT = 70;

export function parseRelayArgs(argv: readonly string[]): RelayArgs | undefined {
  const dash = argv.indexOf("--");
  if (dash === -1) return undefined;
  const options = argv.slice(0, dash);
  const command = argv.slice(dash + 1);
  if (options.length !== 4 || options[0] !== "--socket" || options[2] !== "--port")
    return undefined;
  const socket = options[1];
  const port = Number(options[3]);
  const [binary, ...args] = command;
  if (socket === undefined || !socket.startsWith("/")) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (binary === undefined || !binary.startsWith("/")) return undefined;
  return { socket, port, command: [binary, ...args] };
}

/** The exit status a shell would report for a child that ended this way. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : constants.signals[signal];
  return number === undefined ? RELAY_FAILURE_EXIT : 128 + number;
}

function fail(message: string): never {
  process.stderr.write(`heel-relay: ${message}\n`);
  process.exit(RELAY_FAILURE_EXIT);
}

function main(): void {
  const parsed = parseRelayArgs(process.argv.slice(2));
  if (parsed === undefined) fail("usage: relay.ts --socket <path> --port <n> -- <binary> [args…]");
  const { socket, port, command } = parsed;

  const server = createServer((client) => {
    const upstream = connect(socket);
    client.pipe(upstream);
    upstream.pipe(client);
    // Either side closing ends the pair; the program sees a closed connection.
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.on("error", (error) => fail(`can't listen on 127.0.0.1:${port}: ${error.message}`));
  server.listen(port, "127.0.0.1", () => {
    const [binary, ...args] = command;
    const child = spawn(binary, args, { stdio: "inherit" });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(signal, () => child.kill(signal));
    }
    child.on("error", (error) => fail(`can't run ${binary}: ${error.message}`));
    child.on("exit", (code, signal) => {
      server.close();
      process.exit(exitStatus(code, signal));
    });
  });
}

if (import.meta.main) main();
