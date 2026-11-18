/**
 * What each built-in `gh` command means to rules (spec: CLI runner, "Parsing
 * known CLIs", and Built-in providers, GitHub). Keyed by the canonical command
 * path from the generated table, so an alias (`gh pr co`) maps like its
 * command. This module is data only: the GitHub definition (D11) imports it
 * to keep the CLI and native tools on one action catalogue.
 *
 * A command with no entry gets no `action` and no `kind`. Rules can still
 * name it by `command`, `verb` and `argv`, and otherwise it falls to the
 * default deny: heel never guesses what an unmapped command does.
 */

export type GithubAction =
  | "github.read"
  | "github.comment"
  | "github.pr.create"
  | "github.pr.update"
  | "github.issue.create"
  | "github.issue.update"
  | "github.push"
  | "github.merge"
  | "github.api";

export interface GhCommandMapping {
  readonly action: GithubAction;
  readonly kind: "read" | "write";
}

const read: GhCommandMapping = { action: "github.read", kind: "read" };

function write(action: GithubAction): GhCommandMapping {
  return { action, kind: "write" };
}

/** Space-joined canonical path → mapping. */
export const GH_ACTIONS: Readonly<Record<string, GhCommandMapping>> = {
  "pr view": read,
  "pr list": read,
  "pr status": read,
  "pr diff": read,
  "pr checks": read,
  "issue view": read,
  "issue list": read,
  "issue status": read,
  "repo view": read,
  "repo list": read,
  "repo read-dir": read,
  "repo read-file": read,
  "run view": read,
  "run list": read,
  "run watch": read,
  "workflow view": read,
  "workflow list": read,
  "release view": read,
  "release list": read,
  "label list": read,
  "search code": read,
  "search commits": read,
  "search issues": read,
  "search prs": read,
  "search repos": read,
  "ruleset list": read,
  "ruleset view": read,
  "ruleset check": read,
  "cache list": read,
  status: read,

  "pr create": write("github.pr.create"),
  // `gh pr revert` opens a new PR that reverts the merged one.
  "pr revert": write("github.pr.create"),
  "pr edit": write("github.pr.update"),
  "pr close": write("github.pr.update"),
  "pr reopen": write("github.pr.update"),
  "pr ready": write("github.pr.update"),
  "pr lock": write("github.pr.update"),
  "pr unlock": write("github.pr.update"),
  "pr update-branch": write("github.pr.update"),
  "pr comment": write("github.comment"),
  "issue comment": write("github.comment"),
  "issue create": write("github.issue.create"),
  "issue edit": write("github.issue.update"),
  "issue close": write("github.issue.update"),
  "issue reopen": write("github.issue.update"),
  "issue lock": write("github.issue.update"),
  "issue unlock": write("github.issue.update"),
  "issue pin": write("github.issue.update"),
  "issue unpin": write("github.issue.update"),
  "pr merge": write("github.merge"),
  api: write("github.api"),
};

/**
 * Commands that create access outliving a revoked credential (I-70): deploy
 * keys, account SSH keys, and Actions secrets and variables. Denied unless a
 * rule names them.
 */
export const GH_PERSISTENCE: ReadonlySet<string> = new Set([
  "repo deploy-key add",
  "ssh-key add",
  "secret set",
  "variable set",
]);

/**
 * Commands that run git in the agent's checkout with `GH_TOKEN` set, so the
 * checkout's hooks would see the token (spec: "Denied: runs repo code").
 */
export const GH_RUNS_REPO_CODE: ReadonlySet<string> = new Set([
  "pr checkout",
  "repo clone",
  "repo sync",
]);

/** `gh pr merge` flags that skip required checks; denied under `checks: passing`. */
export const GH_MERGE_BYPASS_FLAGS: readonly string[] = ["admin", "auto"];

/** The mapping for a canonical command path, if heel knows what it does. */
export function ghCommandMapping(path: readonly string[]): GhCommandMapping | undefined {
  const key = path.join(" ");
  // Own keys only: a path like `constructor` must not reach Object.prototype.
  return Object.hasOwn(GH_ACTIONS, key) ? GH_ACTIONS[key] : undefined;
}
