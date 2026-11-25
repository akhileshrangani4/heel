import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodemodeHost } from "../../src/codemode/hosted.ts";
import {
  opensslConfig,
  opensslDir,
  SANDBOX_EXEC,
  seatbeltAvailable,
  seatbeltProfile,
} from "../../src/codemode/seatbelt.ts";

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

describe("the OpenSSL config Node reads at startup", () => {
  const library = (text: string) =>
    Buffer.concat([Buffer.from([0, 7, 0]), Buffer.from(text), Buffer.from([0, 9])]);

  it("is found where OpenSSL keeps its config directory, as openssl version -d prints it", () => {
    expect(opensslDir(library('OPENSSLDIR: "/opt/homebrew/etc/openssl@4"\0'))).toBe(
      "/opt/homebrew/etc/openssl@4",
    );
    expect(opensslDir(library('ENGINESDIR: N/A\0OPENSSLDIR: "/usr/local/etc/openssl@3"'))).toBe(
      "/usr/local/etc/openssl@3",
    );
  });

  it("is nothing when the library names no directory, a relative one or an unended one", () => {
    expect(opensslDir(library("no config dir here"))).toBeNull();
    expect(opensslDir(library('OPENSSLDIR: "etc/ssl"'))).toBeNull();
    expect(opensslDir(library('OPENSSLDIR: "/opt/homebrew/etc/openssl@4'))).toBeNull();
    expect(opensslDir(library(`OPENSSLDIR: "/${"a".repeat(2000)}"`))).toBeNull();
  });

  it("is only looked for in the Node heel runs on, whose libraries heel has seen", () => {
    expect(opensslConfig("/somewhere/else/bin/node")).toBeNull();
  });

  it("puts that one file in the profile, and nothing else of its directory", () => {
    const input = { node: process.execPath, install: "/opt/heel", reads: ["/opt/heel/src"] };
    const config = "/opt/homebrew/etc/openssl@4/openssl.cnf";
    const profile = seatbeltProfile({ ...input, opensslConfig: config });
    expect(profile).toContain(`(allow file-read* (literal "${config}"))`);
    expect(profile).not.toContain('(subpath "/opt/homebrew/etc');
    expect(seatbeltProfile({ ...input, opensslConfig: null })).not.toContain("openssl");
  });
});

describe.runIf(seatbeltAvailable())("the helper's Node inside Seatbelt", () => {
  const command = () => new CodemodeHost({ installDir: INSTALL_DIR }).command();

  it("finds the config of the OpenSSL this Node loaded, when it loads one", () => {
    const shared = (process.config.variables as Record<string, unknown>)["node_shared_openssl"];
    const config = opensslConfig(process.execPath);
    if (shared === true) expect(config).toMatch(/^\/.+\/openssl\.cnf$/);
    else expect(config).toBeNull();
  });

  it("starts, whichever OpenSSL it reads its config from (a Homebrew Node reads /opt/homebrew/etc)", () => {
    const { file, args } = command();
    const run = spawnSync(file, [...args.slice(0, -2), "-e", 'console.log("up")'], {
      env: {},
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("up");
  });

  it.runIf(opensslConfig(process.execPath) !== null)(
    "lets a worker that escaped Node's permission model read that config file, but not the directory beside it",
    () => {
      const config = opensslConfig(process.execPath) ?? "";
      const body = `
const fs = require("fs");
const out = {};
const t = (name, f) => { try { f(); out[name] = "allowed"; } catch (e) { out[name] = "refused"; } };
t("config", () => fs.readFileSync(${JSON.stringify(config)}));
t("beside", () => fs.readdirSync(${JSON.stringify(dirname(config))}));
require("worker_threads").parentPort.postMessage(out);
`;
      const escaped = `new (require("node:worker_threads").Worker)(${JSON.stringify(body)}, { eval: true, execArgv: [] }).on("message", (m) => { console.log(JSON.stringify(m)); process.exit(0); });`;
      const { file, args } = command();
      const run = spawnSync(file, [...args.slice(0, -2), "-e", escaped], {
        env: {},
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
        config: "allowed",
        beside: "refused",
      });
    },
  );
});
