/**
 * `heel run` end to end under real bubblewrap (D8b; spec: CLI runner): the
 * `/run` route, the real pipeline and the CLI definition start a fake CLI in
 * the sandbox with the account's credential, and the agent's answer never
 * carries that credential.
 *
 * Locally the suite skips when this host can't run a sandbox; CI sets
 * HEEL_REQUIRE_SANDBOX, so there a skip is a failure.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeSandbox, REDACTED, startSandboxed } from "../../src/runner/index.ts";
import { cliPipeline } from "../../test/helpers/cli-pipeline.ts";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));
const TOKEN = "fake-cli-e2e-credential-0123456789";

const probe = await probeSandbox();
if (!probe.ok && process.env["HEEL_REQUIRE_SANDBOX"] === "1") {
  throw new Error(`HEEL_REQUIRE_SANDBOX is set but the sandbox is unavailable: ${probe.detail}`);
}

describe.skipIf(!probe.ok)("heel run under bubblewrap", () => {
  function setUp() {
    if (!probe.ok) throw new Error("no sandbox");
    const h = cliPipeline({
      owner: "rules:\n  - match: { command: fake }\n    then: allow\n",
      real: { host: probe.host, start: startSandboxed },
      settings: {
        transport: "cli",
        command: "fake",
        bin: probe.host.node,
        egress: [],
        credentialEnv: "FAKE_TOKEN",
      },
      credential: TOKEN,
    });
    // Only the work root is mounted, so the fake CLI runs from inside it.
    const script = join(h.root, "fake-cli.ts");
    copyFileSync(FAKE_CLI, script);
    return { ...h, script };
  }

  it("runs the command with the credential in its environment, and scrubs it from the output", async () => {
    const h = setUp();
    const answer = await h.run({
      argv: ["fake", h.script, "print-env", "FAKE_TOKEN"],
      cwd: h.repo,
    });
    expect(answer.status).toBe(200);
    expect(answer.body["status"]).toBe("ran");
    expect(answer.body["exitCode"]).toBe(0);
    expect(String(answer.body["stdout"])).toContain(REDACTED);
    expect(JSON.stringify(answer.body)).not.toContain(TOKEN);
  });

  it("starts in the agent's directory, with no /proc to read the credential back from", async () => {
    const h = setUp();
    // Built at run time: an argument naming /proc is refused before it gets here.
    const probe = `const fs = require("node:fs");
const environ = "/pro" + "c/self/environ";
let proc;
try { fs.readFileSync(environ); proc = "readable"; } catch (e) { proc = e.code; }
console.log(JSON.stringify({ cwd: process.cwd(), proc }));`;
    const answer = await h.run({ argv: ["fake", "-e", probe], cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const report = JSON.parse(String(answer.body["stdout"])) as Record<string, unknown>;
    expect(report).toEqual({ cwd: h.repo, proc: "ENOENT" });
    expect(JSON.stringify(answer.body)).not.toContain(TOKEN);
  });
});
