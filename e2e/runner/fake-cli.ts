/**
 * A stand-in CLI for the sandbox e2e tests. The tests run it with heel's own
 * Node under bubblewrap, and it reports what a sandboxed program can see and
 * do as one JSON line on stdout.
 *
 * Only this file is mounted into the sandbox, so it imports nothing but Node
 * built-ins. Checks that involve the credential run here and report a boolean
 * or a hash: the value itself must never need to cross the output to be
 * checked, because the output is exactly what the agent gets.
 *
 *   node fake-cli.ts inspect <credential-var> [path…]
 *   node fake-cli.ts args [arg…]
 *   node fake-cli.ts overwrite <path…>
 *   node fake-cli.ts via-proxy <host:port>
 *   node fake-cli.ts direct <host> <port>
 *   node fake-cli.ts print-env <var>
 *   node fake-cli.ts sleep <ms> [marker]
 *   node fake-cli.ts spew <bytes>
 *   node fake-cli.ts spawn <count>
 *   node fake-cli.ts alloc <mebibytes>
 *   node fake-cli.ts hunt <credential-var> <host:port> <out-file>
 *   node fake-cli.ts npm-like <host:port> <out-file>
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

type Report = Record<string, unknown>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : String(error);
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every process this sandbox can see, with whether its command line carries the credential. */
function processes(credential: string | undefined): Report[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map((pid) => {
      const cmdline = (readOrUndefined(`/proc/${pid}/cmdline`) ?? "").split("\0").filter(Boolean);
      return {
        pid: Number(pid),
        cmdline,
        cmdlineHasCredential:
          credential !== undefined && credential !== "" && cmdline.join(" ").includes(credential),
      };
    });
}

function inspect(credentialVar: string, paths: readonly string[]): Report {
  const credential = process.env[credentialVar];
  return {
    env: process.env,
    cwd: process.cwd(),
    uid: process.getuid?.(),
    stdin: readlinkSync("/proc/self/fd/0"),
    credentialSha256: credential === undefined ? null : sha256(credential),
    processes: processes(credential),
    paths: Object.fromEntries(paths.map((path) => [path, existsSync(path)])),
  };
}

function overwrite(paths: readonly string[]): Report {
  return Object.fromEntries(
    paths.map((path) => {
      try {
        writeFileSync(path, "swapped by the agent\n");
        return [path, "written"];
      } catch (error) {
        return [path, errorCode(error)];
      }
    }),
  );
}

/** Opens a CONNECT tunnel through the proxy in HTTPS_PROXY and, if it opens, echoes one line. */
async function viaProxy(target: string): Promise<Report> {
  const proxy = new URL(process.env["HTTPS_PROXY"] ?? "http://127.0.0.1:1");
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    const status = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("latin1");
        const end = buffered.indexOf("\r\n\r\n");
        if (end !== -1) {
          socket.removeAllListeners("data");
          resolve(buffered.slice(0, end).split("\r\n")[0] ?? "");
        }
      });
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    if (!status.includes(" 200 ")) return { status };
    return { status, echoed: await echo(socket, "ping\n") };
  } catch (error) {
    return { status: null, error: errorCode(error) };
  } finally {
    socket.destroy();
  }
}

function echo(socket: Socket, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    socket.write(line);
  });
}

/** A plain TCP connection that ignores the proxy. */
function direct(host: string, port: number): Promise<Report> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ result: "connected" });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ result: "timeout" });
    });
    socket.once("error", (error) => resolve({ result: errorCode(error) }));
  });
}

