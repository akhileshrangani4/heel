import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KUBECTL_TABLE } from "../../src/definitions/cli/generated/kubectl-table.ts";
import { normalizeCliArgv } from "../../src/definitions/cli/index.ts";
import { KUBECTL_READS, normalizeKubectl } from "../../src/definitions/cli/kubectl.ts";
import {
  KUBECTL_REDIRECT_FLAGS,
  KUBECTL_RESERVED_ENV,
} from "../../src/definitions/cli/redirect.ts";
import { cobraOrderings, meaning } from "../helpers/cli-argv.ts";

const kubectl = (...args: string[]) => normalizeKubectl(["kubectl", ...args]);

const ROOT_FLAGS = new Map(
  (KUBECTL_TABLE.commands[""]?.persistent ?? []).map((flag) => [flag[0], flag]),
);

describe("kubectl: finding the verb", () => {
  it("I-32: `-n prod delete pod x` parses as delete, with the namespace in flags", () => {
    const remove = kubectl("-n", "prod", "delete", "pod", "x");
    expect(remove.cli).toMatchObject({
      command: "kubectl",
      verb: "delete",
      flags: { namespace: "prod" },
    });
    expect(remove).toMatchObject({ action: "kubectl.delete", kind: "write", refusals: [] });
  });

  it("I-32: every order and spelling kubectl accepts for one delete means the same call", () => {
    const expected = meaning(
      kubectl("delete", "pod", "x", "--namespace", "prod", "--wait=false", "--force"),
    );
    fc.assert(
      fc.property(
        cobraOrderings({
          command: "kubectl",
          path: ["delete"],
          early: [
            [
              ["-n", "prod"],
              ["-nprod"],
              ["-n=prod"],
              ["--namespace", "prod"],
              ["--namespace=prod"],
            ],
          ],
          // `--wait` is a bool: `--wait false` would make `false` a positional.
          late: [[["--wait=false"]], [["--force"], ["--force=true"]]],
          positionals: ["pod", "x"],
        }),
        (argv) => {
          expect(meaning(normalizeKubectl(argv))).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("reads `--all_namespaces` as `--all-namespaces`, as kubectl does", () => {
    expect(kubectl("get", "pods", "--all_namespaces").cli.flags).toEqual({
      "all-namespaces": true,
    });
  });

  it("keeps every value of a repeated flag, in order, wherever each appears", () => {
    expect(kubectl("get", "pods", "-l", "a=b", "--selector=c=d").cli.flags).toEqual({
      selector: ["a=b", "c=d"],
    });
  });

  it("denies plugins and kuberc aliases: they aren't built-in verbs", () => {
    for (const args of [["foo-plugin"], ["ns", "prod"], ["krew", "install", "x"]]) {
      expect(kubectl(...args).refusals).toEqual([
        expect.objectContaining({ kind: "unparseable", reason: "unknown_command" }),
      ]);
    }
  });

  it("denies a flag kubectl doesn't define, rather than guessing its arity", () => {
    expect(kubectl("get", "pods", "--no-such-flag", "x").refusals).toEqual([
      expect.objectContaining({ kind: "unparseable", reason: "unknown_flag" }),
    ]);
    // `--flatten` is local to `config view`; before `view`, kubectl itself rejects it.
    expect(kubectl("config", "--flatten", "view").refusals).toEqual([
      expect.objectContaining({ kind: "unparseable", reason: "unknown_flag" }),
    ]);
  });

  it("marks --help as help: kubectl prints usage and runs nothing", () => {
    expect(kubectl("delete", "pod", "x", "-h")).toMatchObject({ help: true, refusals: [] });
  });
});

describe("kubectl: actions", () => {
  it.each([
    [["get", "pods"], "kubectl.get", "read"],
    [["describe", "node", "n1"], "kubectl.describe", "read"],
    [["logs", "pod/x"], "kubectl.logs", "read"],
    [["rollout", "status", "deploy/web"], "kubectl.rollout", "read"],
    [["rollout", "restart", "deploy/web"], "kubectl.rollout", "write"],
    [["apply", "-f", "web.yaml"], "kubectl.apply", "write"],
    [["scale", "deploy/web", "--replicas=0"], "kubectl.scale", "write"],
  ] as const)("%j is %s (%s)", (args, action, kind) => {
    expect(kubectl(...args)).toMatchObject({ action, kind });
  });

  it("maps exec, cp, debug and attach to their own write actions, for rules to deny by default", () => {
    for (const [args, action] of [
      [["exec", "web-0", "--", "sh"], "kubectl.exec"],
      [["cp", "web-0:/etc/passwd", "./passwd"], "kubectl.cp"],
      [["debug", "node/n1", "-it", "--image=busybox"], "kubectl.debug"],
      [["attach", "web-0"], "kubectl.attach"],
    ] as const) {
      expect(kubectl(...args)).toMatchObject({ action, kind: "write" });
    }
  });

  it("every read path exists in the kubectl table", () => {
    for (const path of KUBECTL_READS) {
      expect(Object.hasOwn(KUBECTL_TABLE.commands, path), path).toBe(true);
    }
  });

  it("dispatches by argv[0]: normalizeCliArgv routes kubectl to this parser", () => {
    expect(meaning(normalizeCliArgv(["kubectl", "get", "pods"]))).toEqual(
      meaning(kubectl("get", "pods")),
    );
  });
});

describe("kubectl: redirect and debug flags", () => {
  const SPEC_REDIRECTS = [
    "server",
    "kubeconfig",
    "context",
    "cluster",
    "user",
    "token",
    "as",
    "as-group",
    "as-uid",
    "as-user-extra",
    "username",
    "password",
    "insecure-skip-tls-verify",
    "v",
  ];

  it("lists every redirect flag the spec names", () => {
    for (const name of [...SPEC_REDIRECTS, "kuberc"])
      expect(KUBECTL_REDIRECT_FLAGS).toContain(name);
  });

  it.each(KUBECTL_REDIRECT_FLAGS.filter((name) => name !== "kuberc"))(
    "detects --%s before or after the verb",
    (name) => {
      const def = ROOT_FLAGS.get(name);
      expect(def, `--${name} is a kubectl root flag`).toBeDefined();
      const spelled = def?.[2] === "bool" ? [`--${name}`] : [`--${name}=x`];
      for (const argv of [
        [...spelled, "get", "pods"],
        ["get", ...spelled, "pods"],
        ["get", "pods", ...spelled],
      ]) {
        expect(kubectl(...argv).refusals).toContainEqual({
          kind: "redirects_endpoint",
          option: `--${name}`,
        });
      }
    },
  );

  it("detects the shorthands -s (server) and -v (verbosity)", () => {
    expect(kubectl("-s", "https://evil.example", "get", "pods").refusals).toContainEqual({
      kind: "redirects_endpoint",
      option: "--server",
    });
    expect(kubectl("get", "pods", "-v", "9").refusals).toContainEqual({
      kind: "redirects_endpoint",
      option: "--v",
    });
  });

  it("refuses --kuberc: heel runs kubectl with kuberc disabled, where the flag doesn't exist", () => {
    expect(ROOT_FLAGS.has("kuberc")).toBe(false);
    for (const argv of [
      ["--kuberc", "/tmp/k", "get", "pods"],
      ["get", "pods", "--kuberc=/tmp/k"],
    ]) {
      expect(kubectl(...argv).refusals).toEqual([
        expect.objectContaining({ kind: "unparseable", reason: "unknown_flag" }),
      ]);
    }
  });

  it("reserves KUBECONFIG and KUBECTL_KUBERC: heel sets them, never the agent", () => {
    expect(KUBECTL_RESERVED_ENV).toEqual(expect.arrayContaining(["KUBECONFIG", "KUBECTL_KUBERC"]));
  });

  it("an ordinary namespaced read carries no refusal", () => {
    expect(kubectl("-n", "prod", "get", "pods", "-o", "wide").refusals).toEqual([]);
  });
});
