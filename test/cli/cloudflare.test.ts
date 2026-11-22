import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentHostnameFor, isHostname, setUpCloudflare } from "../../src/cli/approve-from.ts";
import { type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/config/load.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Roadmap 2.7, part 2: a Cloudflare named tunnel on the owner's domain, whose
 * address never changes, so the passkey keeps working.
 */

const TUNNEL_ID = "6ff42ae2-765d-4adf-8112-31c55c1551ef";

function fakeCloudflared(
  overrides: { version?: number; create?: { code: number; output: string } } = {},
) {
  const calls: string[][] = [];
  const exec: NonNullable<CliIo["exec"]> = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version")
      return { code: overrides.version ?? 0, output: "cloudflared version 2026.3.0" };
    if (args[1] === "create") {
      return (
        overrides.create ?? {
          code: 0,
          output: JSON.stringify({ id: TUNNEL_ID, name: "heel-abc123" }),
        }
      );
    }
    return { code: 0, output: "" };
  };
  return { exec, calls };
}

const PORTS = { agent: 7300, human: 7301 };

describe("approving through a Cloudflare tunnel (2.7)", () => {
  it("names the agent plane as a sibling hostname the free certificate covers", () => {
    expect(agentHostnameFor("heel.example.com")).toBe("heel-agents.example.com");
    expect(isHostname("heel.example.com")).toBe(true);
    expect(isHostname("heel")).toBe(false);
    expect(isHostname("heel.example.com/path")).toBe(false);
  });

  it("creates the tunnel, routes both hostnames, and writes a config for both planes only", async () => {
    const { exec, calls } = fakeCloudflared();
    const set = await setUpCloudflare(exec, {
      home: "/heel",
      hostname: "heel.example.com",
      agentHostname: "heel-agents.example.com",
      ports: PORTS,
      loggedIn: true,
      suffix: "abc123",
    });
    expect(set.ok && set.addresses).toEqual({
      approvals: "https://heel.example.com",
      agents: "https://heel-agents.example.com",
    });
    expect(calls.slice(1)).toEqual([
      [
        "cloudflared",
        "tunnel",
        "create",
        "--output",
        "json",
        "--credentials-file",
        "/heel/cloudflared/heel-abc123.json",
        "heel-abc123",
      ],
      ["cloudflared", "tunnel", "route", "dns", TUNNEL_ID, "heel.example.com"],
      ["cloudflared", "tunnel", "route", "dns", TUNNEL_ID, "heel-agents.example.com"],
    ]);
    expect(set.ok && set.config).toContain(`tunnel: ${TUNNEL_ID}`);
    expect(set.ok && set.config).toContain("service: http://127.0.0.1:7301");
    expect(set.ok && set.config).toContain("service: http_status:404");
  });

  it("says what to do when cloudflared is missing or not signed in", async () => {
    const problem = async (version: number, loggedIn: boolean) => {
      const set = await setUpCloudflare(fakeCloudflared({ version }).exec, {
        home: "/heel",
        hostname: "heel.example.com",
        agentHostname: "heel-agents.example.com",
        ports: PORTS,
        loggedIn,
        suffix: "x",
      });
      return set.ok ? "" : set.problem;
    };
    expect(await problem(127, true)).toMatch(/isn't installed/);
    expect(await problem(0, false)).toMatch(/cloudflared tunnel login/);
  });

  it("heel init --approve-from cloudflare writes the tunnel config and both addresses, and heel loads them", async () => {
    const home = join(tempDir("heel-init-cf-"), "home");
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      env: { HEEL_HOME: home, TUNNEL_ORIGIN_CERT: "/somewhere/cert.pem" },
      stdin: (async function* () {})(),
      stdout: { write: (t) => (stdout += t) },
      stderr: { write: (t) => (stderr += t) },
      exec: fakeCloudflared().exec,
    };
    expect(await main(["init", "--yes", "--approve-from", "cloudflare"], io)).toBe(EXIT.usage);
    stderr = "";
    expect(
      await main(
        ["init", "--yes", "--approve-from", "cloudflare", "--hostname", "Heel.Example.com"],
        io,
      ),
    ).toBe(EXIT.ok);
    expect(stderr).not.toMatch(/heel:/);
    expect(stdout).toContain("Approve at https://heel.example.com");
    expect(readFileSync(join(home, "cloudflared.yml"), "utf8")).toContain(
      "hostname: heel-agents.example.com",
    );
    const config = loadConfig({ file: join(home, "heel.yaml"), home, explicit: true });
    expect(String(config.publicUrl)).toBe("https://heel.example.com/");
    expect(config.tunnel.cloudflare?.config).toBe(join(home, "cloudflared.yml"));
  });

  it("creates no tunnel when heel.yaml already has another address", async () => {
    const home = join(tempDir("heel-init-cf-"), "home");
    let stderr = "";
    const cloudflared = fakeCloudflared();
    const io: CliIo = {
      env: { HEEL_HOME: home, TUNNEL_ORIGIN_CERT: "/somewhere/cert.pem" },
      stdin: (async function* () {})(),
      stdout: { write: () => {} },
      stderr: { write: (t) => (stderr += t) },
      exec: cloudflared.exec,
    };
    expect(await main(["init", "--yes"], io)).toBe(EXIT.ok);
    writeFileSync(join(home, "heel.yaml"), "public_url: https://elsewhere.example.com\n");
    expect(
      await main(
        ["init", "--yes", "--approve-from", "cloudflare", "--hostname", "heel.example.com"],
        io,
      ),
    ).toBe(EXIT.failed);
    expect(stderr).toMatch(/already has public_url/);
    expect(cloudflared.calls.some((c) => c[1] === "create")).toBe(false);
  });
});
