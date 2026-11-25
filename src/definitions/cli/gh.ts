/**
 * `gh` command lines → the fields rules see. The verb comes from cobra's own
 * resolution against the generated
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
  const pull = mapping?.action === "github.merge" ? ghPull(gh.positionals[0]) : undefined;
  // gh takes the repo from a pull request or issue URL and ignores -R, so the URL's repo is the
  // one that runs; a -R naming another repo would have rules check the wrong one.
  const flagRepo = ghRepo(gh.flags["repo"]);
  const urls = ghUrlRepos(gh.path, gh.positionals);
  const repo = urls.repo ?? flagRepo;
  const owner = ghOwnerScope(gh);
  const conflict =
    urls.unreadable ??
    (urls.repo !== undefined && flagRepo !== undefined && urls.repo !== flagRepo
      ? urls.from
      : undefined) ??
    ghForeignIssueRef(gh, repo) ??
    ghOtherRepo(gh, repo) ??
    // gh acts on the owner and ignores -R, so a rule on the repo would check the wrong target.
    (owner !== undefined && repo !== undefined ? owner : undefined);
  return {
    cli: cliFields(argv, gh),
    ...(mapping !== undefined && { action: mapping.action, kind: mapping.kind }),
    ...(repo !== undefined && { repo }),
    ...(GH_PERSISTENCE.has(key) && { persistence: true as const }),
    ...(ghTakesRepo(gh.path) && owner === undefined && { takesRepo: true as const }),
    ...(pull !== undefined && { pull }),
    ...(gh.argsLenAtDash !== undefined && { dashDash: true as const }),
    help: gh.help,
    refusals: [
      ...ghRefusals(gh),
      ...(conflict === undefined ? [] : [{ kind: "ambiguous_repo" as const, argument: conflict }]),
    ],
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
    // WHATWG URL resolves `..`, `%2e` and `\` where Go's url.Parse doesn't, so heel and gh
    // could read different paths from one value: refuse those.
    if (/[\\%]|\/\.{1,2}(?:[/?#]|$)/.test(value)) return undefined;
    try {
      path = new URL(value).pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return undefined;
    }
    // gh's FromURL takes exactly two path segments.
    if (path.split("/").length !== 2) return undefined;
  } else if (host !== undefined) {
    path = value.slice(value.indexOf("/") + 1);
  }
  const [owner, name] = path.replace(/\.git$/, "").split("/");
  if (owner === undefined || name === undefined) return undefined;
  // GitHub's own characters only, and never a `.` or `..` that would walk the API path.
  const part = /^[A-Za-z0-9_.-]{1,100}$/;
  if (!part.test(owner) || !part.test(name) || [owner, name].some((p) => /^\.{1,2}$/.test(p))) {
    return undefined;
  }
  return `${owner}/${name}`.toLowerCase();
}

function ghRepo(value: CliFlagValue | undefined): string | undefined {
  if (value === undefined || value === true) return undefined;
  // pflag keeps the last value of a repeated string flag.
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return last === undefined ? undefined : normalizeGhRepo(last);
}

/**
 * Whether a gh command takes `--repo`, as a local flag or one inherited from
 * a parent. Without `-R`, gh reads the repo from the git remotes in the
 * agent's checkout, which a rule on `repo` can't see, so heel requires it.
 */
export function ghTakesRepo(path: readonly string[]): boolean {
  for (let i = path.length; i >= 0; i--) {
    const def = GH_TABLE.commands[path.slice(0, i).join(" ")];
    const flags =
      i === path.length
        ? [...(def?.local ?? []), ...(def?.persistent ?? [])]
        : (def?.persistent ?? []);
    if (flags.some(([name]) => name === "repo")) return true;
  }
  return false;
}

/**
 * gh reads an argument as a URL when Go's `url.Parse` finds an `http` or
 * `https` scheme, which it matches case-insensitively.
 */
const GH_URL_SCHEME = /^https?:/i;

/**
 * The one URL spelling heel maps to a repo: `http(s)://github.com/` and a
 * path. gh also accepts `www.` and any other github.com subdomain, a port,
 * userinfo, and enterprise hosts; heel refuses those rather than guess.
 * Hostnames and schemes are case-insensitive, as they are to gh. The tail
 * after the number excludes `%`, so Go's decoding can't change the path.
 */
