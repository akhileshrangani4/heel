import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listenPorts,
  servedPorts,
  setUpTailscale,
  writeAddresses,
} from "../../src/cli/approve-from.ts";
import { type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { openStore } from "../../src/store/db.ts";
import { ensureInstall, ensureLocalOwner } from "../../src/store/install.ts";
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

const NAME = "heel-box.tail1234.ts.net";

type Served = { TCP?: Record<string, unknown>; Web?: Record<string, unknown> };

/** Tailnet ports proxied to local targets, as `tailscale serve status --json` shows them. */
function serving(...entries: [port: number, target: string][]): Served {
  const config: Required<Served> = { TCP: {}, Web: {} };
  for (const [port, target] of entries) {
    config.TCP[port] = { HTTPS: true };
    config.Web[`${NAME}:${port}`] = { Handlers: { "/": { Proxy: target } } };
  }
  return config;
}

/**
 * A fake `tailscale` that keeps its serve config: `serve --bg` adds to it and
 * `serve status --json` shows it, so a second run sees what the first one did.
 * A string for `served` is printed as is.
 */
function fakeTailscale(
  status: { code: number; output: string } = { code: 0, output: RUNNING },
  served: Served | string = {},
  serveFails = "",
) {
  const calls: string[][] = [];
  const state: Served = typeof served === "string" ? {} : structuredClone(served);
  const exec: NonNullable<CliIo["exec"]> = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "status") return status;
    if (args[1] === "status") {
      return { code: 0, output: typeof served === "string" ? served : JSON.stringify(state) };
    }
    const port = /^--https=(\d+)$/.exec(args[2] ?? "")?.[1];
    if (args[1] === "--bg" && port !== undefined && args[3] !== undefined) {
      if (serveFails !== "") return { code: 1, output: serveFails };
      const entry = serving([Number(port), args[3]]);
      state.TCP = { ...state.TCP, ...entry.TCP };
      state.Web = { ...state.Web, ...entry.Web };
      return { code: 0, output: "" };
    }
    return { code: 1, output: `fake tailscale: unexpected ${args.join(" ")}` };
  };
  return { exec, calls, state };
}

/** The `tailscale serve --bg` commands a run made. */
const serveCalls = (calls: string[][]) => calls.filter((c) => c.includes("--bg"));

/** Something that isn't heel, served on these tailnet ports. */
const otherService = (...ports: number[]) =>
  serving(...ports.map((p): [number, string] => [p, "http://127.0.0.1:8123"]));

function initIo(home: string, exec: NonNullable<CliIo["exec"]>) {
  const out = { stdout: "", stderr: "" };
  const io: CliIo = {
    env: { HEEL_HOME: home },
    stdin: (async function* () {})(),
    stdout: { write: (t) => (out.stdout += t) },
    stderr: { write: (t) => (out.stderr += t) },
    exec,
  };
  return { io, out };
}

