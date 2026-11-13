import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PRINT_FORMS,
  KUBECTL_OUTPUT_OF_SECRET,
} from "../../src/definitions/cli/credential-print.ts";
import { GH_TABLE } from "../../src/definitions/cli/generated/gh-table.ts";
import { KUBECTL_TABLE } from "../../src/definitions/cli/generated/kubectl-table.ts";
import { type CliArgv, normalizeCliArgv } from "../../src/definitions/cli/index.ts";
import { type CobraCommandLine, cobraOrderings } from "../helpers/cli-argv.ts";

const printsAs = (argv: CliArgv): string | undefined => {
  const refusal = normalizeCliArgv(argv).refusals.find((r) => r.kind === "prints_credentials");
  return refusal?.kind === "prints_credentials" ? refusal.form : undefined;
};

const NAMESPACE = [["-n", "prod"], ["-nprod"], ["--namespace", "prod"], ["--namespace=prod"]];

/** Each form in the spec's "Hard denies: print credentials" row, with flags to shuffle around it. */
const SPEC_FORMS: readonly (readonly [form: string, line: CobraCommandLine])[] = [
  [
    "gh auth token",
    {
      command: "gh",
      path: ["auth", "token"],
      late: [[["-u", "alice"], ["--user", "alice"], ["--user=alice"]]],
    },
  ],
  [
    "gh auth status --show-token",
    {
      command: "gh",
      path: ["auth", "status"],
      late: [
        [["-t"], ["--show-token"], ["--show-token=true"]],
        [["-a"], ["--active"]],
      ],
    },
  ],
  [
    "kubectl config view --raw",
    {
      command: "kubectl",
      path: ["config", "view"],
      early: [NAMESPACE],
      late: [[["--raw"], ["--raw=true"]], [["--minify"]], [["-o", "yaml"], ["--output=json"]]],
    },
  ],
  [
    "kubectl config view --raw",
    {
      command: "kubectl",
      path: ["config", "view"],
      late: [[["--flatten"], ["--flatten=true"]], [["--minify"]]],
    },
  ],
  [
    "kubectl create token",
    {
      command: "kubectl",
      path: ["create", "token"],
      early: [NAMESPACE],
      late: [[["--duration", "1h"], ["--duration=1h"]]],
      positionals: ["builder"],
    },
  ],
  [
    "kubectl get secret",
    {
      command: "kubectl",
      path: ["get"],
      early: [NAMESPACE],
      late: [[["-o", "yaml"], ["-oyaml"], ["--output=json"]], [["--show-labels"]]],
      positionals: ["secrets"],
    },
  ],
  [
    "kubectl get secret",
    {
      command: "kubectl",
      path: ["get"],
      early: [NAMESPACE],
      late: [[["-o", "yaml"]]],
      positionals: ["secret/db"],
    },
  ],
  [
    "kubectl describe secret",
    {
      command: "kubectl",
      path: ["describe"],
      early: [NAMESPACE],
      late: [[["-l", "app=web"]]],
      positionals: ["secret"],
    },
  ],
  [
    "kubectl proxy",
    {
      command: "kubectl",
      path: ["proxy"],
      early: [NAMESPACE],
      late: [[["-p", "8001"], ["--port=8001"]]],
    },
  ],
  [
    "kubectl port-forward",
    {
      command: "kubectl",
      path: ["port-forward"],
      early: [NAMESPACE],
      late: [[["--address", "127.0.0.1"], ["--address=127.0.0.1"]]],
      positionals: ["pod/db", "5432:5432"],
    },
  ],
];

describe("I-30: no shell", () => {
  it("I-30: `sh -c 'gh auth token'` is the command sh, never the gh call inside it", () => {
    for (const shell of ["sh", "bash", "/bin/sh"]) {
      const wrapped = normalizeCliArgv([shell, "-c", "gh auth token"]);
      expect(wrapped.cli).toEqual({
        command: shell,
        flags: {},
        argv: [shell, "-c", "gh auth token"],
      });
      expect(wrapped.action).toBeUndefined();
      expect(wrapped.kind).toBeUndefined();
      expect(wrapped.refusals).toEqual([]);
    }
  });

  it("I-30: a command name is matched whole, never split on spaces", () => {
    const joined = normalizeCliArgv(["gh auth token"]);
    expect(joined.cli.command).toBe("gh auth token");
    expect(joined.refusals).toEqual([]);
    expect(joined.action).toBeUndefined();
  });
});

