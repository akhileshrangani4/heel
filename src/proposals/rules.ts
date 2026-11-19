import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, lt } from "drizzle-orm";
import { Document, isMap, isNode, isSeq, parseDocument, YAMLSeq } from "yaml";
import { z } from "zod";
import { compileRulesText, type RulesPaths } from "../config/rules.ts";
import { formatYamlIssue, YamlValidationError } from "../config/yaml.ts";
import { Rule } from "../core/rules/schema.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { type ProposedRule, ruleProposals } from "../store/schema.ts";
import { hasErrnoCode } from "../util/errno.ts";

/**
 * Rule proposals (roadmap 2.1, 2.2, 2.4). An agent proposes rules to add to
 * its owner's rules file; the owner applies them with a passkey on the
 * approval page. The agent never writes the file and never sees it:
 *
 * - It sends rule objects, not YAML. heel writes the YAML, so the agent can't
 *   add comments, anchors or layout to a file its owner trusts.
 * - A proposal is checked on its own. Nothing about the owner's file (rule
 *   names, errors that would quote it) goes back to the agent.
 * - The target file comes from the agent's owner, never from an argument.
 * - Proposed rules go first in the file, so a call they match is decided by
 *   them. The approval page says which existing rules they come before.
 *
 * Rows are never changed once decided, so they are the change history too.
 */

/** How long a proposal waits for its owner. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROPOSED_RULES = 20;
const MAX_PROPOSAL_BYTES = 32 * 1024;
const MAX_WHY_CHARS = 200;
const MAX_REASON_CHARS = 500;

/** What `heel_propose_rules` takes. */
export const ProposeRulesInput = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        rule: z.record(z.string(), z.unknown()),
        why: z.string().max(2_000).optional(),
      }),
    )
    .min(1)
    .max(MAX_PROPOSED_RULES),
  reason: z.string().max(4_000).optional(),
});
export type ProposeRulesInput = z.output<typeof ProposeRulesInput>;

export type ProposeOutcome =
  | { ok: true; proposalId: string; expiresAt: Date }
  | { ok: false; problems: string[] };

/** One line of the agent's text, with no line breaks or control characters, capped. */
function oneLine(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  return flat === "" ? null : flat.slice(0, max);
}

/** The proposed rules as a rules file of their own, which is how heel checks them. */
function proposalText(rules: readonly ProposedRule[]): string {
  const doc = parseDocument("rules: []\n");
  doc.set(
    "rules",
    rules.map((r) => r.rule),
  );
  return doc.toString();
}

/**
 * Checks a proposal on its own and stores it, replacing the agent's earlier
 * pending one. Problems name only the proposal (`rules.0.match...`), never
 * the owner's file.
 */
export function proposeRules(
  db: HeelDb,
  who: { orgId: string; ownerId: string; agentId: string },
  input: ProposeRulesInput,
  now: Date,
): ProposeOutcome {
  const rules: ProposedRule[] = input.rules.map((r) => ({
    rule: JSON.parse(JSON.stringify(r.rule)) as Record<string, unknown>,
    why: oneLine(r.why, MAX_WHY_CHARS),
  }));
  if (Buffer.byteLength(JSON.stringify(rules)) > MAX_PROPOSAL_BYTES) {
    return { ok: false, problems: [`the proposal is larger than ${MAX_PROPOSAL_BYTES} bytes`] };
  }
  const problems: string[] = [];
  rules.forEach((r, i) => {
    if (!Rule.safeParse(r.rule).success) return; // compile below says what's wrong
    if (r.rule["watch"] === true) problems.push(`rules.${i}: a proposed rule can't be watch: true`);
  });
  try {
    compileRulesText(proposalText(rules), "proposal", "proposal", "owner");
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    problems.push(
      ...error.issues.map((issue) =>
        issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
      ),
    );
  }
  if (problems.length > 0) return { ok: false, problems };

  const id = newId("ruleProposal");
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  db.transaction((tx) => {
    tx.update(ruleProposals)
      .set({ status: "superseded", decidedAt: now })
      .where(and(eq(ruleProposals.agentId, who.agentId), eq(ruleProposals.status, "pending")))
      .run();
    tx.insert(ruleProposals)
      .values({
        id,
        orgId: who.orgId,
        ownerId: who.ownerId,
        agentId: who.agentId,
        rules,
        reason: oneLine(input.reason, MAX_REASON_CHARS),
        status: "pending",
        createdAt: now,
        expiresAt,
      })
      .run();
  });
  return { ok: true, proposalId: id, expiresAt };
}

export type ProposalRow = typeof ruleProposals.$inferSelect;

/** Marks pending proposals past their time as expired. */
export function expireProposals(db: HeelDb, now: Date): void {
  db.update(ruleProposals)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(ruleProposals.status, "pending"), lt(ruleProposals.expiresAt, now)))
    .run();
}

