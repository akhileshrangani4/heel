import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { formatTable } from "../../src/cli/common.ts";
import { agentMcpUrl, type CliIo, EXIT, main, usageFor } from "../../src/cli/main.ts";
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
async function serveIn(
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ agentUrl: string }> {
  const env = {
    HEEL_HOME: home,
    [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)),
    ...extraEnv,
  };
  const config = loadConfig(resolveConfigSource(env, undefined));
  const heel = await startHeel({ config, env, log: createLogger("silent"), version: "test" });
  onTestFinished(() => heel.close());
  if (heel.planes.agent.state !== "listening") throw new Error(heel.planes.agent.reason);
  return { agentUrl: heel.planes.agent.url };
}

describe("agentMcpUrl", () => {
  it("builds the MCP URL from the agent listen address, on the direct tools until code mode", () => {
    expect(agentMcpUrl({ host: "127.0.0.1", port: 7300 })).toBe("http://127.0.0.1:7300/mcp");
    expect(agentMcpUrl({ host: "::1", port: 7300 })).toBe("http://[::1]:7300/mcp");
  });

  it("names localhost for a wildcard listen address, and the public URL when there is one", () => {
    expect(agentMcpUrl({ host: "0.0.0.0", port: 7300 })).toBe("http://localhost:7300/mcp");
    expect(agentMcpUrl({ host: "::", port: 7300 })).toBe("http://localhost:7300/mcp");
    expect(
      agentMcpUrl({ host: "0.0.0.0", port: 7300 }, new URL("https://agents.example.com")),
    ).toBe("https://agents.example.com/mcp");
    expect(agentMcpUrl({ host: "0.0.0.0", port: 7300 }, new URL("https://example.com/heel"))).toBe(
      "https://example.com/heel/mcp",
    );
  });
});