describe("I-31: commands that print credentials", () => {
  it.each(SPEC_FORMS)("I-31: %s is detected in every flag order", (form, line) => {
    fc.assert(
      fc.property(cobraOrderings(line), (argv) => {
        expect(printsAs(argv)).toBe(form);
      }),
      { numRuns: 150 },
    );
  });

  it("I-31: the spec's short spellings are detected", () => {
    expect(printsAs(["gh", "auth", "status", "-t"])).toBe("gh auth status --show-token");
    expect(printsAs(["kubectl", "get", "secrets"])).toBe("kubectl get secret");
    expect(printsAs(["kubectl", "describe", "secrets", "db"])).toBe("kubectl describe secret");
    expect(printsAs(["kubectl", "get", "pods,secrets"])).toBe("kubectl get secret");
    expect(printsAs(["kubectl", "get", "secrets.v1."])).toBe("kubectl get secret");
    expect(printsAs(["kubectl", "get", "pod/web", "secret/db"])).toBe("kubectl get secret");
  });

  it("I-31: a get that may name a Secret through a file, kustomization or raw path is refused", () => {
    for (const args of [
      ["get", "-f", "manifests/"],
      ["get", "-k", "overlays/prod"],
      ["get", "--raw", "/api/v1/namespaces/prod/secrets/db"],
    ]) {
      expect(printsAs(["kubectl", ...args]), args.join(" ")).toBe("kubectl get secret");
    }
  });

  it("I-31: commands that return a whole Secret object the way get does are refused", () => {
    expect(printsAs(["kubectl", "edit", "secret", "db"])).toBe("kubectl edit secret");
    expect(printsAs(["kubectl", "apply", "view-last-applied", "secret/db"])).toBe(
      "kubectl apply view-last-applied secret",
    );
    expect(printsAs(["kubectl", "set", "env", "deploy/web", "--resolve", "--list"])).toBe(
      "kubectl set env --resolve",
    );
    expect(printsAs(["kubectl", "label", "secret", "db", "a=b", "-o", "yaml"])).toBe(
      KUBECTL_OUTPUT_OF_SECRET,
    );
  });

  it("I-31: the classification holds even when the command also redirects", () => {
    const both = normalizeCliArgv(["gh", "auth", "token", "--hostname", "evil.example"]);
    expect(both.refusals).toEqual(
      expect.arrayContaining([
        { kind: "prints_credentials", form: "gh auth token" },
        { kind: "redirects_endpoint", option: "--hostname" },
      ]),
    );
  });

  it.each([
    ["gh", "auth", "status"],
    ["gh", "auth", "status", "--show-token=false"],
    ["gh", "auth", "status", "-t", "--show-token=false"],
    ["gh", "pr", "view", "1"],
    ["kubectl", "config", "view"],
    ["kubectl", "config", "view", "--raw=false"],
    ["kubectl", "get", "pods", "-o", "yaml"],
    ["kubectl", "get", "configmaps"],
    ["kubectl", "describe", "pod", "secret-rotator"],
    ["kubectl", "label", "secret", "db", "a=b"],
    ["kubectl", "label", "secret", "db", "a=b", "-o", "name"],
    ["kubectl", "set", "env", "deploy/web", "--list"],
  ] as const)("%j prints no credential", (...argv) => {
    expect(printsAs(argv)).toBeUndefined();
  });

  it("help prints usage, not a credential, so it isn't refused", () => {
    expect(normalizeCliArgv(["gh", "auth", "token", "--help"])).toMatchObject({
      help: true,
      refusals: [],
    });
    expect(normalizeCliArgv(["kubectl", "get", "secrets", "-h"])).toMatchObject({
      help: true,
      refusals: [],
    });
    expect(printsAs(["gh", "auth", "token", "--help=false"])).toBe("gh auth token");
  });

  it("every form's command path exists in its CLI's generated table", () => {
    for (const form of CREDENTIAL_PRINT_FORMS) {
      const table = form.cli === "gh" ? GH_TABLE : KUBECTL_TABLE;
      expect(Object.hasOwn(table.commands, form.path.join(" ")), form.id).toBe(true);
    }
  });

  it("every form in the spec's table is in the deny list", () => {
    const ids = new Set(CREDENTIAL_PRINT_FORMS.map((form) => form.id));
    for (const [form] of SPEC_FORMS) expect(ids.has(form), form).toBe(true);
  });
});
