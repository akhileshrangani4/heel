import { needsKey, serviceLabel } from "../../requests/connection.ts";

/**
 * What an agent tells its owner once a key it asked for is connected: the
 * `next` note on that account in `heel_accounts`. Pure.
 *
 * heel now holds the key the owner pasted, so the note is only about other
 * copies: an older key or login for the same account on the agent's
 * machine. It never says to revoke the key heel holds. Revoking is offered
 * only for a key that is a different one, and logging `gh` out is left to
 * the owner, with the tradeoff. A service people sign in to has no key to
 * hand over, so it gets no note.
 */

/** How long after the owner connects it an account carries the note. */
export const CONNECTED_NOTE_MS = 24 * 60 * 60 * 1000;

/** Pure: the note for an account made from the agent's request, or null when it took no key. */
export function connectedKeyNote(provider: string, alias: string): string | null {
  if (!needsKey(provider)) return null;
  const service = serviceLabel({ provider, alias });
  // GitHub's login is gh's, which has its own sentence.
  const older = provider === "github" ? "key" : "key or login";
  const note =
    `When a call on ${alias} first works, tell your owner this, just once: ` +
    `heel now holds their ${service} key, so keep it only in heel. ` +
    `If an older ${service} ${older} for the same account is still somewhere else on this machine, ` +
    "such as an environment variable or a config file, they can delete it there, " +
    `and revoke it on ${service} if it's a different key from the one heel holds. ` +
    "Revoking the key heel holds would cut heel off.";
  if (provider !== "github") return note;
  return (
    `${note} Logging gh out (gh auth logout) is optional and their choice: ` +
    "keeping it is handy, but it's a second place on this machine with broad access to their GitHub. " +
    "If heel's key came from gh auth token, logging out only removes it from this machine and heel keeps working, " +
    "but revoking the GitHub CLI's access on GitHub would cut heel off too."
  );
}
