import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Logger } from "../log.ts";
import { hasErrnoCode } from "../util/errno.ts";
import {
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_MAX_REQUEST_BYTES,
  type AdminRequest,
  type AdminResponse,
  adminError,
  encodeAdminLine,
  parseAdminRequest,
} from "./protocol.ts";

/** The socket's permission bits: owner read/write, nobody else (spec: Architecture). */
export const ADMIN_SOCKET_MODE = 0o600;

/** Umask applied while the socket is bound, so it is never briefly wider than 0600. */
const SOCKET_UMASK = 0o177;

export type AdminHandler = (request: AdminRequest) => AdminResponse | Promise<AdminResponse>;

export interface AdminServer {
  path: string;
  close(): Promise<void>;
}

export class AdminSocketError extends Error {
  override readonly name = "AdminSocketError";
}

function ownUid(): number {
  if (typeof process.getuid !== "function") {
    throw new AdminSocketError("the admin socket needs a POSIX host");
  }
  return process.getuid();
}

/**
 * The socket's directory must be ours and not writable by anyone else;
 * otherwise another user could replace the socket file with their own.
 * A missing directory is created with mode 0700.
 */
function prepareSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new AdminSocketError(`${dir} is not a directory`);
  if (stat.uid !== ownUid()) {
    throw new AdminSocketError(`${dir} must be owned by the user running heel (uid ${ownUid()})`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new AdminSocketError(`${dir} must not be group- or world-writable`);
  }
}

/** Resolves true when something accepts connections on `path`. */
function isLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error) => {
      if (hasErrnoCode(error, "ECONNREFUSED") || hasErrnoCode(error, "ENOENT")) resolve(false);
      else reject(error);
    });
  });
}

/**
 * A socket left by a crashed heel is removed; a live one means another
 * `heel serve` owns it, and anything that is not a socket is never deleted.
 */
async function clearStaleSocket(path: string): Promise<void> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new AdminSocketError(`${path} exists and is not a socket; refusing to replace it`);
  }
  if (await isLive(path)) {
    throw new AdminSocketError(`another heel is already listening on ${path}`);
  }
  unlinkSync(path);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const previous = process.umask(SOCKET_UMASK);
    try {
      server.once("error", reject);
      // For a Unix socket the bind happens synchronously inside listen(),
      // so the umask covers it and can be restored straight after.
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(previous);
    }
  });
}

/** Re-asserts and verifies the socket's owner and mode after binding. */
function lockDownSocket(path: string): void {
  chmodSync(path, ADMIN_SOCKET_MODE);
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== ownUid() || (stat.mode & 0o777) !== ADMIN_SOCKET_MODE) {
    throw new AdminSocketError(`could not secure ${path} as a mode 0600 socket`);
  }
}

/**
 * Serves one request per connection. Request params are never logged: they
 * may hold a credential for `heel connect`.
 */
function serveConnection(socket: Socket, handle: AdminHandler, log: Logger): void {
  const chunks: Buffer[] = [];
  let received = 0;
  let answered = false;

  const reply = (response: AdminResponse): void => {
    if (answered) return;
    answered = true;
    socket.end(encodeAdminLine(response));
  };

  socket.setTimeout(ADMIN_IDLE_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", (error) => log.debug({ err: error }, "admin connection error"));
  socket.on("data", (chunk: Buffer) => {
    if (answered) return;
    const newline = chunk.indexOf(0x0a);
    const take = newline === -1 ? chunk : chunk.subarray(0, newline);
    received += take.length;
    if (received > ADMIN_MAX_REQUEST_BYTES) {
      reply(adminError("bad_request", "the request is too large"));
      return;
    }
    chunks.push(take);
    if (newline === -1) return;
    socket.pause();
    const parsed = parseAdminRequest(Buffer.concat(chunks).toString("utf8"));
    if (!parsed.ok) {
      reply(parsed.response);
      return;
    }
    const { method } = parsed.request;
    Promise.resolve()
      .then(() => handle(parsed.request))
      .then(
        (response) => {
          log.info({ method, ok: response.ok }, "admin request");
          reply(response);
        },
        (error: unknown) => {
          log.error({ err: error, method }, "admin request failed");
          reply(adminError("internal", "heel could not complete the request; see the server log"));
        },
      );
  });
}

/**
 * Binds the admin socket at `path` with mode 0600 inside a directory only
 * heel can write. Connections from other users are refused by the kernel
 * when they try to open the socket file.
 */
export async function startAdminServer(options: {
  path: string;
  handle: AdminHandler;
  log: Logger;
}): Promise<AdminServer> {
  const { path, handle, log } = options;
  prepareSocketDir(dirname(path));
  await clearStaleSocket(path);
  const server = createServer((socket) => serveConnection(socket, handle, log));
  await listen(server, path);
  try {
    lockDownSocket(path);
  } catch (error) {
    server.close();
    throw error;
  }
  log.info({ path }, "admin socket listening");
  return {
    path,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
