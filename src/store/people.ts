import { count, eq } from "drizzle-orm";
import type { HeelQuery } from "../gateway/pipeline/ports.ts";
import type { HeelDb } from "./db.ts";
import { newId } from "./ids.ts";
import { passkeys, users } from "./schema.ts";

/**
 * The people on one heel (roadmap 2.9). With a sign-in provider (D13), people
 * join by signing in. Without one, an admin adds a person by name (`heel user
 * add`, or the People page) and gives them an enrollment link for their
 * passkey. A new person is a member: they own their own agents, accounts and
 * rules file (`rules/<name>.yaml`), and see nobody else's.
 */

/** A name heel can use for a person, and their rules file: lower-case, starting with a letter. */
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;

export function personNameProblem(name: string): string | null {
  return NAME.test(name)
    ? null
    : "A name is 1 to 64 lower-case letters, digits, '.', '_' or '-', starting with a letter.";
}

/** Adds a member by name. Names are unique without regard to case, since each names a file. */
export function addPerson(
  db: HeelDb,
  orgId: string,
  name: string,
  now: Date,
): { ok: true; id: string } | { ok: false; problem: string } {
  const problem = personNameProblem(name);
  if (problem !== null) return { ok: false, problem };
  return db.transaction((tx) => {
    const taken = tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.orgId, orgId))
      .all()
      .some((u) => u.name.toLowerCase() === name);
    if (taken) return { ok: false as const, problem: `Someone here is already named ${name}.` };
    const id = newId("user");
    tx.insert(users)
      .values({ id, orgId, name, role: "member", oidcSubject: null, createdAt: now })
      .run();
    return { ok: true as const, id };
  });
}

export interface PersonView {
  id: string;
  name: string;
  role: "admin" | "member";
  email: string | null;
  disabled: boolean;
  passkeys: number;
}

/** Everyone on this heel, by name. */
export function listPeople(db: HeelQuery, orgId: string): PersonView[] {
  const keys = new Map(
    db
      .select({ userId: passkeys.userId, n: count() })
      .from(passkeys)
      .groupBy(passkeys.userId)
      .all()
      .map((row) => [row.userId, row.n]),
  );
  return db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      email: users.email,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.orgId, orgId))
    .all()
    .map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      email: u.email,
      disabled: u.disabledAt !== null,
      passkeys: keys.get(u.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
