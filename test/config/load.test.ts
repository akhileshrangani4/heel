import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigSource } from "../../src/config/load.ts";
import { humanPlaneUrlProblem, parseListenAddress } from "../../src/config/schema.ts";
import { YamlValidationError } from "../../src/config/yaml.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "heel-config-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(text: string): string {
  const file = join(home, "heel.yaml");
  writeFileSync(file, text);
  return file;
}

function validationIssues(run: () => unknown): YamlValidationError["issues"] {
  try {
    run();
  } catch (error) {
    if (error instanceof YamlValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected a YamlValidationError");
}

describe("heel.yaml loader", () => {
  it("uses defaults when the default config file is absent", () => {
    const config = loadConfig(resolveConfigSource({ HEEL_HOME: home }));
    expect(config.configFile).toBeNull();
    expect(config.databasePath).toBe(join(home, "heel.db"));
    expect(config.listen.agent).toEqual({ host: "127.0.0.1", port: 7300 });
    expect(config.listen.human).toEqual({ host: "127.0.0.1", port: 7301 });
    expect(config.adminSocketPath).toBe("/run/heel/admin.sock");
    expect(config.vault.keyFile).toBe(join(home, "master.key"));
    expect(config.publicUrl.href).toBe("http://localhost:7301/");
  });

  it("refuses a config file that was named but does not exist", () => {
    const source = resolveConfigSource({ HEEL_HOME: home }, join(home, "missing.yaml"));
    expect(() => loadConfig(source)).toThrow(/ENOENT/);
  });

  it("resolves relative paths against HEEL_HOME and keeps absolute ones", () => {
    writeConfig(
      [
        "database: data/heel.sqlite",
        "admin_socket: /tmp/heel-admin.sock",
        "public_url: https://heel.example.com",
        "listen:",
        "  agent: 0.0.0.0:9000",
        '  human: "[::1]:9001"',
        "vault:",
        "  key_file: keys/master.key",
      ].join("\n"),
    );
    const config = loadConfig(resolveConfigSource({ HEEL_HOME: home }));
    expect(config.databasePath).toBe(join(home, "data/heel.sqlite"));
    expect(config.adminSocketPath).toBe("/tmp/heel-admin.sock");
    expect(config.vault.keyFile).toBe(join(home, "keys/master.key"));
    expect(config.listen.agent).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(config.listen.human).toEqual({ host: "::1", port: 9001 });
  });

  it("reports an unknown key with its file, line and column", () => {
    const file = writeConfig("database: heel.db\nlisten:\n  agnet: 127.0.0.1:7300\n");
    const issues = validationIssues(() => loadConfig(resolveConfigSource({ HEEL_HOME: home })));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file, line: 3, path: "listen" });
    expect(issues[0]?.message).toMatch(/agnet/);
  });

  it("reports a bad value at the value's position", () => {
    const file = writeConfig("listen:\n  agent: localhost\n");
    const issues = validationIssues(() => loadConfig(resolveConfigSource({ HEEL_HOME: home })));
    expect(issues[0]).toMatchObject({ file, line: 2, col: 10, path: "listen.agent" });
    expect(issues[0]?.message).toMatch(/host:port/);
  });

  it("rejects duplicate keys", () => {
    writeConfig("database: a.db\ndatabase: b.db\n");
    const issues = validationIssues(() => loadConfig(resolveConfigSource({ HEEL_HOME: home })));
    expect(issues[0]?.line).toBe(2);
    expect(issues[0]?.message).toMatch(/unique/i);
  });

  it("prefers --config over HEEL_CONFIG over $HEEL_HOME/heel.yaml", () => {
    expect(resolveConfigSource({ HEEL_HOME: home })).toEqual({
      home,
      file: join(home, "heel.yaml"),
      explicit: false,
    });
    expect(resolveConfigSource({ HEEL_HOME: home, HEEL_CONFIG: "/etc/heel.yaml" }).file).toBe(
      "/etc/heel.yaml",
    );
    expect(
      resolveConfigSource({ HEEL_HOME: home, HEEL_CONFIG: "/etc/heel.yaml" }, "/opt/heel.yaml")
        .file,
    ).toBe("/opt/heel.yaml");
  });
});

describe("listen addresses", () => {
  it.each([
    ["127.0.0.1:7300", { host: "127.0.0.1", port: 7300 }],
    ["[::1]:80", { host: "::1", port: 80 }],
    ["heel.internal:0", { host: "heel.internal", port: 0 }],
  ])("parses %s", (text, expected) => {
    expect(parseListenAddress(text)).toEqual(expected);
  });

  it.each(["localhost", ":7300", "::1:80", "host:65536", "host:-1", "a b:80"])(
    "rejects %s",
    (text) => {
      expect(parseListenAddress(text)).toBeNull();
    },
  );
});

describe("human plane public URL", () => {
  it("allows https anywhere and http only on localhost", () => {
    expect(humanPlaneUrlProblem(new URL("https://heel.example.com"))).toBeNull();
    expect(humanPlaneUrlProblem(new URL("http://localhost:7301"))).toBeNull();
    expect(humanPlaneUrlProblem(new URL("http://127.0.0.1:7301"))).toBeNull();
    expect(humanPlaneUrlProblem(new URL("http://[::1]:7301"))).toBeNull();
    expect(humanPlaneUrlProblem(new URL("http://heel.example.com"))).toMatch(/https/);
  });
});
