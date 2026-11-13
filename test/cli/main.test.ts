import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { agentMcpUrl, type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { loadConfig, resolveConfigSource } from "../../src/config/load.ts";
import { createLogger } from "../../src/log.ts";
import { startHeel } from "../../src/serve.ts";
import { encodeMasterKey, MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { tempDir } from "../helpers/store.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** A HEEL_HOME with a heel.yaml whose planes bind ephemeral ports. */
function heelHome(): string {
  const home = tempDir("heel-cli-");
  writeFileSync(
    join(home, "heel.yaml"),
    "admin_socket: run/admin.sock\nlisten:\n  agent: 127.0.0.1:0\n  human: 127.0.0.1:0\n",
  );
  return home;
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  stdin: string[] = [],
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    env,
    stdin: (async function* () {
      yield* stdin;
    })(),
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

/** Boots heel in-process against `home`, so CLI commands have an admin socket to talk to. */
async function serveIn(home: string): Promise<{ agentUrl: string }> {
  const env = { HEEL_HOME: home, [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)) };
  const config = loadConfig(resolveConfigSource(env, undefined));
  const heel = await startHeel({ config, env, log: createLogger("silent"), version: "test" });
  onTestFinished(() => heel.close());
  if (heel.planes.agent.state !== "listening") throw new Error(heel.planes.agent.reason);
  return { agentUrl: heel.planes.agent.url };
}

describe("agentMcpUrl", () => {
  it("builds the MCP URL from the agent listen address", () => {
    expect(agentMcpUrl({ host: "127.0.0.1", port: 7300 })).toBe("http://127.0.0.1:7300/mcp");
    expect(agentMcpUrl({ host: "::1", port: 7300 })).toBe("http://[::1]:7300/mcp");
  });
});

describe("heel CLI", () => {
  it("exits 64 with usage on an unknown command or flag", async () => {
    const unknownCommand = await run(["frobnicate"], {});
    expect(unknownCommand.code).toBe(EXIT.usage);
    expect(unknownCommand.stderr).toContain('unknown command "frobnicate"');
    expect(unknownCommand.stderr).toContain("usage:");

    const unknownFlag = await run(["agent", "add", "bot", "--nope"], { HEEL_HOME: heelHome() });
    expect(unknownFlag.code).toBe(EXIT.usage);

    const missingAlias = await run(["connect", "github"], { HEEL_HOME: heelHome() });
    expect(missingAlias.code).toBe(EXIT.usage);
    expect(missingAlias.stderr).toContain("--as");
  });

  it("exits 78 on an invalid or missing config file", async () => {
    const home = tempDir("heel-cli-");
    writeFileSync(join(home, "heel.yaml"), "listen:\n  agent: nowhere\n");
    const invalid = await run(["agent", "list"], { HEEL_HOME: home });
    expect(invalid.code).toBe(EXIT.config);
    expect(invalid.stderr).toContain("expected host:port");

    const missing = await run(["agent", "list", "--config", join(home, "absent.yaml")], {});
    expect(missing.code).toBe(EXIT.config);
    expect(missing.stderr).toContain("config file not found");
  });

  it("exits 69 when heel serve isn't running", async () => {
    const result = await run(["agent", "list"], { HEEL_HOME: heelHome() });
    expect(result.code).toBe(EXIT.unavailable);
    expect(result.stderr).toContain("not running");
  });

  it("vault init creates a 0600 master key once and never replaces it", async () => {
    const home = heelHome();
    const first = await run(["vault", "init"], { HEEL_HOME: home });
    expect(first.code).toBe(EXIT.ok);
    const keyFile = join(home, "master.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);

    const second = await run(["vault", "init"], { HEEL_HOME: home });
    expect(second.code).toBe(EXIT.failed);
    expect(second.stderr).toContain("never replaces");
  });

  it("agent add prints a working token once, with the agent plane's MCP URL", async () => {
    const home = heelHome();
    const { agentUrl } = await serveIn(home);

    const added = await run(["agent", "add", "inbox-bot"], { HEEL_HOME: home });
    expect(added.code).toBe(EXIT.ok);
    const token = /^Token .*: (heel_\S+)$/m.exec(added.stdout)?.[1];
    expect(token).toBeDefined();
    expect(added.stdout).toContain("MCP URL: http://127.0.0.1:0/mcp");

    const call = await fetch(`${agentUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    expect(call.status).toBe(501);

    const duplicate = await run(["agent", "add", "inbox-bot"], { HEEL_HOME: home });
    expect(duplicate.code).toBe(EXIT.failed);

    const listed = await run(["agent", "list"], { HEEL_HOME: home });
    expect(listed.stdout).toContain('"inbox-bot"');
    expect(listed.stdout).not.toContain(token);
  });

  it("I-02: connect reads the credential from stdin and never echoes it", async () => {
    const home = heelHome();
    await serveIn(home);
    const secret = `ghp_${randomBytes(12).toString("hex")}`;

    const connected = await run(
      ["connect", "github", "--as", "gh-work", "--credential-stdin"],
      { HEEL_HOME: home },
      [`${secret}\n`],
    );
    expect(connected.code).toBe(EXIT.ok);
    expect(connected.stdout).toContain('Connected github as "gh-work" (active)');
    expect(connected.stdout + connected.stderr).not.toContain(secret);

    const withoutCredential = await run(["connect", "slack", "--as", "slack-work"], {
      HEEL_HOME: home,
    });
    expect(withoutCredential.stdout).toContain("reconnect_required");

    const listed = await run(["account", "list"], { HEEL_HOME: home });
    expect(listed.stdout).not.toContain(secret);
  });

  it("bin/heel.js serve boots under Node type stripping and stops cleanly on SIGTERM", async () => {
    const home = heelHome();
    const env = {
      PATH: process.env["PATH"],
      HEEL_HOME: home,
      [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)),
    };
    const child = spawn(process.execPath, [join(REPO_ROOT, "bin", "heel.js"), "serve"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onTestFinished(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null && "msg" in parsed) {
            messages.push(String(parsed.msg));
          }
          if (messages.includes("agent plane listening")) resolve();
        }
      });
      child.on("exit", (code) => reject(new Error(`heel serve exited ${code}: ${stderr}`)));
    });

    expect(messages).toEqual(
      expect.arrayContaining(["vault open", "human plane listening", "agent plane listening"]),
    );
    expect(existsSync(join(home, "run", "admin.sock"))).toBe(true);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(existsSync(join(home, "run", "admin.sock"))).toBe(false);
  });
});
