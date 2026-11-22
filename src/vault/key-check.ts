import { GitHubClient } from "../definitions/github/client.ts";
import { LinearClient } from "../definitions/linear/client.ts";
import { NotionClient } from "../definitions/notion/client.ts";
import type { FetchFn } from "../definitions/sign-in.ts";
import { SlackClient } from "../definitions/slack/client.ts";
import { StripeClient } from "../definitions/stripe/client.ts";
import { CredentialRejectedError } from "../gateway/pipeline/ports.ts";

/**
 * Checks a pasted key before heel stores it (roadmap test finding T12): one
 * cheap read that every key of that kind may make. In the setup dry run heel
 * marked four placeholder keys Connected, and the agent only found out on
 * its first call.
 *
 * - The service says the key is wrong, expired or revoked: `rejected`, and
 *   heel doesn't connect it. That key can't ever work.
 * - Anything else (no network, a 5xx, a key whose scopes don't cover the
 *   read): `unchecked`. heel connects it and says it couldn't check, since a
 *   narrowly scoped key may still be exactly right for the work.
 *
 * The key goes only to the service's own API host, by the definition's own
 * client; nothing about it is logged.
 */

export type KeyCheck =
  | { status: "ok" }
  | { status: "rejected"; message: string }
  | { status: "unchecked"; message: string };

const TIMEOUT_MS = 10_000;

/** The services checked, and the one read each makes. */
const READS: Readonly<
  Record<string, (fetch: FetchFn, key: string, signal: AbortSignal) => Promise<unknown>>
> = {
  github: (fetch, key, signal) =>
    new GitHubClient(fetch, async () => key).request("GET", "/user", signal),
  slack: (fetch, key, signal) =>
    new SlackClient(fetch, async () => key).call("auth.test", {}, signal),
  linear: (fetch, key, signal) =>
    new LinearClient(fetch, async () => key).request("{ viewer { id } }", {}, signal),
  notion: (fetch, key, signal) =>
    new NotionClient(fetch, async () => key).request("GET", "/v1/users/me", signal),
  stripe: (fetch, key, signal) =>
    new StripeClient(fetch, async () => key).request("GET", "/v1/balance", {}, signal),
};

/** Pure: whether heel checks keys for this provider. */
export function checksKey(provider: string): boolean {
  return Object.hasOwn(READS, provider);
}

/** Checks `key` for `provider` with one read. Never throws. */
export async function checkKey(provider: string, key: string, fetch: FetchFn): Promise<KeyCheck> {
  const read = Object.hasOwn(READS, provider) ? READS[provider] : undefined;
  if (read === undefined) return { status: "ok" };
  try {
    await read(fetch, key, AbortSignal.timeout(TIMEOUT_MS));
    return { status: "ok" };
  } catch (error) {
    if (error instanceof CredentialRejectedError) {
      return {
        status: "rejected",
        message: `${error.service} rejected this key (wrong, expired or revoked), so heel didn't connect it. Check you copied all of it, or make a new one.`,
      };
    }
    return {
      status: "unchecked",
      message: "heel couldn't check this key with the service, so it connected it as it is.",
    };
  }
}
