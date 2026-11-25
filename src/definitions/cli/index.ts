/**
 * The CLI runner's command-line normalization. `gh` and
 * `kubectl` are parsed; every other command is unknown, so rules see only its
 * raw `argv` and nothing runs until a rule allows it (I-33).
 *
 * No command line is ever interpreted by a shell: `sh -c "gh auth token"` is
 * the command `sh` with two arguments, not a `gh` call (I-30).
 */

import type { CommandReading } from "../../core/rules/cases.ts";
import { normalizeGh } from "./gh.ts";
import { normalizeKubectl } from "./kubectl.ts";
import type { CliArgv, CliNormalization, CliRefusal } from "./types.ts";

export type { CliArgv, CliNormalization, CliRefusal } from "./types.ts";

// A Map, not an object literal, so `argv[0] = "toString"` can't reach a prototype method.
export const KNOWN_CLIS: ReadonlyMap<string, (argv: CliArgv) => CliNormalization> = new Map([
  ["gh", normalizeGh],
  ["kubectl", normalizeKubectl],
]);

/** Normalizes a command line by its configured command name (`argv[0]`). */
export function normalizeCliArgv(argv: CliArgv): CliNormalization {
  const known = KNOWN_CLIS.get(argv[0]);
  if (known !== undefined) return known(argv);
  return { cli: { command: argv[0], flags: {}, argv: [...argv] }, help: false, refusals: [] };
}

/**
 * Reads a command line as `heel run` does before any rule sees it, for
 * `heel rules test` cases written as `argv`: the same facts, and the same
 * refusals with a reason a person can act on. A `gh pr merge` gets no
 * `args.base` or `github.workflow.merge` here, since those need GitHub.
 */
export function readCommand(argv: CliArgv): CommandReading {
  const normalized = normalizeCliArgv(argv);
  const [refusal] = normalized.refusals;
  if (refusal !== undefined) return { ok: false, message: describeRefusal(refusal) };
  if (normalized.takesRepo === true && normalized.repo === undefined) {
    return { ok: false, message: "gh commands need -R <owner>/<repo>" };
  }
  if (
    normalized.action === "github.merge" &&
    (normalized.pull === undefined || normalized.dashDash === true)
  ) {
    return { ok: false, message: "gh pr merge needs a pull request number or URL" };
  }
  return {
    ok: true,
    cli: normalized.cli,
    ...(normalized.action === undefined ? {} : { action: normalized.action }),
    ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
    ...(normalized.repo === undefined ? {} : { repo: normalized.repo }),
    ...(normalized.persistence === true ? { persistence: true as const } : {}),
  };
}

function describeRefusal(refusal: CliRefusal): string {
  switch (refusal.kind) {
    case "unparseable":
      return `heel can't tell what it does (${refusal.detail})`;
    case "prints_credentials":
      return `it prints a credential (${refusal.form})`;
    case "redirects_endpoint":
      return `${refusal.option} would send it to another endpoint or identity`;
    case "ambiguous_repo":
      return `${refusal.argument} names a repo heel can't pin to -R`;
    case "runs_repo_code":
      return `${refusal.command} runs code from the checkout`;
  }
}