describe("approving over Tailscale (2.7)", () => {
  it("serves both planes on 443 and 8443 when they're free", async () => {
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
      ["tailscale", "serve", "status", "--json"],
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

  it("heel init moves past a taken 443, says which ports it used, and reruns unchanged", async () => {
    const home = join(tempDir("heel-init-ts-"), "home");
    const tailscale = fakeTailscale(undefined, otherService(443, 8443));
    const { io, out } = initIo(home, tailscale.exec);
    expect(await main(["init", "--yes", "--approve-from", "tailscale"], io)).toBe(EXIT.ok);
    expect(out.stderr).toBe(
      "heel: Tailscale already serves something else on ports 443 and 8443, so heel used ports 7443 (approvals) and 7444 (agents).\n",
    );
    expect(out.stdout).toContain(`Approve at https://${NAME}:7443`);
    expect(out.stdout).toContain(`https://${NAME}:7444/mcp`);
    const yaml = readFileSync(join(home, "heel.yaml"), "utf8");
    expect(yaml).toContain(`public_url: https://${NAME}:7443`);
    expect(yaml).toContain(`agent_public_url: https://${NAME}:7444`);
    expect(tailscale.state.Web?.[`${NAME}:443`]).toEqual(otherService(443).Web?.[`${NAME}:443`]);

    tailscale.calls.length = 0;
    expect(await main(["init", "--yes", "--approve-from", "tailscale"], io)).toBe(EXIT.ok);
    expect(serveCalls(tailscale.calls)).toEqual([]);
    expect(readFileSync(join(home, "heel.yaml"), "utf8")).toBe(yaml);
  });

  it("heel init reruns on 443 and 8443 without serving again", async () => {
    const home = join(tempDir("heel-init-ts-"), "home");
    const tailscale = fakeTailscale();
    const { io, out } = initIo(home, tailscale.exec);
    expect(await main(["init", "--yes", "--approve-from", "tailscale"], io)).toBe(EXIT.ok);
    expect(serveCalls(tailscale.calls)).toHaveLength(2);
    const yaml = readFileSync(join(home, "heel.yaml"), "utf8");
    tailscale.calls.length = 0;
    expect(await main(["init", "--yes", "--approve-from", "tailscale"], io)).toBe(EXIT.ok);
    expect(serveCalls(tailscale.calls)).toEqual([]);
    expect(out.stderr).toBe("");
    expect(readFileSync(join(home, "heel.yaml"), "utf8")).toBe(yaml);
  });

  it("moves to a free port when another service has 443, and never touches it", async () => {
    const busy = fakeTailscale(undefined, otherService(443));
    const set = await setUpTailscale(busy.exec, { agent: 7300, human: 7301 });
    expect(set).toEqual({
      ok: true,
      addresses: { approvals: `https://${NAME}:7443`, agents: `https://${NAME}:8443` },
      note: "Tailscale already serves something else on port 443, so heel used ports 7443 (approvals) and 8443 (agents).",
    });
    expect(serveCalls(busy.calls)).toEqual([
      ["tailscale", "serve", "--bg", "--https=7443", "http://127.0.0.1:7301"],
      ["tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:7300"],
    ]);
    expect(busy.state.Web?.[`${NAME}:443`]).toEqual(otherService(443).Web?.[`${NAME}:443`]);

    // Both taken: the ports from the setup note.
    const both = await setUpTailscale(fakeTailscale(undefined, otherService(443, 8443)).exec, {
      agent: 7300,
      human: 7301,
    });
    expect(both).toMatchObject({
      ok: true,
      addresses: { approvals: `https://${NAME}:7443`, agents: `https://${NAME}:7444` },
      note: "Tailscale already serves something else on ports 443 and 8443, so heel used ports 7443 (approvals) and 7444 (agents).",
    });
  });

  it("counts TCP forwards, foreground serves, other paths and other names as taken", async () => {
    const ports = { agent: 7300, human: 7301 };
    const served = (config: unknown) => servedPorts(JSON.stringify(config), NAME, ports);
    expect(served({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } })?.get(443)).toBe("other");
    expect(served({ Foreground: { abc: serving([443, "http://127.0.0.1:7301"]) } })?.get(443)).toBe(
      "other",
    );
    expect(
      served({
        TCP: { "443": { HTTPS: true } },
        Web: {
          [`${NAME}:443`]: {
            Handlers: { "/": { Proxy: "http://127.0.0.1:7301" }, "/x": { Proxy: "http://a" } },
          },
        },
      })?.get(443),
    ).toBe("other");
    expect(served(serving([443, "http://127.0.0.1:7301/"]))?.get(443)).toBe("approvals");
    expect(
      served({
        Web: {
          "old-name.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7301" } } },
        },
      })?.get(443),
    ).toBe("other");
    expect(served({ TCP: { "443": { HTTPS: true } } })?.get(443)).toBe("other");
    // Nothing served prints `null`, and a version warning may follow the JSON.
    expect(servedPorts("null\n", NAME, ports)).toEqual(new Map());
    expect(
      servedPorts(
        `${JSON.stringify(serving([8443, "http://127.0.0.1:7300"]))}\nWarning: client version "1.90.1" != tailscaled server version "1.88.0"`,
        NAME,
        ports,
      ),
    ).toEqual(new Map([[8443, "agents"]]));
    expect(servedPorts("not json", NAME, ports)).toBeNull();
  });

  it("reruns without changing anything once heel is served, even on moved ports", async () => {
    const ours = serving([443, "http://127.0.0.1:7301"], [8443, "http://127.0.0.1:7300"]);
    const again = fakeTailscale(undefined, ours);
    expect(await setUpTailscale(again.exec, { agent: 7300, human: 7301 })).toEqual({
      ok: true,
      addresses: { approvals: `https://${NAME}`, agents: `https://${NAME}:8443` },
    });
    expect(serveCalls(again.calls)).toEqual([]);

    // A first run moved heel to 7443 and 7444; the rerun finds it there.
    const moved = fakeTailscale(undefined, otherService(443, 8443));
    const first = await setUpTailscale(moved.exec, { agent: 7300, human: 7301 });
    moved.calls.length = 0;
    expect(await setUpTailscale(moved.exec, { agent: 7300, human: 7301 })).toEqual(first);
    expect(serveCalls(moved.calls)).toEqual([]);

    // heel.yaml's address keeps its port, even once 443 is free again: a passkey is tied to it.
    const freed = fakeTailscale(undefined, {});
    const kept = await setUpTailscale(
      freed.exec,
      { agent: 7300, human: 7301 },
      { configured: { approvals: `https://${NAME}:7443`, agents: `https://${NAME}:7444` } },
    );
    expect(kept).toEqual({
      ok: true,
      addresses: { approvals: `https://${NAME}:7443`, agents: `https://${NAME}:7444` },
    });
    expect(serveCalls(freed.calls).map((c) => c[3])).toEqual(["--https=7443", "--https=7444"]);
  });

  it("changes nothing and says exactly what to run when it can't pick ports safely", async () => {
    const ports = { agent: 7300, human: 7301 };
    // It can't see what's served.
    const blind = fakeTailscale(undefined, "permission denied");
    const unread = await setUpTailscale(blind.exec, ports, { configPath: "/h/heel.yaml" });
    expect(unread.ok ? "" : unread.problem).toContain(
      [
        "To set it up yourself, run:",
        "  tailscale serve --bg --https=443 http://127.0.0.1:7301",
        "  tailscale serve --bg --https=8443 http://127.0.0.1:7300",
        "then set these in /h/heel.yaml, and restart heel if it's running:",
        `  public_url: https://${NAME}`,
        `  agent_public_url: https://${NAME}:8443`,
      ].join("\n"),
    );
    expect(unread.ok ? "" : unread.problem).toMatch(/couldn't read.*permission denied/);
    expect(serveCalls(blind.calls)).toEqual([]);

    // heel.yaml has the approval page on 443, and something else holds it now.
    const pinned = fakeTailscale(undefined, otherService(443));
    const stuck = await setUpTailscale(pinned.exec, ports, {
      configured: { approvals: `https://${NAME}/`, agents: null },
      configPath: "/h/heel.yaml",
    });
    expect(stuck.ok ? "" : stuck.problem).toMatch(
      /\/h\/heel\.yaml has public_url on port 443, but Tailscale serves something else there.*tailscale serve --https=443 off.*passkey/,
    );
    expect(serveCalls(pinned.calls)).toEqual([]);

    // Tailscale refuses to serve: the commands to run by hand, on the ports heel picked.
    const refused = fakeTailscale(
      undefined,
      otherService(443),
      "Access denied: serve config denied",
    );
    const denied = await setUpTailscale(refused.exec, ports);
    expect(denied.ok ? "" : denied.problem).toContain("Access denied");
    expect(denied.ok ? "" : denied.problem).toContain(
      "  tailscale serve --bg --https=7443 http://127.0.0.1:7301",
    );
    expect(denied.ok ? "" : denied.problem).toContain(`  public_url: https://${NAME}:7443`);

    const blocked = fakeTailscale();
    const no = await setUpTailscale(blocked.exec, ports, { precheck: () => "no" });
    expect(no).toEqual({ ok: false, problem: "no" });
    expect(serveCalls(blocked.calls)).toEqual([]);
  });

  it("treats the same address with a trailing slash as the same, and keeps a user's comment", () => {
    const path = join(tempDir("heel-approve-"), "heel.yaml");
    writeFileSync(path, "# my address\npublic_url: https://a.ts.net/\n");
    const addresses = { approvals: "https://a.ts.net", agents: "https://a.ts.net:8443" };
    expect(writeAddresses(path, addresses)).toEqual({ ok: true, changed: true });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# my address");
    expect(text).toContain("agent_public_url: https://a.ts.net:8443");
    expect(listenPorts("listen:\n  human: 127.0.0.1:99999\n")).toEqual({
      agent: 7300,
      human: 7301,
    });
  });

  it("won't move a heel that has a passkey unless told to, and prints no next steps when it stops", async () => {
    const home = join(tempDir("heel-init-pk-"), "home");
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      env: { HEEL_HOME: home },
      stdin: (async function* () {})(),
      stdout: { write: (t) => (stdout += t) },
      stderr: { write: (t) => (stderr += t) },
      exec: fakeTailscale().exec,
    };
    // A heel set up on this computer, with a passkey made there.
    expect(await main(["init", "--yes"], io)).toBe(EXIT.ok);
    const store = openStore(join(home, "heel.db"));
    const { orgId } = ensureInstall(store.db, new Date());
    const userId = ensureLocalOwner(store.db, orgId, new Date());
    store.sqlite
      .prepare(
        "INSERT INTO passkeys (id, org_id, user_id, public_key, counter, transports, rp_id, created_at) VALUES ('pk', ?, ?, x'00', 0, '[]', 'localhost', 0)",
      )
      .run(orgId, userId);
    store.close();
    stdout = "";
    const tailscale = fakeTailscale();
    expect(
      await main(["init", "--yes", "--approve-from", "tailscale"], { ...io, exec: tailscale.exec }),
    ).toBe(EXIT.failed);
    expect(stderr).toMatch(/already has a passkey made for localhost.*--new-address/);
    expect(stdout).not.toContain("Next:");
    expect(serveCalls(tailscale.calls)).toEqual([]);
    expect(await main(["init", "--yes", "--approve-from", "tailscale", "--new-address"], io)).toBe(
      EXIT.ok,
    );
  });
});
