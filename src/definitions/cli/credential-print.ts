/**
 * Commands that print a credential (spec: CLI runner, "Hard denies: print
 * credentials", I-31). D8b refuses these before rules run, so no rule, not
 * even a broad allow, can let one through.
 *
 * Detection runs on the parsed command, never on the raw argv, so flag order,
 * `--flag=value` vs `--flag value`, shorthand clusters and aliases all resolve
 * to the same verdict (I-32). Where heel can't tell whether a command names a
 * Secret (a manifest file, a kustomization, a raw API path), the command is
 * treated as one that does.
 */
import type { CliFlagValue } from "../../core/call.ts";
import type { ParsedArgs } from "./cobra.ts";

export type KnownCli = "gh" | "kubectl";

export interface CredentialPrintForm {
  /** Stable id, shown in the deny reason and audit. */
  readonly id: string;
  readonly cli: KnownCli;
  /** Canonical command path. */
  readonly path: readonly string[];
  /** Prints only when one of these bool flags is on. Absent: the command always prints. */
  readonly whenFlag?: readonly string[];
  /** Prints when the objects the command names may be Secrets. */
  readonly whenSecrets?: true;
}

/**
 * Every form in the spec's table, plus the kubectl commands that return a
 * whole Secret object the same way `get` does (`edit`, `apply
 * view-last-applied`, and `set env --resolve`, which resolves Secret values).
 */
export const CREDENTIAL_PRINT_FORMS: readonly CredentialPrintForm[] = [
  { id: "gh auth token", cli: "gh", path: ["auth", "token"] },
  {
    id: "gh auth status --show-token",
    cli: "gh",
    path: ["auth", "status"],
    whenFlag: ["show-token"],
  },
  {
    id: "kubectl config view --raw",
    cli: "kubectl",
    path: ["config", "view"],
    whenFlag: ["raw", "flatten"],
  },
  { id: "kubectl create token", cli: "kubectl", path: ["create", "token"] },
  { id: "kubectl get secret", cli: "kubectl", path: ["get"], whenSecrets: true },
  { id: "kubectl describe secret", cli: "kubectl", path: ["describe"], whenSecrets: true },
  { id: "kubectl proxy", cli: "kubectl", path: ["proxy"] },
  { id: "kubectl port-forward", cli: "kubectl", path: ["port-forward"] },
  { id: "kubectl edit secret", cli: "kubectl", path: ["edit"], whenSecrets: true },
  {
    id: "kubectl apply view-last-applied secret",
    cli: "kubectl",
    path: ["apply", "view-last-applied"],
    whenSecrets: true,
  },
  { id: "kubectl set env --resolve", cli: "kubectl", path: ["set", "env"], whenFlag: ["resolve"] },
];

/**
 * Any other kubectl command that writes the object back (`-o yaml`, `-o
 * jsonpath=…`) prints a Secret's data when it names one: `kubectl label
 * secret x a=b -o yaml` returns the whole Secret. `-o name` prints only names.
 */
export const KUBECTL_OUTPUT_OF_SECRET = "kubectl <verb> secret --output";

/** The form `args` matches, if the command would print a credential. */
export function credentialPrintForm(
  cli: KnownCli,
  args: ParsedArgs,
): CredentialPrintForm | undefined {
  if (args.help) return undefined;
  const form = CREDENTIAL_PRINT_FORMS.find(
    (candidate) => candidate.cli === cli && samePath(candidate.path, args.path),
  );
  if (form !== undefined && formApplies(form, args)) return form;
  if (cli === "kubectl" && printsObjects(args.flags["output"]) && mayNameSecrets(args)) {
    return { id: KUBECTL_OUTPUT_OF_SECRET, cli, path: args.path, whenSecrets: true };
  }
  return undefined;
}

function formApplies(form: CredentialPrintForm, args: ParsedArgs): boolean {
  if (form.whenFlag !== undefined && !form.whenFlag.some((flag) => args.flags[flag] === true)) {
    return false;
  }
  if (form.whenSecrets === true) return mayNameSecrets(args);
  return true;
}

function printsObjects(output: CliFlagValue | undefined): boolean {
  if (output === undefined) return false;
  const values = Array.isArray(output) ? output : [output];
  // pflag keeps the last value of a repeated string flag.
  const last = values[values.length - 1];
  return last !== "name";
}

/**
 * True when the resources a kubectl command names may include Secrets: a
 * `secret`/`secrets` type in `TYPE[,TYPE…] [NAME…]` or `TYPE/NAME` form (with
 * any `.version.group` suffix), or a source heel can't read ahead of time
 * (`-f`, `-k`, `--raw`).
 */
export function mayNameSecrets(args: ParsedArgs): boolean {
  const { flags } = args;
  if (flags["filename"] !== undefined || flags["kustomize"] !== undefined) return true;
  if (flags["raw"] !== undefined && flags["raw"] !== "false") return true;
  return resourceTypes(args).some(isSecretType);
}

/** The resource types named by kubectl's positional arguments. */
export function resourceTypes(args: ParsedArgs): string[] {
  const positionals =
    args.argsLenAtDash === undefined
      ? args.positionals
      : args.positionals.slice(0, args.argsLenAtDash);
  if (positionals.some((arg) => arg.includes("/"))) {
    return positionals
      .filter((arg) => arg.includes("/"))
      .map((arg) => arg.slice(0, arg.indexOf("/")));
  }
  return positionals[0]?.split(",") ?? [];
}

function isSecretType(type: string): boolean {
  const resource = type.trim().toLowerCase().split(".")[0];
  return resource === "secret" || resource === "secrets";
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}
