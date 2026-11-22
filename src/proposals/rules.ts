import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { and, desc, eq, lt } from "drizzle-orm";
import { Document, isMap, isNode, isSeq, parse, parseDocument, YAMLSeq } from "yaml";
import { z } from "zod";
import { compileRulesText, type RulesPaths } from "../config/rules.ts";
import { formatYamlIssue, YamlValidationError } from "../config/yaml.ts";
import { canonicalHash } from "../core/canonical.ts";
import type { CompiledRulesFile } from "../core/rules/compile.ts";
import { AgentError, checkedWorkRoots } from "../gateway/agents.ts";

export { describeProposal } from "./describe.ts";

import { Rule } from "../core/rules/schema.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import {
  agents,
  type ProposedHide,
  type ProposedRule,
  type ProposedWorkdir,
  ruleProposals,
  users,
} from "../store/schema.ts";
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
 * - Proposed hide entries go at the end of the file's `hide:` list. A hide
 *   entry only takes more away from agents, never gives them anything.
 * - Proposed workdirs are directories the proposing agent's own `heel run`
 *   may work in, added to the ones it has. The agent learns only whether a
 *   path is absolute: whether it exists, or overlaps heel or another owner,
 *   is shown to the owner on the approval page, never to the agent.
 *
 * Rows are never changed once decided, so they are the change history too.
 */

/** How long a proposal waits for its owner. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROPOSED_RULES = 20;
export const MAX_PROPOSED_HIDE = 20;
export const MAX_PROPOSED_WORKDIRS = 10;
const MAX_PROPOSAL_BYTES = 32 * 1024;
const MAX_WHY_CHARS = 200;
const MAX_REASON_CHARS = 500;

/** What `heel_propose_rules` takes: rules, hide entries, or both. */
export const ProposeRulesInput = z
  .strictObject({
    rules: z
      .array(
        z.strictObject({
          rule: z.record(z.string(), z.unknown()),
          why: z.string().max(2_000).optional(),
        }),
      )
      .max(MAX_PROPOSED_RULES)
      .default([]),
    hide: z
      .array(
        z.strictObject({
          entry: z.record(z.string(), z.unknown()),
          why: z.string().max(2_000).optional(),
        }),
      )
      .max(MAX_PROPOSED_HIDE)
      .default([]),
    workdirs: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(1_024),
          why: z.string().max(2_000).optional(),
        }),
      )
      .max(MAX_PROPOSED_WORKDIRS)
      .default([]),
    reason: z.string().max(4_000).optional(),
  })
  .refine((input) => input.rules.length + input.hide.length + input.workdirs.length > 0, {
    message: "propose at least one rule, hide entry or workdir",
  });
/** What callers pass; `rules`, `hide` and `workdirs` may be left out. */
export type ProposeRulesInput = z.input<typeof ProposeRulesInput>;

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

