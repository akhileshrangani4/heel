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
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";

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
    default:
      process.stderr.write(`fake-cli: unknown command ${String(command)}\n`);
      process.exit(64);
  }
}

const report = await main();
if (report !== undefined) process.stdout.write(`${JSON.stringify(report)}\n`);
