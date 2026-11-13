/**
 * Options that point a CLI at another endpoint, identity or trust root, or
 * make it log its traffic (spec: CLI runner, "Denied: redirect or debug").
 * heel delivers one credential for one account; any of these would spend it
 * somewhere else, swap it for one the agent supplies, or print it.
 *
 * Flags come from the command line and are refused. Environment variables
 * never come from the agent at all: `heel run` sends only argv and cwd, and
 * the runner sets the variables below itself. They're listed here so D8b
 * builds the environment from one place and a test can assert none leaks in.
 */
import type { ParsedArgs } from "./cobra.ts";
import type { KnownCli } from "./credential-print.ts";

/** gh: `--hostname` (on `api`, `auth …`) sends the request to another host. */
export const GH_REDIRECT_FLAGS: readonly string[] = ["hostname"];

/**
 * Set by heel for gh and never inherited: the spec's `GH_HOST`, `GH_REPO`,
 * `GH_DEBUG` and `GH_CONFIG_DIR`, the token variables, and the ones that name
 * a program for gh to run (from `gh help environment`, gh 2.99).
 */
export const GH_RESERVED_ENV: readonly string[] = [
  "GH_HOST",
  "GH_REPO",
  "GH_DEBUG",
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_PATH",
  "GH_BROWSER",
  "GH_EDITOR",
  "GH_PAGER",
];

/**
 * kubectl: the spec's list (`--server`, `--kubeconfig`, `--kuberc`,
 * `--context`, `--cluster`, `--user`, `--token`, `--as*`, `--username`,
 * `--password`, `--insecure-skip-tls-verify`, `-v/--v`), plus the flags that
 * swap the TLS trust root or client identity for files in the agent's
 * checkout, route through another proxy, or raise logging like `-v` does.
 */
export const KUBECTL_REDIRECT_FLAGS: readonly string[] = [
  "server",
  "kubeconfig",
  "kuberc",
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
  "certificate-authority",
  "client-certificate",
  "client-key",
  "tls-server-name",
  "proxy-url",
  "cache-dir",
  "vmodule",
];

/** Set by heel for kubectl and never inherited. */
export const KUBECTL_RESERVED_ENV: readonly string[] = ["KUBECONFIG", "KUBECTL_KUBERC", "KUBERC"];

/** The redirecting options on a parsed command line, as `--name` (or `--repo` for a foreign host). */
export function redirectingOptions(cli: KnownCli, args: ParsedArgs): string[] {
  const names = cli === "gh" ? GH_REDIRECT_FLAGS : KUBECTL_REDIRECT_FLAGS;
  const found = names.filter((name) => args.flags[name] !== undefined).map((name) => `--${name}`);
  if (cli === "gh" && repoNamesOtherHost(args.flags["repo"])) found.push("--repo");
  return found;
}

/**
 * gh's `-R/--repo` takes `[HOST/]OWNER/REPO` or a URL: naming a host other
 * than github.com sends the request there.
 */
function repoNamesOtherHost(value: ParsedArgs["flags"][string] | undefined): boolean {
  if (value === undefined || value === true) return false;
  const values = Array.isArray(value) ? value : [value];
  return values.some((repo) => {
    const host = repoHost(repo);
    return host !== undefined && host !== "github.com";
  });
}

/** The host a gh `--repo` value names, lower-cased; undefined for plain `OWNER/REPO`. */
export function repoHost(repo: string): string | undefined {
  if (repo.includes("://")) {
    try {
      return new URL(repo).hostname.toLowerCase();
    } catch {
      // Not a URL gh could use either; treat the whole value as a foreign host.
      return repo.toLowerCase();
    }
  }
  const parts = repo.split("/");
  return parts.length >= 3 ? (parts[0] as string).toLowerCase() : undefined;
}
