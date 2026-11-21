import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodemodeHost } from "../../src/codemode/hosted.ts";
import { SANDBOX_EXEC, seatbeltAvailable } from "../../src/codemode/seatbelt.ts";

/**
 * Seatbelt around the code-mode helper (macOS). Node's permission model
 * can't stop code that escaped into JavaScript from starting a worker with
 * none of its limits; this runs exactly that inside the helper's real
 * command and checks the kernel refuses it everything.
 */

const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));

const ESCAPE = `
const { Worker } = require("node:worker_threads");
const body = \`
const out = {};
const t = (name, f) => { try { f(); out[name] = "allowed"; } catch (e) { out[name] = "refused"; } };
const fs = require("fs");
t("read", () => fs.readFileSync("/etc/passwd"));
t("home", () => fs.readdirSync(require("os").homedir()));
t("write", () => fs.writeFileSync(${JSON.stringify(join(tmpdir(), "heel-seatbelt-probe"))}, "x"));
t("exec", () => require("child_process").execFileSync("/usr/bin/id"));
const net = require("net").connect(443, "1.1.1.1");
net.on("connect", () => { out.network = "allowed"; net.destroy(); done(); });
net.on("error", () => { out.network = "refused"; done(); });
function done() { require("worker_threads").parentPort.postMessage(out); }
\`;
new Worker(body, { eval: true, execArgv: [] }).on("message", (m) => { console.log(JSON.stringify(m)); process.exit(0); });
`;

describe.runIf(seatbeltAvailable())("Seatbelt around the code-mode helper", () => {
  it("is on by default on macOS", () => {
    const host = new CodemodeHost({ installDir: INSTALL_DIR });
    expect(host.seatbelt).toBe(true);
    expect(host.command().file).toBe(SANDBOX_EXEC);
  });

  it("refuses a worker that escaped Node's permission model files, home, writes, programs and the network", () => {
    const { file, args } = new CodemodeHost({ installDir: INSTALL_DIR }).command();
    // The helper's own command, with the script swapped for the escape.
    const probe = [...args.slice(0, -2), "-e", ESCAPE];
    const run = spawnSync(file, probe, { env: {}, encoding: "utf8", timeout: 20_000 });
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(result).toEqual({
      read: "refused",
      home: "refused",
      write: "refused",
      exec: "refused",
      network: "refused",
    });
    expect(homedir()).not.toBe("");
  });
});
