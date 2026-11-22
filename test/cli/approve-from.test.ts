import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listenPorts, setUpTailscale, writeAddresses } from "../../src/cli/approve-from.ts";
import { type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Roadmap 2.7: heel init --approve-from settles where the owner approves,
 * before a passkey exists. Tailscale serves both planes on the tailnet.
 */

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "heel-box.tail1234.ts.net." },
  CertDomains: ["heel-box.tail1234.ts.net"],
});

function fakeTailscale(status: { code: number; output: string } = { code: 0, output: RUNNING }) {
  const calls: string[][] = [];
  const exec: NonNullable<CliIo["exec"]> = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "status") return status;
    return { code: 0, output: "" };
  };
  return { exec, calls };
}

describe("approving over Tailscale (2.7)", () => {
  it("serves both planes on the tailnet and gives their addresses", async () => {
    const { exec, calls } = fakeTailscale();
    const set = await setUpTailscale(exec, { agent: 7300, human: 7301 });
    expect(set).toEqual({
      ok: true,
      addresses: {
        approvals: "https://heel-box.tail1234.ts.net",
        agents: "https://heel-box.tail1234.ts.net:8443",
      },
    });
    expect(calls.slice(1)).toEqual([
      ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:7301"],
      ["tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:7300"],
    ]);
  });

  it("says what to do when Tailscale is missing, signed out, nameless or without HTTPS", async () => {
    const problem = async (status: { code: number; output: string }) => {
      const set = await setUpTailscale(fakeTailscale(status).exec, { agent: 7300, human: 7301 });
      return set.ok ? "" : set.problem;
    };
    expect(await problem({ code: 127, output: "" })).toMatch(/isn't installed.*tailscale up/);
    expect(
      await problem({ code: 0, output: JSON.stringify({ BackendState: "NeedsLogin" }) }),
    ).toMatch(/isn't connected \(NeedsLogin\)/);
    expect(
      await problem({ code: 0, output: JSON.stringify({ BackendState: "Running", Self: {} }) }),
    ).toMatch(/MagicDNS/);
    expect(
      await problem({
        code: 0,
        output: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "a.b.ts.net." },
          CertDomains: [],
        }),
      }),
    ).toMatch(/HTTPS certificates/);
  });

  it("writes both addresses into heel.yaml once, and won't change one already set", () => {
    const path = join(tempDir("heel-approve-"), "heel.yaml");
    writeFileSync(path, "# mine\nlisten:\n  agent: 127.0.0.1:7400\n  human: 127.0.0.1:7401\n");
    expect(listenPorts(readFileSync(path, "utf8"))).toEqual({ agent: 7400, human: 7401 });
    const addresses = { approvals: "https://a.ts.net", agents: "https://a.ts.net:8443" };
    expect(writeAddresses(path, addresses)).toEqual({ ok: true, changed: true });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# mine");
    expect(text).toContain("public_url: https://a.ts.net");
    expect(text).toContain("agent_public_url: https://a.ts.net:8443");
    expect(text).toContain("A passkey only works on the address it was made on");
    expect(writeAddresses(path, addresses)).toEqual({ ok: true, changed: false });
    const moved = writeAddresses(path, { ...addresses, approvals: "https://b.ts.net" });
    expect(moved.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("heel init --approve-from tailscale sets heel up with its tailnet addresses", async () => {
    const home = join(tempDir("heel-init-ts-"), "home");
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      env: { HEEL_HOME: home },
      stdin: (async function* () {})(),
      stdout: { write: (t) => (stdout += t) },
      stderr: { write: (t) => (stderr += t) },
      exec: fakeTailscale().exec,
    };
    expect(await main(["init", "--yes", "--approve-from", "tailscale"], io)).toBe(EXIT.ok);
    expect(stdout).toContain("Approve at https://heel-box.tail1234.ts.net");
    expect(stdout).toContain("https://heel-box.tail1234.ts.net:8443/mcp");
    expect(readFileSync(join(home, "heel.yaml"), "utf8")).toContain(
      "public_url: https://heel-box.tail1234.ts.net",
    );

    const offline: CliIo = { ...io, exec: fakeTailscale({ code: 127, output: "" }).exec };
    const other = join(tempDir("heel-init-ts-"), "home");
    expect(
      await main(["init", "--yes", "--approve-from", "tailscale"], {
        ...offline,
        env: { HEEL_HOME: other },
      }),
    ).toBe(EXIT.failed);
    expect(stderr).toMatch(/Tailscale isn't installed/);
    expect(await main(["init", "--yes", "--approve-from", "pigeon"], io)).toBe(EXIT.usage);
  });
});
