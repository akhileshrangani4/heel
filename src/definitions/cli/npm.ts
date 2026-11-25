import { parseHostPort } from "../../runner/egress.ts";
import { SANDBOX_CA_PATH, SANDBOX_RUN } from "../../runner/plan.ts";

/**
 * What heel gives `npm` in the sandbox when its account has credential hosts.
 * npm reads its token from a
 * config file, not the environment, so heel writes one: for each credential
 * host, `//<host>[:port]/:_authToken=<placeholder>`. npm then sends
 * `Authorization: Bearer <placeholder>` to that host (npm-registry-fetch, for
 * every registry path on it), and heel's egress proxy swaps in the token.
 *
 * The file is npm's user config (`NPM_CONFIG_USERCONFIG`), read-only under
 * `/heel/run`. It also names the sandbox's CA bundle as `cafile`, which npm
 * would otherwise take from `NODE_EXTRA_CA_CERTS`. A project `.npmrc` in the
 * work root, or a flag, still beats it (npm's own precedence); none of that
 * can reach the token, which never enters the sandbox: at most it sends npm
 * somewhere without the placeholder, or with another value the proxy refuses.
 */

/** The file's name under `/heel/run`. */
export const NPMRC_FILE = "npmrc";

/** Variables heel sets for npm; an operator's credential variable can't be one of them. */
export const NPM_ENV = { NPM_CONFIG_USERCONFIG: `${SANDBOX_RUN}/${NPMRC_FILE}` } as const;

/** Pure: an npm config variable name, in either spelling npm reads. */
export function isNpmConfigEnv(name: string): boolean {
  return name.toLowerCase().startsWith("npm_config_");
}

/**
 * npm's key for a host: `//host/` for port 443 (npm leaves the default port
 * out), `//host:port/` otherwise, with an IPv6 literal in brackets.
 */
export function npmRegistryKey(entry: string): string {
  const target = parseHostPort(entry, 443);
  if (target === undefined) throw new Error(`bad credential host ${entry}`);
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return target.port === 443 ? `//${host}/` : `//${host}:${target.port}/`;
}

/** Pure: the user config heel writes for npm. */
export function npmUserConfig(hosts: readonly string[], placeholder: string): string {
  return [
    "; Written by heel. The tokens here are placeholders: heel adds the real one on the wire.",
    ...hosts.map((host) => `${npmRegistryKey(host)}:_authToken=${placeholder}`),
    `cafile=${SANDBOX_CA_PATH}`,
    "",
  ].join("\n");
}
