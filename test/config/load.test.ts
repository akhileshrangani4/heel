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
    expect(config.adminSocketPath).toBe(join(home, "admin.sock"));
    expect(config.vault.keyFile).toBe(join(home, "master.key"));
    expect(config.publicUrl.href).toBe("http://localhost:7301/");
  });

  it("keeps a server install's admin socket in /run/heel", () => {
    const config = loadConfig(resolveConfigSource({ HEEL_HOME: "/var/lib/heel" }));
    expect(config.adminSocketPath).toBe("/run/heel/admin.sock");
    expect(loadConfig(resolveConfigSource({})).adminSocketPath).toBe("/run/heel/admin.sock");
  });

  it("has no approval adapters unless heel.yaml names one", () => {
    expect(loadConfig(resolveConfigSource({ HEEL_HOME: home })).adapters.approval).toEqual([]);
    writeFileSync(
      join(home, "heel.yaml"),
      "adapters:\n  approval:\n    - jev: { api_key_file: keys/typesafe }\n",
    );
    expect(loadConfig(resolveConfigSource({ HEEL_HOME: home })).adapters.approval).toEqual([
      { kind: "jev", model: "jev-latest", apiKeyFile: join(home, "keys/typesafe") },
    ]);
  });

  it("limits sandboxes to 4 per agent by default, and takes both limits from heel.yaml", () => {
    expect(loadConfig(resolveConfigSource({ HEEL_HOME: home })).sandboxes).toEqual({
      perAgent: 4,
      total: null,
    });
    writeConfig("sandboxes:\n  per_agent: 2\n  total: 8\n");
    expect(loadConfig(resolveConfigSource({ HEEL_HOME: home })).sandboxes).toEqual({
      perAgent: 2,
      total: 8,
    });
    writeConfig("sandboxes:\n  per_agent: 0\n");
    expect(
      validationIssues(() => loadConfig(resolveConfigSource({ HEEL_HOME: home }))),
    ).not.toEqual([]);
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

describe("oidc and audit sections", () => {
  const load = () => loadConfig(resolveConfigSource({ HEEL_HOME: home }));

  it("is single-user with no SIEM sink by default", () => {
    const config = load();
    expect(config.oidc).toBeNull();
    expect(config.audit.siem).toBeNull();
  });

  it("resolves oidc: defaults, the callback URI and the secret file path", () => {
    writeConfig(
      [
        "public_url: https://heel.example.com",
        "oidc:",
        "  issuer: https://idp.example.com/realms/acme",
        "  client_id: heel",
        "  client_secret_file: oidc-secret",
        "  roles:",
        "    admin: [heel-admins]",
      ].join("\n"),
    );
    const oidc = load().oidc;
    expect(oidc?.issuer.href).toBe("https://idp.example.com/realms/acme");
    expect(oidc?.redirectUri.href).toBe("https://heel.example.com/auth/oidc/callback");
    expect(oidc?.clientSecretFile).toBe(join(home, "oidc-secret"));
    expect(oidc?.scopes).toEqual(["openid", "profile", "email"]);
    expect(oidc?.groupsClaim).toBe("groups");
    expect(oidc?.roles).toEqual({ admin: ["heel-admins"], member: [] });
  });

  it.each([
    [
      "an http issuer off loopback",
      "  issuer: http://idp.example.com\n  client_id: heel\n  roles: { admin: [a] }",
    ],
    [
      "no admin group",
      "  issuer: https://idp.example.com\n  client_id: heel\n  roles: { admin: [] }",
    ],
    [
      "scopes without openid",
      "  issuer: https://idp.example.com\n  client_id: heel\n  scopes: [profile]\n  roles: { admin: [a] }",
    ],
    [
      "an unknown key",
      "  issuer: https://idp.example.com\n  client_id: heel\n  client_secret: inline\n  roles: { admin: [a] }",
    ],
  ])("rejects oidc: with %s", (_label, body) => {
    writeConfig(`oidc:\n${body}\n`);
    const issues = validationIssues(load);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toMatch(/^oidc/);
  });

  it("resolves audit.siem: defaults and converts units", () => {
    writeConfig(
      [
        "audit:",
        "  siem:",
        "    url: https://siem.example.com/ingest",
        "    auth:",
        "      token_file: siem-token",
        "    backlog_alert:",
        "      minutes: 2",
      ].join("\n"),
    );
    expect(load().audit.siem).toEqual({
      url: new URL("https://siem.example.com/ingest"),
      auth: { header: "Authorization", scheme: "Bearer", tokenFile: join(home, "siem-token") },
      batchSize: 500,
      intervalMs: 5_000,
      timeoutMs: 10_000,
      backlogAlert: { rows: 10_000, ageMs: 120_000 },
    });
  });

  it("rejects a plain-http SIEM endpoint off loopback", () => {
    writeConfig("audit:\n  siem:\n    url: http://siem.example.com/ingest\n");
    expect(validationIssues(load)[0]?.message).toMatch(/https/);
  });

  it("turns on web push alone by default, keyed in HEEL_HOME, with the public URL as contact", () => {
    const config = load();
    expect(config.notify).toEqual({
      webPush: { keyFile: join(home, "vapid.json"), subject: config.publicUrl.origin },
      email: null,
      slack: null,
    });
  });

  it("resolves notify.email and notify.slack with their secret files", () => {
    writeConfig(
      [
        "notify:",
        "  web_push:",
        "    subject: mailto:ops@example.com",
        "  email:",
        "    host: smtp.example.com",
        "    username: heel",
        "    password_file: smtp-password",
        '    from: "heel <heel@example.com>"',
        "  slack:",
        "    token_file: slack-token",
      ].join("\n"),
    );
    expect(load().notify).toEqual({
      webPush: { keyFile: join(home, "vapid.json"), subject: "mailto:ops@example.com" },
      email: {
        host: "smtp.example.com",
        port: 587,
        tls: false,
        username: "heel",
        passwordFile: join(home, "smtp-password"),
        from: "heel <heel@example.com>",
      },
      slack: { tokenFile: join(home, "slack-token") },
    });
  });

  it("turns OAuth for connectors on only with an https agent_public_url", () => {
    expect(load().agentPublicUrl).toBeNull();
    writeConfig("agent_public_url: https://agents.example.com/\n");
    expect(load().agentPublicUrl).toEqual(new URL("https://agents.example.com/"));
    writeConfig("agent_public_url: http://agents.example.com/\n");
    expect(validationIssues(load)[0]?.message).toMatch(/https/);
  });

  it("rejects a web push contact that isn't mailto: or https:", () => {
    writeConfig("notify:\n  web_push:\n    subject: ops@example.com\n");
    expect(validationIssues(load)[0]?.message).toMatch(/mailto/);
  });
});
