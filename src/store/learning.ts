import { and, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import type { Call } from "../core/call.ts";
import {
  type DecidedCall,
  type HistoryGroup,
  kindKeyOf,
  LEARNING_WINDOW_DAYS,
  type LearnedRule,
  type LearningThreshold,
  learnedKey,
  learnRules,
  summarizeDecisions,
} from "../core/learning.ts";
import type { RuleSet } from "../core/rules/evaluate.ts";
import { type ProposeOutcome, proposeRules } from "../proposals/rules.ts";
import type { HeelDb } from "./db.ts";
import {
  agents,
  approvals,
  auditLog,
  learningDismissals,
  ruleProposals,
  standingApprovals,
  users,
} from "./schema.ts";

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

/** The requests `userId` decided on their own agents' behalf since `since`; one agent's with `agentId`. */
function decidedBy(
  db: HeelDb,
  userId: string,
  since: Date,
  rules: RuleSet | null,
  owner: string,
  agentId?: string,
) {
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
        agentId === undefined ? undefined : eq(approvals.agentId, agentId),
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

/** Kind keys this person dismissed, or rejected as one of heel's proposals. */
function dismissed(db: HeelDb, userId: string): Set<string> {
  return new Set(
    db
      .select({ key: learningDismissals.key })
      .from(learningDismissals)
      .where(eq(learningDismissals.userId, userId))
      .all()
      .map((row) => row.key),
  );
}

/** Kind keys waiting as one of heel's proposals. */
function pendingKinds(db: HeelDb, userId: string): Set<string> {
  const keys = new Set<string>();
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
    for (const { rule } of proposal.rules) {
      keys.add(kindKeyOf(proposal.agentId, rule as LearnedRule["rule"]));
    }
  }
  return keys;
}

function learned(
  deps: LearningDeps,
  userId: string,
  now: Date,
  options: { skipPending: boolean; limit?: number },
): LearnedRule[] {
  if (deps.threshold === null) return [];
  const user = deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  if (user === undefined) return [];
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS);
  const skip = dismissed(deps.db, userId);
  if (options.skipPending) for (const key of pendingKinds(deps.db, userId)) skip.add(key);
  return learnRules(decidedBy(deps.db, userId, since, deps.rules, user.name), {
    owner: user.name,
    rules: deps.rules,
    threshold: deps.threshold,
    now,
    skip,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    standing: (agentId, ruleHash) =>
      deps.db
        .select({ id: standingApprovals.id })
        .from(standingApprovals)
        .where(
          and(
            eq(standingApprovals.agentId, agentId),
            eq(standingApprovals.ruleHash, ruleHash),
            isNull(standingApprovals.revokedAt),
            gt(standingApprovals.expiresAt, now),
          ),
        )
        .get() !== undefined,
  });
}

/** The rules heel suggests to this person now; none when learning is off. */
export function suggestionsFor(deps: LearningDeps, userId: string, now: Date): LearnedRule[] {
  return learned(deps, userId, now, { skipPending: true });
}

/**
 * Whether heel would still suggest this proposed rule, checked again when the
 * person adds it: a decision since, or a changed rule, can make it wrong.
 */
export function stillSuggested(
  deps: LearningDeps,
  userId: string,
  agentId: string,
  rule: Record<string, unknown>,
  now: Date,
): boolean {
  const key = learnedKey(agentId, rule);
  return learned(deps, userId, now, { skipPending: false, limit: Number.POSITIVE_INFINITY }).some(
    (s) => s.key === key,
  );
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
  const found = suggestionsFor(deps, who.userId, now).find((s) => s.key === key);
  if (found === undefined) return null;
  return proposeRules(
    deps.db,
    { orgId: who.orgId, ownerId: who.userId, agentId: found.agentId },
    {
      rules: [{ rule: found.rule, why: `You ${found.evidence}.` }],
      reason: `heel suggested this from your decisions: ${found.evidence}.`,
    },
    now,
    { by: "heel", before: found.before },
  );
}

function remember(db: HeelDb, userId: string, key: string, now: Date): void {
  db.insert(learningDismissals).values({ userId, key, createdAt: now }).onConflictDoNothing().run();
}

/** Stops offering a suggestion, and others of its kind. True when it was on offer. */
export function dismissSuggestion(
  deps: LearningDeps,
  userId: string,
  key: string,
  now: Date,
): boolean {
  const found = suggestionsFor(deps, userId, now).find((s) => s.key === key);
  if (found === undefined) return false;
  remember(deps.db, userId, found.kindKey, now);
  return true;
}

/** A rejected heel proposal counts as dismissed, so the same suggestion doesn't come straight back. */
export function rememberRejected(
  db: HeelDb,
  proposal: {
    ownerId: string;
    agentId: string;
    origin: string;
    rules: readonly { rule: Record<string, unknown> }[];
  },
  now: Date,
): void {
  if (proposal.origin !== "heel") return;
  for (const { rule } of proposal.rules) {
    remember(db, proposal.ownerId, kindKeyOf(proposal.agentId, rule as LearnedRule["rule"]), now);
  }
}

/**
 * What `heel_history` tells an agent (2.10): its own requests its owner
 * decided, grouped, and the rules heel would suggest for it. Only this agent's
 * calls, and nothing about the owner's rules file, their approvals of other
 * agents, or what a call carried.
 */
export function historyFor(
  deps: LearningDeps,
  agent: { agentId: string; ownerId: string },
  now: Date,
): { decisions: HistoryGroup[]; suggestions: LearnedRule[] } {
  const user = deps.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, agent.ownerId))
    .get();
  if (user === undefined) return { decisions: [], suggestions: [] };
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS);
  const own = decidedBy(deps.db, agent.ownerId, since, deps.rules, user.name, agent.agentId);
  return {
    decisions: summarizeDecisions(own, now),
    suggestions: suggestionsFor(deps, agent.ownerId, now).filter(
      (s) => s.agentId === agent.agentId,
    ),
  };
}
