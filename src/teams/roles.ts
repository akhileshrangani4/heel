import type { RoleGroups } from "../config/schema.ts";
import type { UserRole } from "../store/schema.ts";

/**
 * Group-to-role mapping (spec: Teams, "Roles"). Pure, so sign-in (D13b) can
 * re-run it on every login and tests can table it.
 */

/** What a claims object says about groups. `malformed` is never read as "no groups" silently. */
export type GroupsClaim =
  | { state: "present"; groups: string[] }
  | { state: "absent" }
  | { state: "malformed" };

function lookup(claims: Readonly<Record<string, unknown>>, name: string): unknown {
  // A claim named with dots (e.g. "https://example.com/groups") is looked up
  // whole first; only if that key is absent is it read as a nested path
  // (e.g. Keycloak's "realm_access.roles").
  if (Object.hasOwn(claims, name)) return claims[name];
  let value: unknown = claims;
  for (const part of name.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * Pure: reads the groups claim. An array of strings, or a single string, is
 * accepted (IdPs differ); anything else is `malformed`.
 */
export function readGroupsClaim(
  claims: Readonly<Record<string, unknown>>,
  claimName: string,
): GroupsClaim {
  const value = lookup(claims, claimName);
  if (value === undefined || value === null) return { state: "absent" };
  if (typeof value === "string") return { state: "present", groups: [value] };
  if (Array.isArray(value) && value.every((group) => typeof group === "string")) {
    return { state: "present", groups: [...new Set(value)] };
  }
  return { state: "malformed" };
}

/**
 * Pure: the role a set of IdP groups grants, or null when none of them is
 * mapped (the person may not sign in). Group names compare exactly. Admin
 * wins when a person is in both an admin and a member group.
 */
export function roleForGroups(groups: readonly string[], mapping: RoleGroups): UserRole | null {
  const held = new Set(groups);
  if (mapping.admin.some((group) => held.has(group))) return "admin";
  if (mapping.member.some((group) => held.has(group))) return "member";
  return null;
}
