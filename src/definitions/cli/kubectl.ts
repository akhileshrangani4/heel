/**
 * `kubectl` command lines → the fields rules see (spec: CLI runner, "Parsing
 * known CLIs"). The global flag table resolves `-n prod delete pod x` to
 * `delete`; unknown flags and unknown verbs (plugins, kuberc aliases) come
 * back unparseable. The verb is the action (`kubectl.delete`), and `-n`
 * stays in `flags.namespace`.
 */
import { type ParsedArgs, parseCobraArgs } from "./cobra.ts";
import { credentialPrintForm } from "./credential-print.ts";
import { KUBECTL_TABLE } from "./generated/kubectl-table.ts";
import { redirectingOptions } from "./redirect.ts";
import { cliFields, unparseable } from "./shared.ts";
import type { CliArgv, CliNormalization, CliRefusal } from "./types.ts";

/**
 * Commands that only read: from the cluster, or from heel's own generated
 * kubeconfig. Keyed by canonical path. Anything else is a write.
 */
export const KUBECTL_READS: ReadonlySet<string> = new Set([
  "get",
  "describe",
  "logs",
  "explain",
  "api-resources",
  "api-versions",
  "cluster-info",
  "cluster-info dump",
  "top node",
  "top pod",
  "version",
  "events",
  "diff",
  "wait",
  "auth can-i",
  "auth whoami",
  "rollout history",
  "rollout status",
  "config view",
  "config current-context",
  "config get-clusters",
  "config get-contexts",
  "config get-users",
]);

export function normalizeKubectl(argv: CliArgv): CliNormalization {
  const [, ...args] = argv;
  const parsed = parseCobraArgs(KUBECTL_TABLE, args);
  if (!parsed.ok) return unparseable(argv, parsed);
  const { args: kubectl } = parsed;
  const verb = kubectl.path[0];
  return {
    cli: cliFields(argv, kubectl),
    ...(verb !== undefined && {
      action: `kubectl.${verb}`,
      kind: KUBECTL_READS.has(kubectl.path.join(" ")) ? ("read" as const) : ("write" as const),
    }),
    help: kubectl.help,
    refusals: kubectlRefusals(kubectl),
  };
}

function kubectlRefusals(kubectl: ParsedArgs): CliRefusal[] {
  if (kubectl.help) return [];
  const refusals: CliRefusal[] = [];
  const form = credentialPrintForm("kubectl", kubectl);
  if (form !== undefined) refusals.push({ kind: "prints_credentials", form: form.id });
  for (const option of redirectingOptions("kubectl", kubectl)) {
    refusals.push({ kind: "redirects_endpoint", option });
  }
  return refusals;
}