/** An owner's pending proposals, newest first. */
export function pendingProposals(db: HeelDb, ownerId: string, now: Date): ProposalRow[] {
  expireProposals(db, now);
  return db
    .select()
    .from(ruleProposals)
    .where(and(eq(ruleProposals.ownerId, ownerId), eq(ruleProposals.status, "pending")))
    .orderBy(desc(ruleProposals.createdAt))
    .all();
}

export function findProposal(db: HeelDb, orgId: string, id: string): ProposalRow | null {
  return (
    db
      .select()
      .from(ruleProposals)
      .where(and(eq(ruleProposals.orgId, orgId), eq(ruleProposals.id, id)))
      .get() ?? null
  );
}

export function ownerRulesFile(paths: RulesPaths, userName: string): string {
  return join(paths.ownersDir, `${userName}.yaml`);
}

/** The owner's file as it is now: its text, or null when there is none. */
function readOwnerFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** What applying a proposal would do, worked out from the file on disk now. */
export type ProposalPreview =
  | {
      ok: true;
      before: string;
      after: string;
      /** Hash of `after`: the passkey challenge binds to it. */
      sha: string;
      /** The rules already in the file, which the proposed ones go before. */
      existing: number;
    }
  | { ok: false; problem: string };

/**
 * Inserts the proposed rules at the top of the owner's file, each with a
 * comment naming the agent and its why, and checks the result compiles.
 * Comments and layout already in the file stay as they are.
 */
export function previewProposal(
  proposal: Pick<ProposalRow, "rules">,
  file: string,
  display: string,
  agentName: string,
): ProposalPreview {
  const before = readOwnerFile(file);
  if (before !== null) {
    try {
      compileRulesText(before, file, display, "owner");
    } catch (error) {
      if (!(error instanceof YamlValidationError)) throw error;
      return {
        ok: false,
        problem: `${display} has an error, so heel can't add to it until it's fixed: ${error.issues
          .map(formatYamlIssue)
          .join("; ")}`,
      };
    }
  }
  const source = before ?? "rules: []\n";
  let doc = parseDocument(source);
  // A file with only comments compiles as an empty mapping; keep the comments.
  if (doc.contents === null) doc = parseDocument(`${source.replace(/\n?$/, "\n")}rules: []\n`);
  if (!isMap(doc.contents)) return { ok: false, problem: `${display} isn't a mapping` };
  let seq = doc.get("rules", true);
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set("rules", seq);
  }
  const list = seq as YAMLSeq;
  const existing = list.items.length;
  // A comment above the first rule is stored on the list itself; keep it with
  // that rule, rather than above the new ones.
  const first = list.items[0];
  if (isNode(first) && list.commentBefore) {
    first.commentBefore = first.commentBefore
      ? `${list.commentBefore}\n${first.commentBefore}`
      : list.commentBefore;
    list.commentBefore = null;
  }
  proposal.rules
    .slice()
    .reverse()
    .forEach((r) => {
      const node = doc.createNode(r.rule);
      node.commentBefore = ` Proposed by ${agentName}${r.why === null ? "" : `: ${r.why}`}`;
      list.items.unshift(node);
    });
  const after = doc.toString();
  try {
    compileRulesText(after, file, display, "owner");
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    return {
      ok: false,
      problem: `these rules can't be added to ${display}: ${error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return {
    ok: true,
    before: before ?? "",
    after,
    sha: createHash("sha256").update(after).digest("hex"),
    existing,
  };
}

/**
 * Writes the previewed file, if it is still what the passkey signed, and
 * marks the proposal applied. A dot-prefixed temporary file in `rules/`
 * renamed over the original, so heel's watcher never loads half a file.
 */
export function applyProposal(
  db: HeelDb,
  proposal: ProposalRow,
  file: string,
  preview: Extract<ProposalPreview, { ok: true }>,
  signedSha: string,
  by: string,
  now: Date,
): { ok: true } | { ok: false; problem: string } {
  if (proposal.status !== "pending" || proposal.expiresAt < now) {
    return { ok: false, problem: "This proposal is no longer waiting." };
  }
  if (preview.sha !== signedSha) {
    return { ok: false, problem: "The rules file changed since you opened this page. Reload it." };
  }
  const dir = join(file, "..");
  const temp = join(dir, `.heel-proposal-${proposal.id}.tmp`);
  try {
    writeFileSync(temp, preview.after, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    return {
      ok: false,
      problem: `heel couldn't write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  db.update(ruleProposals)
    .set({ status: "applied", decidedBy: by, decidedAt: now })
    .where(eq(ruleProposals.id, proposal.id))
    .run();
  return { ok: true };
}

/** Rejecting only tightens, so it needs no passkey. */
export function rejectProposal(db: HeelDb, proposal: ProposalRow, by: string, now: Date): boolean {
  if (proposal.status !== "pending") return false;
  db.update(ruleProposals)
    .set({ status: "rejected", decidedBy: by, decidedAt: now })
    .where(and(eq(ruleProposals.id, proposal.id), eq(ruleProposals.status, "pending")))
    .run();
  return true;
}

/** A proposed rule as YAML, for the approval page. */
export function ruleYaml(rule: Record<string, unknown>): string {
  return new Document(rule).toString();
}
