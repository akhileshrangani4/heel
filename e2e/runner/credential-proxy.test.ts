/**
 * The credential never enters the sandbox (spec: CLI runner, "Credential
 * delivery"), red-teamed under real bubblewrap. A fake CLI holding only the
 * placeholder sweeps everything it can read and tries every way to get the
 * proxy to hand the credential over; the test then checks the upstream saw
 * the real credential in the auth position only, and that nothing the
 * program saw or wrote carries it in any form.
 *
 * Locally the suite skips when this host can't run a sandbox; CI sets
 * HEEL_REQUIRE_SANDBOX, so there a skip is a failure. The upstream is a
 * local HTTPS server on an allowlisted IP literal; nothing needs the internet.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeSandbox, runSandboxed, type SandboxSpec } from "../../src/runner/index.ts";
import { type InterceptEvent, newPlaceholder } from "../../src/runner/intercept.ts";
import { headerOf, httpsUpstream } from "../../test/helpers/https-upstream.ts";
import { leakedForms } from "../../test/helpers/token-forms.ts";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));
/** 40 random characters, so a match anywhere can't be chance. */
const TOKEN = randomBytes(30).toString("base64url");

const probe = await probeSandbox();
if (!probe.ok && process.env["HEEL_REQUIRE_SANDBOX"] === "1") {
  throw new Error(`HEEL_REQUIRE_SANDBOX is set but the sandbox is unavailable: ${probe.detail}`);
}

describe.skipIf(!probe.ok)("credentials added at heel's egress proxy, under bubblewrap", () => {
  let upstream: Awaited<ReturnType<typeof httpsUpstream>>;
  let dir: string;

  beforeAll(async () => {
    upstream = await httpsUpstream();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "heel-e2e-inject-")));
  });
  afterAll(async () => {
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("I-75: the program holds a placeholder; the upstream gets the token in the auth position only", async () => {
    if (!probe.ok) return;
    const target = `127.0.0.1:${upstream.port}`;
    const root = join(dir, "work");
    const cwd = join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    const placeholder = newPlaceholder();
    const events: InterceptEvent[] = [];
    // gh's shape: GH_TOKEN carries the placeholder, Authorization `token` (or `bearer`).
    const spec: SandboxSpec = {
      binary: probe.host.node,
      args: [FAKE_CLI, "hunt", "GH_TOKEN", target, join(cwd, "hunt.json")],
      workRoot: root,
      cwd,
      env: { GH_TOKEN: placeholder },
      readOnlyPaths: [FAKE_CLI],
      network: {
        kind: "egress",
        allow: [target],
        inject: {
          hosts: [target],
          auth: { type: "authorization", schemes: ["token", "bearer"] },
          placeholder,
          credential: async () => TOKEN,
        },
      },
    };
    const before = upstream.seen.length;
    const result = await runSandboxed(probe.host, spec, {
      upstreamCa: [upstream.ca],
      onCredentialRequest: (event) => events.push(event),
    });
    expect(result.outcome, result.stderr.toString("utf8")).toEqual({ kind: "exited", code: 0 });
    const report = JSON.parse(result.stdout.toString("utf8")) as {
      placeholder: string;
      env: Record<string, string>;
      requests: Record<string, string>;
    };

    // Nothing the program could read, send or write carries the token, in any form.
    const written = readFileSync(join(cwd, "hunt.json"));
    expect(leakedForms(written, TOKEN)).toEqual([]);
    expect(leakedForms(result.stdout, TOKEN)).toEqual([]);
    expect(leakedForms(result.stderr, TOKEN)).toEqual([]);
    expect(report.placeholder).toBe(placeholder);
    expect(report.env["SSL_CERT_FILE"]).toBe("/heel/run/ca.pem");
    expect(report.env["NODE_USE_ENV_PROXY"]).toBe("1");

    // The upstream: the token in the Authorization header and nowhere else; the placeholder unchanged elsewhere.
    const seen = upstream.seen.slice(before);
    const byPath = (path: string) => seen.find((r) => r.url.startsWith(path));
    const auth = byPath("/reflect");
    expect(headerOf(auth?.rawHeaders ?? [], "authorization")).toBe(`token ${TOKEN}`);
    expect(headerOf(auth?.rawHeaders ?? [], "x-reflect")).toBe(placeholder);
    expect(headerOf(auth?.rawHeaders ?? [], "cookie")).toBe(`session=${placeholder}`);
    expect(auth?.url).toBe(`/reflect?key=${placeholder}`);
    expect(auth?.body).toBe(JSON.stringify({ token: placeholder }));
    expect(headerOf(byPath("/custom")?.rawHeaders ?? [], "x-api-key")).toBe(placeholder);
    expect(headerOf(byPath("/custom")?.rawHeaders ?? [], "authorization")).toBeUndefined();
    expect(headerOf(byPath("/socket")?.rawHeaders ?? [], "authorization")).toBe(`token ${TOKEN}`);
    expect(headerOf(byPath("/fetch")?.rawHeaders ?? [], "authorization")).toBe(`token ${TOKEN}`);
    for (const request of seen) {
      const elsewhere = [
        request.url,
        request.body,
        ...request.rawHeaders.filter((_, i, all) => all[i - 1]?.toLowerCase() !== "authorization"),
      ].join("\n");
      expect(leakedForms(elsewhere, TOKEN), request.url).toEqual([]);
    }

    // What heel refused never reached the upstream.
    expect(byPath("/foreign")).toBeUndefined();
    expect(byPath("/host")).toBeUndefined();
    expect(byPath("/h2")).toBeUndefined();
    expect(report.requests["foreign"]).toMatch(/^HTTP\/1\.1 403 [\s\S]*credential_mismatch/);
    expect(report.requests["hostMismatch"]).toMatch(/^HTTP\/1\.1 403 [\s\S]*host_mismatch/);
    expect(report.requests["h2c"]).toMatch(/^HTTP\/1\.1 400 [\s\S]*unsupported_upgrade/);
    expect(report.requests["h2Only"]).toMatch(/^error: /);
    expect(report.requests["websocket"]).toMatch(/^HTTP\/1\.1 101 /);
    expect(report.requests["fetch"]).toMatch(/^200 /);
    // The reflected request came back with the token scrubbed by the proxy.
    expect(report.requests["auth"]).toContain("[redacted by heel]");
    expect(events.filter((event) => event.injected).length).toBeGreaterThanOrEqual(3);
  });
});