/** Writes the value in two pieces on each stream, so it straddles a chunk boundary. */
async function printEnv(name: string): Promise<void> {
  const value = process.env[name] ?? "";
  const half = Math.floor(value.length / 2);
  for (const stream of [process.stdout, process.stderr]) {
    stream.write(`before ${value.slice(0, half)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stream.write(`${value.slice(half)} after\n`);
  }
}

/** Starts `count` sleeping children and reports how many the process limit let through. */
async function spawnMany(count: number): Promise<Report> {
  const started: ReturnType<typeof spawn>[] = [];
  const failures: string[] = [];
  for (let i = 0; i < count; i++) {
    const outcome = await new Promise<string>((resolve) => {
      const child = spawn("/usr/bin/sleep", ["30"], { stdio: "ignore" });
      child.once("spawn", () => {
        started.push(child);
        resolve("ok");
      });
      child.once("error", (error) => resolve(errorCode(error)));
    });
    if (outcome !== "ok") failures.push(outcome);
  }
  for (const child of started) child.kill("SIGKILL");
  return { started: started.length, failures };
}

/** Allocates and touches a buffer, so the memory limit has to let every page through. */
function alloc(mebibytes: number): Report {
  try {
    const buffer = Buffer.alloc(mebibytes * 1024 * 1024, 1);
    return { result: "allocated", bytes: buffer.length };
  } catch (error) {
    return { result: error instanceof Error ? error.name : String(error) };
  }
}

/** Every regular file under `dir` this program can read, path to text, a few levels deep. */
function readTree(dir: string, depth: number, into: Record<string, string>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    into[`${dir}/`] = `unreadable: ${errorCode(error)}`;
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) into[path] = `-> ${readlinkSync(path)}`;
    else if (stat.isDirectory() && depth > 0) readTree(path, depth - 1, into);
    else if (stat.isFile()) into[path] = readOrUndefined(path)?.slice(0, 1_000_000) ?? "unreadable";
  }
}

/** One request through the proxy's CONNECT tunnel, TLS inside it; the raw answer, or the error. */
async function tunnelled(
  target: string,
  ca: string,
  request: string,
  options: { alpn?: string[]; untilHead?: boolean } = {},
): Promise<string> {
  const proxy = new URL(process.env["HTTPS_PROXY"] ?? "http://127.0.0.1:1");
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    await new Promise<void>((resolve, reject) => {
      let buffered = "";
      socket.once("error", reject);
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString("latin1");
        if (!buffered.includes("\r\n\r\n")) return;
        socket.off("data", onData);
        if (buffered.startsWith("HTTP/1.1 200")) resolve();
        else reject(new Error(buffered.split("\r\n")[0]));
      };
      socket.on("data", onData);
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    const host = target.slice(0, target.lastIndexOf(":"));
    const tls = await new Promise<ReturnType<typeof tlsConnect>>((resolve, reject) => {
      const secure = tlsConnect(
        { socket, host, ca, ALPNProtocols: options.alpn ?? ["http/1.1"] },
        () => resolve(secure),
      );
      secure.once("error", reject);
    });
    return await new Promise<string>((resolve) => {
      let text = "";
      tls.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (options.untilHead === true && text.includes("\r\n\r\n")) {
          tls.destroy();
          resolve(text);
        }
      });
      tls.on("end", () => resolve(text));
      tls.on("error", (error) => resolve(`${text}\nerror: ${errorCode(error)}`));
      tls.write(request);
    });
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    socket.destroy();
  }
}

/** Node's fetch to a server on the sandbox's own loopback, which the proxy must not swallow. */
function loopbackFetch(): Promise<string> {
  return new Promise((resolve) => {
    const server = createHttpServer((_req, res) => res.end("loopback ok"));
    // `::1`: the test allowlists 127.0.0.1 on the host, so that address must go through the proxy, and the sandbox has no /etc/hosts for `localhost`.
    server.listen(0, "::1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      try {
        const response = await fetch(`http://[::1]:${port}/`);
        resolve(`${response.status} ${await response.text()}`);
      } catch (error) {
        resolve(
          `error: ${error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error)}`,
        );
      } finally {
        server.close();
      }
    });
  });
}

/**
 * The red team's sweep: everything this program can find that might be the
 * credential (its environment, every file under /heel, HOME, /tmp and the
 * work root, /proc), then every way it might get the proxy to hand the
 * credential over. The whole haul goes to `out` in the work root and to
 * stdout: the test asserts the credential is in neither, in any encoding.
 */
async function hunt(credentialVar: string, target: string, out: string): Promise<Report> {
  const placeholder = process.env[credentialVar] ?? "";
  const files: Record<string, string> = {};
  for (const dir of ["/heel", process.env["HOME"] ?? "/heel/home", "/tmp", process.cwd()]) {
    readTree(dir, 4, files);
  }
  const proc: Record<string, string> = {};
  if (existsSync("/proc/self")) {
    for (const pid of readdirSync("/proc").filter(
      (name) => /^\d+$/.test(name) || name === "self",
    )) {
      for (const file of ["environ", "cmdline"]) {
        proc[`/proc/${pid}/${file}`] = readOrUndefined(`/proc/${pid}/${file}`) ?? "unreadable";
      }
    }
    for (const fd of readdirSync("/proc/self/fd")) {
      try {
        proc[`/proc/self/fd/${fd}`] = readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        // Closed while listing.
      }
    }
  }
  const ca = readFileSync(process.env["SSL_CERT_FILE"] ?? "/heel/run/ca.pem", "utf8");
  const request = (lines: string[], body = ""): string =>
    [...lines, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body].join(
      "\r\n",
    );
  const body = JSON.stringify({ token: placeholder });
  const requests = {
    auth: await tunnelled(
      target,
      ca,
      request(
        [
          `POST /reflect?key=${placeholder} HTTP/1.1`,
          `Host: ${target}`,
          `Authorization: token ${placeholder}`,
          `X-Reflect: ${placeholder}`,
          `Cookie: session=${placeholder}`,
        ],
        body,
      ),
    ),
    customHeader: await tunnelled(
      target,
      ca,
      request([`GET /custom HTTP/1.1`, `Host: ${target}`, `X-Api-Key: ${placeholder}`]),
    ),
    foreign: await tunnelled(
      target,
      ca,
      request([
        `GET /foreign HTTP/1.1`,
        `Host: ${target}`,
        "Authorization: token not-the-placeholder",
      ]),
    ),
    hostMismatch: await tunnelled(
      target,
      ca,
      request([
        `GET /host HTTP/1.1`,
        "Host: api.github.com",
        `Authorization: token ${placeholder}`,
      ]),
    ),
    h2Only: await tunnelled(target, ca, request([`GET /h2 HTTP/1.1`, `Host: ${target}`]), {
      alpn: ["h2"],
    }),
    h2c: await tunnelled(
      target,
      ca,
      request([
        `GET /h2c HTTP/1.1`,
        `Host: ${target}`,
        "Connection: Upgrade, HTTP2-Settings",
        "Upgrade: h2c",
        "HTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA",
        `Authorization: token ${placeholder}`,
      ]),
    ),
    websocket: await tunnelled(
      target,
      ca,
      [
        `GET /socket HTTP/1.1`,
        `Host: ${target}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Authorization: token ${placeholder}`,
        "",
        "",
      ].join("\r\n"),
      { untilHead: true },
    ),
    // Node's own client, through HTTPS_PROXY and the sandbox's CA bundle, as a server would use it.
    fetch: await fetch(`https://${target}/fetch`, {
      headers: { authorization: `token ${placeholder}` },
    }).then(
      async (response) => `${response.status} ${await response.text()}`,
      (error: unknown) =>
        `error: ${error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error)}`,
    ),
  };
  const report = {
    placeholder,
    env: process.env,
    files,
    proc,
    requests: { ...requests, loopback: await loopbackFetch() },
  };
  writeFileSync(out, JSON.stringify(report));
  return report;
}

