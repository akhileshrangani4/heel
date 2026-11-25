import type { CliFields } from "../../core/call.ts";
import type { ParseFailureReason } from "./cobra.ts";

/** A command line as heel receives it: the configured CLI name, then its arguments. */
export type CliArgv = readonly [command: string, ...args: string[]];

/**
 * Why heel won't run a command whatever the rules say. heel checks these
 * before rules, so a broad `allow` can't reach them (I-31).
 */
export type CliRefusal =
  /** heel can't tell what the command does: an unknown flag, command, plugin or alias. */
  | { readonly kind: "unparseable"; readonly reason: ParseFailureReason; readonly detail: string }
  /** The command prints a credential. */
  | { readonly kind: "prints_credentials"; readonly form: string }
  /** The command would talk to another endpoint or as another identity, or log credentials. */
  | { readonly kind: "redirects_endpoint"; readonly option: string }
  /**
   * An argument names a repo heel can't pin to the one rules check: a URL
   * form gh reads that heel doesn't, or a repo other than `-R`'s.
   */
  | { readonly kind: "ambiguous_repo"; readonly argument: string }
  /** The command runs git in the agent's checkout with the credential set. */
  | { readonly kind: "runs_repo_code"; readonly command: string };

/** What heel derives from a command line before any rule sees it. */
export interface CliNormalization {
  /** `Call.cli`: what rules match with `command`, `verb`, `subcommand`, `flags` and `argv`. */
  readonly cli: CliFields;
  /** Set only by a built-in definition (I-20). */
  readonly action?: string;
  readonly kind?: "read" | "write";
  /** `owner/name`, lower-cased, for GitHub commands that name one. */
  readonly repo?: string;
  /** The command creates access that outlives revocation (I-70). */
  readonly persistence?: true;
  /** The command takes `--repo` (gh); heel requires it, so `repo` is always known. */
  readonly takesRepo?: true;
  /**
   * For `gh pr merge`: the pull request it names, when heel can read it as a
   * number or a github.com pull request URL (which also names the repo).
   */
  readonly pull?: { readonly number: number; readonly repo?: string };
  /** A bare `--` was given; heel can't add a flag after it. */
  readonly dashDash?: true;
  /** The program would print its help and run nothing. */
  readonly help: boolean;
  readonly refusals: readonly CliRefusal[];
}