describe("heel CLI", () => {
  it("points heel resume at the Pause page, since resuming needs a passkey", async () => {
    const result = await run(["resume"], { HEEL_HOME: heelHome() });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("resuming needs your passkey");
    expect(result.stderr).toMatch(/http:\/\/localhost:\d+\/pause/);
    expect(result.stderr).toContain("heel pause list");
  });

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

    const badDelivery = await run(["account", "set", "notes", "--credential-delivery", "file"], {
      HEEL_HOME: heelHome(),
    });
    expect(badDelivery.code).toBe(EXIT.usage);
    expect(badDelivery.stderr).toContain("--credential-delivery is env or proxy");

    const remote = await run(
      [
        "connect",
        "mcp",
        "--as",
        "r",
        "--url",
        "https://mcp.example/mcp",
        "--credential-delivery",
        "env",
      ],
      { HEEL_HOME: heelHome() },
    );
    expect(remote.code).toBe(EXIT.usage);
    expect(remote.stderr).toContain("are for heel connect cli and local MCP servers");

    const neither = await run(["account", "set", "notes"], { HEEL_HOME: heelHome() });
    expect(neither.code).toBe(EXIT.usage);
    expect(neither.stderr).toContain("--credential-host <host>, or --credential-delivery env");
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
    expect(result.stderr).toContain("isn't running");
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
    // The token is accepted (not 401): code mode answers, and a bare GET isn't an MCP request.
    expect(call.status).toBe(405);

    const duplicate = await run(["agent", "add", "inbox-bot"], { HEEL_HOME: home });
    expect(duplicate.code).toBe(EXIT.failed);

    const listed = await run(["agent", "list"], { HEEL_HOME: home });
    // A table by default, with names; --json for scripts.
    expect(listed.stdout).toMatch(
      /^NAME\s+OWNER\s+STATUS\s+TOKEN EXPIRES \(UTC\)\s+ADDED \(UTC\)\ninbox-bot\s+owner\s+active\s+\d{4}-\d\d-\d\d /,
    );
    expect(listed.stdout).not.toContain(token);
    const json = await run(["agent", "list", "--json"], { HEEL_HOME: home });
    expect(JSON.parse(json.stdout)).toMatchObject([{ name: "inbox-bot", owner: "owner" }]);
    expect(json.stdout).not.toContain(token);
  });

  it("agent workdir lists with no directories, sets them, and clears only with --clear", async () => {
    const home = heelHome();
    await serveIn(home);
    const env = { HEEL_HOME: home };
    await run(["agent", "add", "coder"], env);
    // Outside heel's home, which can't be a work root; stored resolved (macOS's /tmp is a link).
    const a = realpathSync(tempDir("heel-root-"));
    const b = realpathSync(tempDir("heel-root-"));

    const none = await run(["agent", "workdir", "coder"], env);
    expect(none.code).toBe(EXIT.ok);
    expect(none.stdout).toBe(
      '"coder" has no workdirs, so heel run refuses its commands.\n' +
        "Add one with: heel agent workdir coder <dir>\n",
    );

    const set = await run(["agent", "workdir", "coder", a, `${b}/`], env);
    expect(set.code).toBe(EXIT.ok);
    expect(set.stdout).toBe(`"coder" may run commands in:\n  ${a}\n  ${b}\n`);

    // Listing doesn't change them.
    const listed = await run(["agent", "workdir", "coder"], env);
    expect(listed.stdout).toBe(`"coder" may run commands in:\n  ${a}\n  ${b}\n`);

    const cleared = await run(["agent", "workdir", "coder", "--clear"], env);
    expect(cleared.code).toBe(EXIT.ok);
    expect(cleared.stdout).toContain('"coder" has no workdirs');
    expect((await run(["agent", "workdir", "coder"], env)).stdout).toContain("has no workdirs");

    const both = await run(["agent", "workdir", "coder", a, "--clear"], env);
    expect(both.code).toBe(EXIT.usage);
    expect(both.stderr).toContain("give either directories or --clear");
    const elsewhere = await run(["agent", "rotate", "coder", "--clear"], env);
    expect(elsewhere.code).toBe(EXIT.usage);

    const unknown = await run(["agent", "workdir", "nobody"], env);
    expect(unknown.code).toBe(EXIT.failed);
    expect(unknown.stderr).toContain('no agent named "nobody"');

    const missing = await run(["agent", "workdir", "coder", join(a, "absent")], env);
    expect(missing.code).toBe(EXIT.failed);
    expect(missing.stderr).toContain("it doesn't exist");

    await run(["agent", "revoke", "coder"], env);
    const revoked = await run(["agent", "workdir", "coder"], env);
    expect(revoked.code).toBe(EXIT.failed);
    expect(revoked.stderr).toContain('agent "coder" is revoked');
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

  it("connect gmail without providers.google says how to set up Google sign-in", async () => {
    const home = heelHome();
    await serveIn(home);

    const gmail = await run(["connect", "gmail", "--as", "gmail-work"], { HEEL_HOME: home });
    expect(gmail.code).toBe(EXIT.ok);
    expect(gmail.stdout).toContain('Connected gmail as "gmail-work"');
    expect(gmail.stdout).toContain("providers.google");
    expect(gmail.stdout).toContain("https://useheel.dev/docs/google-sign-in");
    expect(gmail.stdout.trimEnd().split("\n")).toHaveLength(2);

    const calendar = await run(["connect", "google-calendar", "--as", "cal"], { HEEL_HOME: home });
    expect(calendar.stdout).toContain("https://useheel.dev/docs/google-sign-in");

    const github = await run(["connect", "github", "--as", "gh"], { HEEL_HOME: home });
    expect(github.stdout).not.toContain("providers.");
    expect(github.stdout).not.toContain("Connections page");
  });

  it("connect gmail with providers.google points at the Connections page", async () => {
    const home = heelHome();
    writeFileSync(
      join(home, "heel.yaml"),
      "admin_socket: run/admin.sock\nlisten:\n  agent: 127.0.0.1:0\n  human: 127.0.0.1:0\n" +
        "providers:\n  google:\n    client_id: test-client.apps.googleusercontent.com\n",
    );
    await serveIn(home, { HEEL_GOOGLE_CLIENT_SECRET: "test-secret" });

    const gmail = await run(["connect", "gmail", "--as", "gmail-work"], { HEEL_HOME: home });
    expect(gmail.code).toBe(EXIT.ok);
    expect(gmail.stdout).not.toContain("providers.google");
    expect(gmail.stdout).toContain("http://localhost:7301/connections");
  });

  it("serve with providers.google but no client secret says which secret, without a stack", async () => {
    const home = heelHome();
    writeFileSync(
      join(home, "heel.yaml"),
      "admin_socket: run/admin.sock\nlisten:\n  agent: 127.0.0.1:0\n  human: 127.0.0.1:0\n" +
        "providers:\n  google:\n    client_id: test-client.apps.googleusercontent.com\n",
    );

    const served = await run(["serve"], {
      HEEL_HOME: home,
      [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)),
    });

    expect(served.code).toBe(EXIT.config);
    expect(served.stderr).toContain("no secret: set HEEL_GOOGLE_CLIENT_SECRET or create");
    expect(served.stderr).toContain("google-client-secret");
    expect(served.stderr).not.toContain("    at ");
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

describe("heel help and usage errors (T10)", () => {
  it("prints one command's usage for <command> --help and heel help <command>", () => {
    expect(usageFor("agent")).toContain("heel agent workdir <name>");
    expect(usageFor("agent")).not.toContain("heel connect");
    expect(usageFor("rules")).toContain("heel rules test <cases.yaml>");
    expect(usageFor("nope")).toBeNull();
  });

  it("formats lists as aligned tables, with a hint when empty", () => {
    expect(
      formatTable(
        ["name", "owner"],
        [
          ["inbox-bot", "alice"],
          ["b", "bob"],
        ],
        "none",
      ),
    ).toBe("NAME       OWNER\ninbox-bot  alice\nb          bob\n");
    expect(formatTable(["name"], [], "No agents yet.")).toBe("No agents yet.\n");
  });
});
