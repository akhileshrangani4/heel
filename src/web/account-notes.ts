import { randomBytes } from "node:crypto";
import type { HumanPlaneDeps } from "./http.ts";

/**
 * What an account change from the web app did (2.9), held server-side for
 * the page it lands on: a link carries only an opaque id, so a crafted one
 * can't make the Connections page claim a key was replaced or an account
 * removed. A note is read once, by the person it's for, within ten minutes.
 */
export interface AccountNote {
  kind: "added" | "rekeyed" | "removed" | "sharing";
  alias: string;
  unchecked: boolean;
}

const TTL_MS = 10 * 60_000;

class AccountNotes {
  readonly #notes = new Map<string, AccountNote & { userId: string; at: number }>();
  readonly #now: () => Date;
  constructor(now: () => Date) {
    this.#now = now;
  }
  add(userId: string, note: AccountNote): string {
    const at = this.#now().getTime();
    for (const [id, held] of this.#notes) {
      if (at - held.at > TTL_MS || this.#notes.size > 200) this.#notes.delete(id);
    }
    const id = randomBytes(12).toString("base64url");
    this.#notes.set(id, { ...note, userId, at });
    return id;
  }
  take(userId: string, id: string): AccountNote | null {
    const held = this.#notes.get(id);
    this.#notes.delete(id);
    if (held === undefined || held.userId !== userId) return null;
    if (this.#now().getTime() - held.at > TTL_MS) return null;
    return { kind: held.kind, alias: held.alias, unchecked: held.unchecked };
  }
}

const notes = new WeakMap<HumanPlaneDeps, AccountNotes>();

/** The notes for this human plane, shared by the routes that write and read them. */
export function accountNotes(deps: HumanPlaneDeps): AccountNotes {
  let held = notes.get(deps);
  if (held === undefined) {
    held = new AccountNotes(deps.now);
    notes.set(deps, held);
  }
  return held;
}
