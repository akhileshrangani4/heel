/**
 * `gh` command lines → the fields rules see (spec: CLI runner, "Parsing known
 * CLIs"). The verb comes from cobra's own resolution against the generated
 * table, so flags before the verb (`gh -R o/r pr merge`) and aliases (`gh pr
 * co`) resolve as gh would; config aliases and extensions aren't in the table
 * and come back unparseable.
 */
import type { CliFlagValue } from "../../core/call.ts";
import { type ParsedArgs, parseCobraArgs } from "./cobra.ts";
import { credentialPrintForm } from "./credential-print.ts";
import { GH_TABLE } from "./generated/gh-table.ts";
import {
  GH_MERGE_BYPASS_FLAGS,
  GH_PERSISTENCE,
  GH_RUNS_REPO_CODE,
  ghCommandMapping,
} from "./gh-actions.ts";
import { redirectingOptions, repoHost } from "./redirect.ts";
import { cliFields, unparseable } from "./shared.ts";
import type { CliArgv, CliNormalization, CliRefusal } from "./types.ts";

export function normalizeGh(argv: CliArgv): CliNormalization {
  const [, ...args] = argv;
  const parsed = parseCobraArgs(GH_TABLE, args);
  if (!parsed.ok) return unparseable(argv, parsed);
  const { args: gh } = parsed;
  const key = gh.path.join(" ");
  const mapping = ghCommandMapping(gh.path);
  const repo = ghRepo(gh.flags["repo"]);
  return {
    cli: cliFields(argv, gh),
    ...(mapping !== undefined && { action: mapping.action, kind: mapping.kind }),
    ...(repo !== undefined && { repo }),
    ...(GH_PERSISTENCE.has(key) && { persistence: true as const }),
    help: gh.help,
    refusals: ghRefusals(gh),
  };
}

function ghRefusals(gh: ParsedArgs): CliRefusal[] {
  if (gh.help) return [];
  const refusals: CliRefusal[] = [];
  const form = credentialPrintForm("gh", gh);
  if (form !== undefined) refusals.push({ kind: "prints_credentials", form: form.id });
  for (const option of redirectingOptions("gh", gh)) {
    refusals.push({ kind: "redirects_endpoint", option });
  }
  const key = gh.path.join(" ");
  if (GH_RUNS_REPO_CODE.has(key)) refusals.push({ kind: "runs_repo_code", command: `gh ${key}` });
  return refusals;
}

/**
 * The `owner/name` a `--repo` value names on github.com, lower-cased (GitHub
 * names are case-insensitive, so `Acme/Web` must meet a rule on `acme/web`).
 * A foreign host is a redirect refusal, not a repo.
 */
export function normalizeGhRepo(value: string): string | undefined {
  const host = repoHost(value);
  if (host !== undefined && host !== "github.com") return undefined;
  let path = value;
  if (value.includes("://")) {
    try {
      path = new URL(value).pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else if (host !== undefined) {
    path = value.slice(value.indexOf("/") + 1);
  }
  const [owner, name] = path.replace(/\.git$/, "").split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "") return undefined;
  return `${owner}/${name}`.toLowerCase();
}

function ghRepo(value: CliFlagValue | undefined): string | undefined {
  if (value === undefined || value === true) return undefined;
  // pflag keeps the last value of a repeated string flag.
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return last === undefined ? undefined : normalizeGhRepo(last);
}

/** The flags on a `gh pr merge` that skip required checks (denied under `checks: passing`). */
export function ghMergeBypassFlags(normalized: CliNormalization): string[] {
  if (normalized.action !== "github.merge") return [];
  return GH_MERGE_BYPASS_FLAGS.filter((flag) => normalized.cli.flags[flag] === true);
}
