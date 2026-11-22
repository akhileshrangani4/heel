import { and, eq, gte, inArray } from "drizzle-orm";
import type { Call } from "../core/call.ts";
import {
  type DecidedCall,
  LEARNING_WINDOW_DAYS,
  type LearnedRule,
  type LearningThreshold,
  learnedKey,
  learnRules,
} from "../core/learning.ts";
import type { RuleSet } from "../core/rules/evaluate.ts";
import { type ProposeOutcome, proposeRules } from "../proposals/rules.ts";
import type { HeelDb } from "./db.ts";
import { agents, approvals, auditLog, learningDismissals, ruleProposals, users } from "./schema.ts";

/**
 * Where heel's rule suggestions come from (roadmap 2.10): what a person
 * decided on their own agents' requests, as the audit log recorded each
 * decision, with the call the request stored. Org asks are left out: they go
 * to admins, and an owner rule can't answer them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LearningDeps {
  db: HeelDb;
  rules: RuleSet | null;
  /** Null when heel.yaml turns learning off. */
  threshold: LearningThreshold | null;
}

/** The requests `userId` decided on their own agents' behalf since `since`. */
function decidedBy(db: HeelDb, userId: string, since: Date, rules: RuleSet | null, owner: string) {
  const ownRules = rules?.owners.get(owner)?.rules ?? [];
  return db
    .select({
      kind: auditLog.kind,
      at: auditLog.at,
      call: approvals.call,
      ruleHash: approvals.ruleHash,
      agentName: agents.name,
    })
    .from(auditLog)
    .innerJoin(approvals, eq(approvals.id, auditLog.approvalId))
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(
      and(
        inArray(auditLog.kind, ["approved", "approval_denied"]),
        eq(auditLog.approverId, userId),
        gte(auditLog.at, since),
        eq(approvals.ownerId, userId),
        eq(approvals.origin, "owner"),
      ),
    )
    .all()
    .map(
      (row): DecidedCall => ({
        agentName: row.agentName,
        decision: row.kind === "approved" ? "approved" : "denied",
        at: row.at,
        call: row.call as Call,
        askedBy: ownRules.find((rule) => rule.hash === row.ruleHash) ?? null,
      }),
    );
}

/** Keys not to offer again: dismissed, or waiting as one of heel's proposals. */
function skipped(db: HeelDb, userId: string): Set<string> {
  const keys = new Set(
    db
      .select({ key: learningDismissals.key })
      .from(learningDismissals)
      .where(eq(learningDismissals.userId, userId))
      .all()
      .map((row) => row.key),
  );
  const pending = db
    .select({ agentId: ruleProposals.agentId, rules: ruleProposals.rules })
    .from(ruleProposals)
    .where(
      and(
        eq(ruleProposals.ownerId, userId),
        eq(ruleProposals.origin, "heel"),
        eq(ruleProposals.status, "pending"),
      ),
    )
    .all();
  for (const proposal of pending) {
    for (const { rule } of proposal.rules) keys.add(learnedKey(proposal.agentId, rule));
  }
  return keys;
}

/** The rules heel suggests to this person now; none when learning is off. */
export function suggestionsFor(deps: LearningDeps, userId: string, now: Date): LearnedRule[] {
  if (deps.threshold === null) return [];
  const user = deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  if (user === undefined) return [];
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS);
  return learnRules(decidedBy(deps.db, userId, since, deps.rules, user.name), {
    owner: user.name,
    rules: deps.rules,
    threshold: deps.threshold,
    now,
    skip: skipped(deps.db, userId),
  });
}

/**
 * Turns a suggestion into a proposal the person adds with a passkey. The rule
 * is drafted again here from the key alone, never taken from the request.
 * Null when there's no such suggestion now.
 */
export function proposeSuggestion(
  deps: LearningDeps,
  who: { orgId: string; userId: string },
  key: string,
  now: Date,
): ProposeOutcome | null {
  const learned = suggestionsFor(deps, who.userId, now).find((s) => s.key === key);
  if (learned === undefined) return null;
  return proposeRules(
    deps.db,
    { orgId: who.orgId, ownerId: who.userId, agentId: learned.agentId },
    {
      rules: [{ rule: learned.rule, why: `You ${learned.evidence}.` }],
      reason: `heel suggested this from your decisions: ${learned.evidence}.`,
    },
    now,
    "heel",
  );
}

/** Stops offering a suggestion. True when it was on offer. */
export function dismissSuggestion(
  deps: LearningDeps,
  userId: string,
  key: string,
  now: Date,
): boolean {
  if (!suggestionsFor(deps, userId, now).some((s) => s.key === key)) return false;
  deps.db
    .insert(learningDismissals)
    .values({ userId, key, createdAt: now })
    .onConflictDoNothing()
    .run();
  return true;
}