/** The proposal as a rules file of its own, which is how heel checks it. */
function proposalText(rules: readonly ProposedRule[], hide: readonly ProposedHide[]): string {
  const doc = parseDocument("rules: []\n");
  doc.set(
    "rules",
    rules.map((r) => r.rule),
  );
  if (hide.length > 0)
    doc.set(
      "hide",
      hide.map((h) => h.entry),
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
  /**
   * `heel` for a rule heel drafted from the owner's decisions (2.10), with
   * the hash of the rule it goes before. Agents' rules always go first.
   */
  origin: { by: "agent" } | { by: "heel"; before: string } = { by: "agent" },
): ProposeOutcome {
  const rules: ProposedRule[] = (input.rules ?? []).map((r) => ({
    rule: JSON.parse(JSON.stringify(r.rule)) as Record<string, unknown>,
    why: oneLine(r.why, MAX_WHY_CHARS),
    ...(origin.by === "heel" ? { before: origin.before } : {}),
  }));
  const hide: ProposedHide[] = (input.hide ?? []).map((h) => ({
    entry: JSON.parse(JSON.stringify(h.entry)) as Record<string, unknown>,
    why: oneLine(h.why, MAX_WHY_CHARS),
  }));
  const workdirs: ProposedWorkdir[] = (input.workdirs ?? []).map((w) => ({
    path: w.path,
    why: oneLine(w.why, MAX_WHY_CHARS),
  }));
  if (Buffer.byteLength(JSON.stringify([rules, hide, workdirs])) > MAX_PROPOSAL_BYTES) {
    return { ok: false, problems: [`the proposal is larger than ${MAX_PROPOSAL_BYTES} bytes`] };
  }
  const problems: string[] = [];
  // Only the path's form is checked here; the rest is for the owner's eyes (see above).
  workdirs.forEach((w, i) => {
    if (!isAbsolute(w.path) || resolve(w.path) !== w.path.replace(/(.)[\\/]$/, "$1")) {
      problems.push(`workdirs.${i}: an absolute, normalized path, such as /home/me/project`);
    }
  });
  rules.forEach((r, i) => {
    if (!Rule.safeParse(r.rule).success) return; // compile below says what's wrong
    if (r.rule["watch"] === true) problems.push(`rules.${i}: a proposed rule can't be watch: true`);
  });
  try {
    compileRulesText(proposalText(rules, hide), "proposal", "proposal", "owner");
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
    // An agent's new proposal replaces its pending one. heel's suggestions stand on their own:
    // they neither replace an agent's proposal nor each other.
    if (origin.by === "agent") {
      tx.update(ruleProposals)
        .set({ status: "superseded", decidedAt: now })
        .where(
          and(
            eq(ruleProposals.agentId, who.agentId),
            eq(ruleProposals.origin, "agent"),
            eq(ruleProposals.status, "pending"),
          ),
        )
        .run();
    }
    tx.insert(ruleProposals)
      .values({
        id,
        orgId: who.orgId,
        ownerId: who.ownerId,
        agentId: who.agentId,
        rules,
        hide,
        workdirs,
        reason: oneLine(input.reason, MAX_REASON_CHARS),
        origin: origin.by,
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

/** A pending proposal with its agent's and owner's names, for `heel status` and `heel tui`. */
export interface PendingProposal {
  row: ProposalRow;
  agentName: string;
  ownerName: string;
}

/** Every pending proposal in the org, newest first. */
export function orgPendingProposals(db: HeelDb, orgId: string, now: Date): PendingProposal[] {
  expireProposals(db, now);
  return db
    .select({ row: ruleProposals, agentName: agents.name, ownerName: users.name })
    .from(ruleProposals)
    .innerJoin(agents, eq(agents.id, ruleProposals.agentId))
    .innerJoin(users, eq(users.id, ruleProposals.ownerId))
    .where(and(eq(ruleProposals.orgId, orgId), eq(ruleProposals.status, "pending")))
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

/** A user name heel will put in a file name: no path separators, no leading dot. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

/**
 * The owner's rules file, `rules/<name>.yaml`: the same name the pipeline
 * looks rules up by. Null for a name that isn't safe in a path.
 */
export function ownerRulesFile(paths: RulesPaths, userName: string): string | null {
  if (!SAFE_NAME.test(userName) || userName.includes("..")) return null;
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
      /** Hash of `after` and the agent's workdirs after: the passkey challenge binds to it. */
      sha: string;
      /** The rules already in the file, which the proposed ones go before. */
      existing: number;
      /** The agent's `heel run` directories after the change, as stored; null when none are proposed. */
      workRoots: string[] | null;
      /**
       * Each proposed directory as heel would store it, symlinks followed, in
       * proposal order. The owner approves these, not the agent's spelling.
       */
      added: string[];
    }
  | { ok: false; problem: string };

/** What a preview needs to check proposed workdirs: the agent's own and heel's home. */
export interface WorkdirContext {
  db: HeelDb;
  orgId: string;
  /** heel's own files, which no workdir may overlap. */
  protectedPaths: readonly string[];
}

/** Pure: the hash a passkey signs for a proposal, over everything applying it changes. */
function proposalSha(after: string, workRoots: readonly string[] | null): string {
  const hash = createHash("sha256").update(after);
  if (workRoots !== null) hash.update(`\0workdirs\0${JSON.stringify(workRoots)}`);
  return hash.digest("hex");
}

/**
 * Inserts the proposed rules at the top of the owner's file, each with a
 * comment naming the agent and its why, and checks the result compiles.
 * Comments and layout already in the file stay as they are.
 */
export function previewProposal(
  proposal: Pick<ProposalRow, "rules" | "hide" | "workdirs"> & Partial<Pick<ProposalRow, "origin">>,
  file: string,
  display: string,
  agentName: string,
  workdirs?: WorkdirContext,
): ProposalPreview {
  let workRoots: string[] | null = null;
  let added: string[] = [];
  if (proposal.workdirs.length > 0) {
    if (workdirs === undefined) {
      return { ok: false, problem: "heel can't change this agent's workdirs from here." };
    }
    try {
      const current = currentWorkRoots(workdirs.db, workdirs.orgId, agentName);
      const checked = checkedWorkRoots(
        workdirs.db,
        workdirs.orgId,
        agentName,
        [...current, ...proposal.workdirs.map((w) => w.path)],
        workdirs.protectedPaths,
      ).workRoots;
      added = checked.slice(current.length);
      workRoots = [...new Set(checked)];
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return { ok: false, problem: `heel can't add these workdirs: ${error.message}.` };
    }
  }
  // Workdirs alone leave the rules file exactly as it is.
  if (proposal.rules.length === 0 && proposal.hide.length === 0) {
    const text = readOwnerFile(file) ?? "";
    return {
      ok: true,
      before: text,
      after: text,
      sha: proposalSha(text, workRoots),
      existing: 0,
      workRoots,
      added,
    };
  }
  const before = readOwnerFile(file);
  let current: CompiledRulesFile | null = null;
  if (before !== null) {
    try {
      current = compileRulesText(before, file, display, "owner").file;
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
  // Where each `before` rule sits, found before anything moves.
  const anchors = new Map<string, unknown>();
  for (const r of proposal.rules) {
    if (r.before === undefined) continue;
    const target = current?.rules.find((rule) => rule.hash === r.before);
    const node = target === undefined ? undefined : list.items[target.index - 1];
    if (node === undefined) {
      return {
        ok: false,
        problem:
          "The rule this suggestion goes before has changed or gone since heel suggested it. Reject it; heel suggests it again if it still fits.",
      };
    }
    anchors.set(r.before, node);
  }
  proposal.rules
    .slice()
    .reverse()
    .forEach((r) => {
      const node = doc.createNode(r.rule);
      // heel's own suggestions (2.10) say so: the agent didn't ask for them.
      const by =
        proposal.origin === "heel"
          ? `Suggested by heel for ${agentName}`
          : `Proposed by ${agentName}`;
      node.commentBefore = ` ${by}${r.why === null ? "" : `: ${r.why}`}`;
      const anchor = r.before === undefined ? undefined : anchors.get(r.before);
      if (anchor === undefined) list.items.unshift(node);
      else list.items.splice(list.items.indexOf(anchor as never), 0, node);
    });
  if (proposal.hide.length > 0) {
    let hideSeq = doc.get("hide", true);
    if (!isSeq(hideSeq)) {
      hideSeq = new YAMLSeq();
      doc.set("hide", hideSeq);
    }
    for (const h of proposal.hide) {
      const node = doc.createNode(h.entry);
      node.commentBefore = ` Proposed by ${agentName}${h.why === null ? "" : `: ${h.why}`}`;
      (hideSeq as YAMLSeq).items.push(node);
    }
  }
  const after = doc.toString();
  let merged: CompiledRulesFile;
  try {
    merged = compileRulesText(after, file, display, "owner").file;
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    return {
      ok: false,
      problem: `these rules can't be added to ${display}: ${error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  // heel rewrites the whole file, so check every rule already there still
  // says exactly what it said, in the same order, and that the hide list is
  // the one that was there with exactly the proposed entries after it.
  // Where the new rules land: first, or right before their `before` rule.
  const had = current?.rules.map((rule) => rule.hash) ?? [];
  const layout: (string | null)[] = [...had];
  for (const r of proposal.rules.slice().reverse()) {
    if (r.before === undefined) layout.unshift(null);
    else layout.splice(layout.indexOf(r.before), 0, null);
  }
  const placedRight =
    merged.rules.length === layout.length &&
    layout.every((hash, i) => hash === null || merged.rules[i]?.hash === hash);
  const hideOf = (text: string | null): string[] => {
    const parsed = text === null ? null : (parse(text) as { hide?: unknown } | null);
    const list = Array.isArray(parsed?.hide) ? parsed.hide : [];
    return list.map((entry) => canonicalHash(entry));
  };
  const hideBefore = hideOf(before);
  const hideAfter = hideOf(after);
  const wantHide = [...hideBefore, ...proposal.hide.map((h) => canonicalHash(h.entry))];
  const sameHide =
    hideAfter.length === wantHide.length && hideAfter.every((hash, i) => hash === wantHide[i]);
  if (!placedRight || !sameHide) {
    return {
      ok: false,
      problem: `heel couldn't add these without changing what ${display} already says. Add them by hand.`,
    };
  }
  return {
    ok: true,
    before: before ?? "",
    after,
    sha: proposalSha(after, workRoots),
    existing,
    workRoots,
    added,
  };
}

/** The directories an agent's `heel run` may use now. */
function currentWorkRoots(db: HeelDb, orgId: string, agentName: string): string[] {
  const row = db
    .select({ workRoots: agents.workRoots })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.name, agentName)))
    .get();
  return row?.workRoots ?? [];
}

/**
 * Writes the previewed file, if it is still what the passkey signed, and
 * marks the proposal applied. It writes the file in place, so its owner,
 * mode and any symlink stay as the person set them up. heel's watcher may
 * see a half-written file for a moment; that load fails and the last good
 * rules keep deciding until the next one, which the caller starts at once.
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
    return {
      ok: false,
      problem:
        "The rules file or the agent's workdirs changed since you opened this page. Reload it.",
    };
  }
  if (proposal.rules.length > 0 || proposal.hide.length > 0) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, preview.after);
    } catch (error) {
      return {
        ok: false,
        problem: `heel couldn't write ${file}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const workRoots = preview.workRoots;
  db.transaction((tx) => {
    if (workRoots !== null) {
      tx.update(agents).set({ workRoots }).where(eq(agents.id, proposal.agentId)).run();
    }
    tx.update(ruleProposals)
      .set({ status: "applied", decidedBy: by, decidedAt: now })
      .where(eq(ruleProposals.id, proposal.id))
      .run();
  });
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

/** A proposed rule or hide entry as YAML, for the approval page. */
export function ruleYaml(rule: Record<string, unknown>): string {
  return new Document(rule).toString();
}
