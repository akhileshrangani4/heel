import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { RulesPaths } from "../config/rules.ts";
import { lineDiff } from "../drafting/draft.ts";
import type { HeelDb } from "./db.ts";
import { newId } from "./ids.ts";
import { agents, ruleChanges, ruleFileSnapshots, ruleProposals, users } from "./schema.ts";

/**
 * The history of the rules files (roadmap 2.4). A change heel makes from a
 * proposal is recorded with who proposed it and who added it. Any other
 * change (an editor, git, a script) is noticed on the next reload, by
 * comparing each file with what heel last saw, and recorded as made outside
 * heel. Either way the record keeps the change as a line diff.
 */

/** Diffs past this are cut, so one huge paste can't swell the database. */
const MAX_DIFF_CHARS = 64 * 1024;

function capped(diff: string): string {
  return diff.length <= MAX_DIFF_CHARS
    ? diff
    : `${diff.slice(0, MAX_DIFF_CHARS)}\n... (cut: the change is longer than heel keeps)`;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Every rules file heel loads, as a path relative to its home, with whose it is. */
function rulesFiles(paths: RulesPaths): { path: string; file: string; owner: string | null }[] {
  const files = [{ path: paths.orgFile, owner: null as string | null }];
  if (existsSync(paths.ownersDir)) {
    for (const name of readdirSync(paths.ownersDir).sort()) {
      if (name.endsWith(".yaml")) {
        files.push({ path: join(paths.ownersDir, name), owner: name.slice(0, -".yaml".length) });
      }
    }
  }
  return files.map((f) => ({ ...f, file: relative(paths.home, f.path) }));
}

function userIdOf(db: HeelDb, name: string): string | null {
  return db.select({ id: users.id }).from(users).where(eq(users.name, name)).get()?.id ?? null;
}

function saveSnapshot(db: HeelDb, file: string, text: string, now: Date): void {
  db.insert(ruleFileSnapshots)
    .values({ file, text, seenAt: now })
    .onConflictDoUpdate({ target: ruleFileSnapshots.file, set: { text, seenAt: now } })
    .run();
}

/**
 * Compares every rules file with what heel last saw, recording each that
 * changed outside heel. The first time heel sees a file it only remembers it.
 * Called at start and after each reload.
 */
export function noticeRuleFiles(db: HeelDb, orgId: string, paths: RulesPaths, now: Date): void {
  const seen = new Set<string>();
  for (const { path, file, owner } of rulesFiles(paths)) {
    seen.add(file);
    const text = readText(path);
    const last = db.select().from(ruleFileSnapshots).where(eq(ruleFileSnapshots.file, file)).get();
    if (text === null) continue;
    if (last !== undefined && last.text !== text) {
      db.insert(ruleChanges)
        .values({
          id: newId("ruleChange"),
          orgId,
          userId: owner === null ? null : userIdOf(db, owner),
          file,
          at: now,
          source: "outside",
          diff: capped(lineDiff(last.text, text)),
        })
        .run();
    }
    if (last?.text !== text) saveSnapshot(db, file, text, now);
  }
  // A file that's gone: recorded as emptied, once.
  for (const snapshot of db.select().from(ruleFileSnapshots).all()) {
    if (seen.has(snapshot.file) || snapshot.text === "") continue;
    const name = /^rules\/(.+)\.yaml$/.exec(snapshot.file)?.[1];
    db.insert(ruleChanges)
      .values({
        id: newId("ruleChange"),
        orgId,
        userId: name === undefined ? null : userIdOf(db, name),
        file: snapshot.file,
        at: now,
        source: "outside",
        diff: capped(lineDiff(snapshot.text, "")),
      })
      .run();
    saveSnapshot(db, snapshot.file, "", now);
  }
}

/**
 * Records a change heel made from a proposal, and remembers the new text, so
 * the reload that follows doesn't count it again as made outside heel.
 * Called just before heel writes the file.
 */
export function recordProposalChange(
  db: HeelDb,
  change: {
    orgId: string;
    userId: string;
    file: string;
    before: string;
    after: string;
    proposalId: string;
    decidedBy: string;
    now: Date;
  },
): void {
  db.insert(ruleChanges)
    .values({
      id: newId("ruleChange"),
      orgId: change.orgId,
      userId: change.userId,
      file: change.file,
      at: change.now,
      source: "proposal",
      proposalId: change.proposalId,
      decidedBy: change.decidedBy,
      diff: capped(lineDiff(change.before, change.after)),
    })
    .run();
  saveSnapshot(db, change.file, change.after, change.now);
}

export interface RuleChangeView {
  id: string;
  file: string;
  at: Date;
  source: "proposal" | "outside";
  /** For a proposal: the agent it was for, and whether heel drafted it. */
  agent: string | null;
  origin: "agent" | "heel" | null;
  proposalId: string | null;
  decidedBy: string | null;
  diff: string;
}

/**
 * Changes to these people's files, newest first; `null` for everyone's and
 * the org file (admins).
 */
export function listRuleChanges(
  db: HeelDb,
  orgId: string,
  userIds: readonly string[] | null,
  limit = 100,
): RuleChangeView[] {
  const whose =
    userIds === null
      ? undefined
      : userIds.length === 0
        ? isNull(ruleChanges.id)
        : inArray(ruleChanges.userId, [...userIds]);
  const rows = db
    .select({
      id: ruleChanges.id,
      file: ruleChanges.file,
      at: ruleChanges.at,
      source: ruleChanges.source,
      proposalId: ruleChanges.proposalId,
      decidedBy: users.name,
      agent: agents.name,
      origin: ruleProposals.origin,
      diff: ruleChanges.diff,
    })
    .from(ruleChanges)
    .leftJoin(users, eq(users.id, ruleChanges.decidedBy))
    .leftJoin(ruleProposals, eq(ruleProposals.id, ruleChanges.proposalId))
    .leftJoin(agents, eq(agents.id, ruleProposals.agentId))
    .where(and(eq(ruleChanges.orgId, orgId), whose))
    .orderBy(desc(ruleChanges.at), desc(ruleChanges.id))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    ...row,
    agent: row.agent ?? null,
    origin: row.origin ?? null,
    decidedBy: row.decidedBy ?? null,
  }));
}
