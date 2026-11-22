import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { formatTable } from "../../src/cli/common.ts";
import { addToClient, agentMcpUrl, type CliIo, EXIT, main, usageFor } from "../../src/cli/main.ts";
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
  exec?: CliIo["exec"],
  checkKey?: CliIo["checkKey"],
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
    ...(exec === undefined ? {} : { exec }),
    ...(checkKey === undefined ? {} : { checkKey }),
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
    expect(unknownCommand.stderr).toBe(
      'heel: unknown command "frobnicate"\nEvery command: heel help\n',
    );

    // A near miss names the command it probably meant, not all 127 lines of usage.
    const typo = await run(["accounts"], {});
    expect(typo.code).toBe(EXIT.usage);
    expect(typo.stderr).toBe(
      'heel: unknown command "accounts". Did you mean heel account?\nEvery command: heel help\n',
    );

    expect((await run(["stauts"], {})).stderr).toContain("Did you mean heel status?");

    // No command at all still gets the whole list.
    expect((await run([], {})).stderr).toContain("usage:");

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

  it("prints the command that adds heel to an agent app, for every project", () => {
    expect(addToClient("claude-code", "http://127.0.0.1:7300/mcp", "heel_x")).toContain(
      'claude mcp add --scope user --transport http heel "http://127.0.0.1:7300/mcp" --header "Authorization: Bearer heel_x"',
    );
    const codex = addToClient("codex", "http://127.0.0.1:7300/mcp", "heel_x");
    expect(codex).toContain("export HEEL_TOKEN=heel_x");
    expect(codex).toContain(
      'codex mcp add heel --url "http://127.0.0.1:7300/mcp" --bearer-token-env-var HEEL_TOKEN',
    );
  });

  it("agent add --client claude-code puts the token in Claude Code, never on the screen", async () => {
    const home = heelHome();
    await serveIn(home);
    const status = await run(["status"], { HEEL_HOME: home });
    expect(status.stdout).toContain("Passkeys:  none yet: run heel user enroll owner");
    const calls: string[][] = [];
    const exec: NonNullable<CliIo["exec"]> = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, output: "Added HTTP MCP server heel" };
    };
    const added = await run(
      ["agent", "add", "setup-bot", "--client", "claude-code"],
      { HEEL_HOME: home },
      [],
      exec,
    );
    expect(added.code).toBe(EXIT.ok);
    expect(added.stdout).not.toMatch(/heel_[A-Za-z0-9_-]{8}/);
    expect(added.stdout).toContain("Added heel to Claude Code for every project");
    expect(calls).toHaveLength(1);
    const [command, ...args] = calls[0] ?? [];
    expect(command).toBe("claude");
    expect(args.slice(0, 8)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "heel",
      "http://127.0.0.1:0/mcp",
    ]);
    const header = args[9] ?? "";
    expect(header).toMatch(/^Authorization: Bearer heel_\S+$/);

    // Rotating with --client swaps the entry: the old one out, the new token in.
    calls.length = 0;
    const rotated = await run(
      ["agent", "rotate", "setup-bot", "--client", "claude-code"],
      { HEEL_HOME: home },
      [],
      exec,
    );
    expect(rotated.code).toBe(EXIT.ok);
    expect(rotated.stdout).not.toMatch(/heel_[A-Za-z0-9_-]{8}/);
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "claude mcp remove",
      "claude mcp add",
    ]);
    expect(calls[1]?.[10]).not.toBe(header);

    const wrong = await run(["agent", "add", "x", "--client", "vim"], { HEEL_HOME: home });
    expect(wrong.code).not.toBe(EXIT.ok);
    expect(wrong.stderr).toContain("--client is one of claude-code, codex");
  });

  it("agent add --client falls back to printing the command, so the token isn't lost", async () => {
    const home = heelHome();
    await serveIn(home);
    // No program runner (tests, an embedding): print the command.
    const printed = await run(["agent", "add", "a1", "--client", "claude-code"], {
      HEEL_HOME: home,
    });
    const token = /^Token .*: (heel_\S+)$/m.exec(printed.stdout)?.[1];
    expect(token).toBeDefined();
    expect(printed.stdout).toContain(`--header "Authorization: Bearer ${token}"`);

    // Claude Code already has a heel entry: say how to replace it, and keep the token.
    const exists: NonNullable<CliIo["exec"]> = async () => ({
      code: 1,
      output: "MCP server heel already exists in user config",
    });
    const clash = await run(
      ["agent", "add", "a2", "--client", "claude-code"],
      { HEEL_HOME: home },
      [],
      exists,
    );
    expect(clash.stdout).toContain(
      "heel couldn't add itself to Claude Code (MCP server heel already exists",
    );
    expect(clash.stdout).toContain("heel agent rotate a2 --client claude-code");
    expect(clash.stdout).toMatch(/^Token .*: heel_\S+$/m);

    // claude isn't installed.
    const missing: NonNullable<CliIo["exec"]> = async () => ({ code: 127, output: "" });
    const none = await run(
      ["agent", "add", "a3", "--client", "claude-code"],
      { HEEL_HOME: home },
      [],
      missing,
    );
    expect(none.stdout).toContain("the claude command isn't on this PATH");
    expect(none.stdout).toMatch(/^Token .*: heel_\S+$/m);

    // Codex reads its token from a variable heel can't set: always printed, never run.
    const never: NonNullable<CliIo["exec"]> = async () => {
      throw new Error("codex must not be run");
    };
    const codex = await run(
      ["agent", "add", "a4", "--client", "codex"],
      { HEEL_HOME: home },
      [],
      never,
    );
    expect(codex.code).toBe(EXIT.ok);
    expect(codex.stdout).toContain("export HEEL_TOKEN=heel_");
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

  it("connect refuses a key the service rejects, and notes one it couldn't check", async () => {
    const home = heelHome();
    await serveIn(home);
    const rejected = await run(
      ["connect", "github", "--as", "gh-bad", "--credential-stdin"],
      { HEEL_HOME: home },
      ["ghp_placeholder\n"],
      undefined,
      async () => ({
        status: "rejected",
        message: "GitHub rejected this key, so heel didn't connect it.",
      }),
    );
    expect(rejected.code).toBe(EXIT.failed);
    expect(rejected.stderr).toContain("GitHub rejected this key");
    expect((await run(["account", "list"], { HEEL_HOME: home })).stdout).not.toContain("gh-bad");

    const unchecked = await run(
      ["connect", "slack", "--as", "slack-work", "--credential-stdin"],
      { HEEL_HOME: home },
      ["xoxb-maybe\n"],
      undefined,
      async () => ({
        status: "unchecked",
        message: "heel couldn't check this key with the service.",
      }),
    );
    expect(unchecked.code).toBe(EXIT.ok);
    expect(unchecked.stdout).toContain('Connected slack as "slack-work"');
    expect(unchecked.stderr).toContain("couldn't check this key");
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
