import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kubeconfigServers } from "../../src/definitions/cli/settings.ts";
import { findAccount } from "../../src/store/directory.ts";
import { connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { testStore } from "../helpers/store.ts";

/** `heel connect cli` (D8b): what a CLI account stores, and what it refuses. */

/** A real binary on this host, as `--bin` must be. */
const BIN = realpathSync(process.execPath);

const KUBECONFIG = `apiVersion: v1
clusters:
  - name: prod
    cluster: { server: "https://k8s.example.test:6443" }
users:
  - name: bot
    user: { token: kube-test-token-not-real }
`;

type Cli = { command: string; bin: string; egress: string[]; credentialEnv: string | null };

function connect(cli: Cli, credential = "cli-test-token") {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const result = connectAccount(
    t.db,
    vault,
    {
      orgId: t.orgId,
      ownerId: t.ownerId,
      provider: "cli",
      alias: "tool",
      cli,
      credential: { type: "static", value: credential },
    },
    new Date(),
  );
  return { result, account: findAccount(t.db, t.orgId, "tool") };
}

describe("heel connect cli", () => {
  it("stores gh with GitHub's hosts as its egress", () => {
    const { result, account } = connect({
      command: "gh",
      bin: BIN,
      egress: [],
      credentialEnv: null,
    });
    expect(result.provider).toBe("cli:gh");
    expect(account?.settings).toEqual({
      transport: "cli",
      command: "gh",
      bin: BIN,
      egress: ["api.github.com", "github.com"],
      credentialEnv: null,
    });
  });

  it.each<[string, Cli, string?]>([
    ["a relative binary", { command: "gh", bin: "gh", egress: [], credentialEnv: null }],
    [
      "a binary that doesn't exist",
      { command: "gh", bin: "/nonexistent/gh", egress: [], credentialEnv: null },
    ],
    [
      "kubectl, whose kubeconfig the command could read",
      { command: "kubectl", bin: BIN, egress: [], credentialEnv: null },
      KUBECONFIG,
    ],
    [
      "an unknown CLI with no credential variable",
      { command: "terraform", bin: BIN, egress: [], credentialEnv: null },
    ],
    [
      "a command name with a slash",
      { command: "../gh", bin: BIN, egress: [], credentialEnv: null },
    ],
  ])("refuses %s", (_label, cli, credential) => {
    expect(() => connect(cli, credential)).toThrow();
  });

  it("reads a kubeconfig's API servers as egress hosts", () => {
    expect(kubeconfigServers(KUBECONFIG)).toEqual(["k8s.example.test:6443"]);
    expect(kubeconfigServers("clusters:\n  - cluster: { server: http://x }\n")).toBeNull();
    expect(kubeconfigServers("not: [yaml")).toBeNull();
  });
});
