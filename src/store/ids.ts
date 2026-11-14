import { randomBytes } from "node:crypto";

export const ID_PREFIXES = {
  org: "org",
  user: "usr",
  agent: "agt",
  agentToken: "tok",
  account: "acc",
  credential: "cred",
  approval: "apr",
  standingApproval: "sta",
  challenge: "chl",
  enrollment: "enr",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** A prefixed id with 128 random bits, e.g. `apr_7QxV…`. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomBytes(16).toString("base64url")}`;
}