/**
 * What npm does with the config heel writes for it, without npm itself (the
 * sandbox has only heel's Node): read `NPM_CONFIG_USERCONFIG`, take the
 * `_authToken` keyed `//<host:port>/`, and send it as `Authorization: Bearer`
 * through `HTTPS_PROXY`, the way npm-registry-fetch does, once with Node's
 * fetch (trusting `NODE_EXTRA_CA_CERTS`) and once raw (trusting the config's
 * `cafile`). Then a foreign token, and the same sweep as `hunt` of everything
 * the program can read. The haul goes to `out` and stdout.
 */
async function npmLike(target: string, out: string): Promise<Report> {
  const configPath = process.env["NPM_CONFIG_USERCONFIG"] ?? "";
  const config = readOrUndefined(configPath) ?? "";
  const key = `//${target}/:_authToken=`;
  const token =
    config
      .split("\n")
      .find((line) => line.startsWith(key))
      ?.slice(key.length) ?? "";
  const cafile = /^cafile=(.+)$/m.exec(config)?.[1] ?? "";
  const ca = readOrUndefined(cafile) ?? "";
  const files: Record<string, string> = {};
  for (const dir of ["/heel", process.env["HOME"] ?? "/heel/home", "/tmp", process.cwd()]) {
    readTree(dir, 4, files);
  }
  const raw = (path: string, bearer: string): string =>
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${target}`,
      `Authorization: Bearer ${bearer}`,
      "npm-command: whoami",
      "Connection: close",
      "",
      "",
    ].join("\r\n");
  const requests = {
    whoami: await fetch(`https://${target}/-/whoami`, {
      headers: { authorization: `Bearer ${token}`, "npm-command": "whoami" },
    }).then(
      async (response) => `${response.status} ${await response.text()}`,
      (error: unknown) =>
        `error: ${error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error)}`,
    ),
    packument: await tunnelled(target, ca, raw("/left-pad", token)),
    foreign: await tunnelled(target, ca, raw("/foreign", "npm_not-the-placeholder")),
  };
  const report = { configPath, config, token, cafile, env: process.env, files, requests };
  writeFileSync(out, JSON.stringify(report));
  return report;
}

async function main(): Promise<Report | undefined> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "inspect":
      return inspect(rest[0] ?? "", rest.slice(1));
    case "args":
      return { args: rest };
    case "overwrite":
      return overwrite(rest);
    case "via-proxy":
      return viaProxy(rest[0] ?? "");
    case "direct":
      return direct(rest[0] ?? "", Number(rest[1]));
    case "print-env":
      await printEnv(rest[0] ?? "");
      return undefined;
    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, Number(rest[0])));
      return undefined;
    case "spew":
      process.stdout.write("a".repeat(Number(rest[0])));
      return undefined;
    case "spawn":
      return spawnMany(Number(rest[0]));
    case "alloc":
      return alloc(Number(rest[0]));
    case "hunt":
      return hunt(rest[0] ?? "", rest[1] ?? "", rest[2] ?? "hunt.json");
    case "npm-like":
      return npmLike(rest[0] ?? "", rest[1] ?? "npm.json");
    default:
      process.stderr.write(`fake-cli: unknown command ${String(command)}\n`);
      process.exit(64);
  }
}

const report = await main();
if (report !== undefined) process.stdout.write(`${JSON.stringify(report)}\n`);