const GH_CANONICAL_URL = /^https?:\/\/github\.com(?=\/)/i;
const GH_URL_TAIL = /^(?:[/?#][\w.~!$&'()*+,;=:@/?#-]*)?$/;

/**
 * The path segments after `<owner>/<name>/` that a command's argument parser
 * reads as naming a repo (gh's `pullURLRE` for `pr`, `issueURLRE` for
 * `issue`). Both match the path case-sensitively.
 */
function ghUrlKinds(path: readonly string[]): readonly string[] {
  if (path[0] === "pr") return ["pull"];
  if (path[0] === "issue") return ["issues", "pull"];
  return [];
}

/**
 * The repo a github.com pull request or issue URL names, as gh would read it,
 * or undefined when gh would read some other repo or host from it.
 */
export function ghUrlRepo(arg: string, kinds: readonly string[]): string | undefined {
  const prefix = GH_CANONICAL_URL.exec(arg);
  if (prefix === null) return undefined;
  const url = /^\/([^/?#]+)\/([^/?#]+)\/([a-z]+)\/[0-9]+(.*)$/.exec(arg.slice(prefix[0].length));
  if (url === null || !kinds.includes(url[3] as string) || !GH_URL_TAIL.test(url[4] as string)) {
    return undefined;
  }
  // gh keeps a `.git` in the name, where normalizeGhRepo would drop it.
  if (url[2]?.toLowerCase().endsWith(".git")) return undefined;
  return normalizeGhRepo(`${url[1]}/${url[2]}`);
}

/**
 * The repo gh takes from URL arguments, which it uses in place of `-R`. Any
 * argument gh would parse as a URL but heel can't map to exactly one
 * github.com repo is `unreadable`, as is a second URL naming another repo;
 * `from` is the argument the repo came from.
 */
function ghUrlRepos(
  path: readonly string[],
  positionals: readonly string[],
): { repo?: string; from?: string; unreadable?: string } {
  const kinds = ghUrlKinds(path);
  let found: { repo: string; from: string } | undefined;
  for (const arg of positionals) {
    if (!GH_URL_SCHEME.test(arg)) continue;
    const repo = ghUrlRepo(arg, kinds);
    if (repo === undefined || (found !== undefined && found.repo !== repo)) {
      return { unreadable: arg };
    }
    found ??= { repo, from: arg };
  }
  return found ?? {};
}

/**
 * `gh issue` flags that take another issue by number or URL (gh's
 * `ParseIssueFromArg`). A URL there reaches into its own repo, which a rule
 * on `repo` never sees.
 */
const GH_ISSUE_REF_FLAGS: readonly string[] = [
  "duplicate-of",
  "parent",
  "blocked-by",
  "blocking",
  "add-blocked-by",
  "add-blocking",
  "remove-blocked-by",
  "remove-blocking",
  "add-sub-issue",
  "remove-sub-issue",
];

/**
 * The first issue-reference flag value that isn't a plain number or a
 * github.com URL on `repo` itself. Slice flags split on commas, so each piece
 * is checked; anything else gh would refuse too.
 */
function ghForeignIssueRef(gh: ParsedArgs, repo: string | undefined): string | undefined {
  if (gh.path[0] !== "issue") return undefined;
  for (const name of GH_ISSUE_REF_FLAGS) {
    const value = gh.flags[name];
    if (value === undefined || value === true) continue;
    for (const piece of (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(","))) {
      if (/^\s*#?[0-9]+\s*$/.test(piece)) continue;
      const named = ghUrlRepo(piece.trim(), ["issues", "pull"]);
      if (named === undefined || named !== repo) return piece;
    }
  }
  return undefined;
}

/**
 * Flags that make a `secret`, `variable` or `ruleset` command act on an
 * organization or user, not a repo. gh then ignores `-R`.
 */
const GH_OWNER_SCOPE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  secret: ["org", "user", "repos", "no-repos-selected"],
  variable: ["org", "repos"],
  ruleset: ["org"],
};

/** The owner-scope flag a command was given (as `--name`), if any. */
function ghOwnerScope(gh: ParsedArgs): string | undefined {
  const flags = GH_OWNER_SCOPE_FLAGS[gh.path[0] ?? ""] ?? [];
  const given = flags.find((name) => gh.flags[name] !== undefined);
  return given === undefined ? undefined : `--${given}`;
}

/**
 * An argument naming a second repo the command acts on besides `repo`:
 * `label clone`'s source, `issue transfer`'s destination, `issue develop
 * --branch-repo`. Rules see one repo, so each must be that repo.
 */
function ghOtherRepo(gh: ParsedArgs, repo: string | undefined): string | undefined {
  const key = gh.path.join(" ");
  let other: CliFlagValue | undefined;
  if (key === "label clone") other = gh.positionals[0];
  else if (key === "issue transfer") other = gh.positionals[1];
  else if (key === "issue develop") other = gh.flags["branch-repo"];
  if (other === undefined) return undefined;
  if (other === true) return "--branch-repo";
  const values = Array.isArray(other) ? other : [other];
  return values.find((value) => {
    const named = normalizeGhRepo(value);
    return named === undefined || named !== repo;
  });
}

/**
 * The pull request a `gh pr merge` argument names: a number, or a
 * `https://github.com/<owner>/<name>/pull/<n>` URL. A branch name, or no
 * argument (the current branch's PR), is undefined: heel can't pin those.
 */
export function ghPull(arg: string | undefined): { number: number; repo?: string } | undefined {
  if (arg === undefined) return undefined;
  const plain = /^#?([1-9][0-9]{0,9})$/.exec(arg);
  if (plain !== null) return { number: Number(plain[1]) };
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})\/?$/i.exec(arg);
  if (url === null) return undefined;
  const repo = normalizeGhRepo(`${url[1]}/${url[2]}`);
  return repo === undefined ? undefined : { number: Number(url[3]), repo };
}

/** The flags on a `gh pr merge` that skip required checks (denied under `checks: passing`). */
export function ghMergeBypassFlags(normalized: CliNormalization): string[] {
  if (normalized.action !== "github.merge") return [];
  return GH_MERGE_BYPASS_FLAGS.filter((flag) => normalized.cli.flags[flag] === true);
}
