import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { lineDiff } from "../../drafting/draft.ts";
import {
  applyProposal,
  findProposal,
  ownerRulesFile,
  type ProposalRow,
  pendingProposals,
  previewProposal,
  rejectProposal,
  ruleYaml,
} from "../../proposals/rules.ts";
import { rememberRejected, stillSuggested } from "../../store/learning.ts";
import { listRuleChanges } from "../../store/rule-changes.ts";
import { agents, users } from "../../store/schema.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  passkeyChallenge,
  passkeyFailed,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  verifiedBinding,
  viewerOf,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { html } from "../ui/html.ts";
import { type ProposalCard, proposalCards, proposalPage } from "../ui/proposals.ts";
import { ruleHistoryPage } from "../ui/rule-history.ts";
import { hideInWords, ruleInWords } from "../ui/rule-words.ts";

/**
 * Rules an agent proposed, on the human plane.
 *
 * - `GET /proposals/:id` shows the rules, the agent's why, where they would
 *   go and the file after the change.
 * - `POST /proposals/challenge` then `POST /proposals/confirm` add them,
 *   with a fresh passkey assertion bound to the proposal and to a hash of
 *   the exact file heel will write. If the file changed in between, the
 *   hash differs and nothing is written.
 * - `POST /proposals/:id/reject` is a plain form: it only keeps things as
 *   they are.
 *
 * Only the owner whose file it is can see or decide a proposal.
 */

function nameOf(deps: HumanPlaneDeps, table: "user" | "agent", id: string): string {
  const row =
    table === "user"
      ? deps.db.select({ name: users.name }).from(users).where(eq(users.id, id)).get()
      : deps.db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get();
  return row?.name ?? "unknown";
}

/** The proposal, if it exists and this person owns the file it targets. */
function ownProposal(deps: HumanPlaneDeps, session: SessionView, id: string): ProposalRow | null {
  const row = findProposal(deps.db, deps.orgId, id);
  return row !== null && row.ownerId === session.userId ? row : null;
}

/** Pending proposals for the Approvals page. */
export function proposalCardsFor(deps: HumanPlaneDeps, session: SessionView, now: Date) {
  const cards: ProposalCard[] = pendingProposals(deps.db, session.userId, now).map((row) => ({
    id: row.id,
    agent: nameOf(deps, "agent", row.agentId),
    rules: row.rules.length,
    hide: row.hide.length,
    workdirs: row.workdirs.length,
    reason: row.reason,
    origin: row.origin,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
  return { count: cards.length, cards: proposalCards(cards, now) };
}

export function proposalRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  /**
   * heel's own suggestion is checked again when it's added: a decision
   * made since, or a changed rule, can make it one heel wouldn't suggest now.
   */
  function staleSuggestion(row: ProposalRow): string | null {
    if (row.origin !== "heel") return null;
    const learning = { db: deps.db, rules: deps.rules.set, threshold: deps.learning ?? null };
    const fits = row.rules.every((r) =>
      stillSuggested(learning, row.ownerId, row.agentId, r.rule, deps.now()),
    );
    return fits
      ? null
      : "heel wouldn't suggest this now: you decided a request it covers differently since, or your rules changed. Reject it.";
  }

  function target(row: ProposalRow) {
    const files = deps.ruleFiles;
    if (files === undefined) return null;
    const ownerRow = deps.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .get();
    const owner = ownerRow?.name;
    const file = owner === undefined ? null : ownerRulesFile(files.paths, owner);
    if (owner === undefined || file === null) return null;
    return {
      file,
      display: `rules/${owner}.yaml`,
      agent: nameOf(deps, "agent", row.agentId),
    };
  }

  function preview(row: ProposalRow) {
    const where = target(row);
    if (where === null) {
      return {
        where,
        effect: {
          ok: false as const,
          problem: "heel can't write this person's rules file from the approval page.",
        },
      };
    }
    const workdirs = {
      db: deps.db,
      orgId: deps.orgId,
      protectedPaths: deps.ruleFiles === undefined ? [] : [deps.ruleFiles.paths.home],
    };
    return {
      where,
      effect: previewProposal(row, where.file, where.display, where.agent, workdirs),
    };
  }

  const notFound = (c: Context<SignedInEnv>, session: SessionView) =>
    renderPage(
      c,
      {
        title: "Not found",
        viewer: viewerOf(session),
        current: "approvals",
        body: html`<h1>Not found</h1>
          <p>There's no proposal with that id for your rules.</p>`,
      },
      404,
    );

  app.get("/proposals/:id", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    pendingProposals(deps.db, session.userId, now); // expires old ones first
    const row = ownProposal(deps, session, c.req.param("id"));
    if (row === null) return notFound(c, session);
    const { where, effect } = preview(row);
    const ownRules =
      effect.ok && deps.rules.set !== null
        ? (deps.rules.set.owners.get(nameOf(deps, "user", row.ownerId))?.rules ?? [])
        : [];
    const existingNames = ownRules
      .map((rule) => rule.ref.name)
      .filter((name): name is string => name !== null);
    // heel's suggestions go right before the rule that asked.
    const anchor = ownRules.find((rule) => rule.hash === row.rules[0]?.before);
    const placedBefore =
      anchor === undefined
        ? null
        : {
            rule: anchor.ref.name ?? `the rule on line ${anchor.ref.line}`,
            above: anchor.index - 1,
          };
    const query = c.req.query();
    return renderPage(c, {
      title: "Proposed rules",
      viewer: viewerOf(session),
      current: "approvals",
      body: proposalPage({
        id: row.id,
        agent: where?.agent ?? nameOf(deps, "agent", row.agentId),
        status: row.status,
        reason: row.reason,
        origin: row.origin,
        file: where?.display ?? "your rules file",
        rules: row.rules.map((r) => ({
          yaml: ruleYaml(r.rule),
          words: ruleInWords(r.rule),
          why: r.why,
        })),
        hide: row.hide.map((h) => ({
          yaml: ruleYaml(h.entry),
          words: hideInWords(h.entry),
          why: h.why,
        })),
        workdirs: row.workdirs.map((w, i) => ({
          ...w,
          stored: effect.ok ? (effect.added[i] ?? null) : null,
        })),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        decision:
          row.decidedBy === null || row.decidedAt === null
            ? null
            : { by: nameOf(deps, "user", row.decidedBy), at: row.decidedAt },
        now,
        effect: effect.ok
          ? {
              ok: true,
              sha: effect.sha,
              existing: effect.existing,
              existingNames,
              placedBefore,
              diff: lineDiff(effect.before, effect.after),
            }
          : effect,
        reject: {
          action: `/proposals/${encodeURIComponent(row.id)}/reject`,
          csrfToken: session.csrfToken,
        },
        // Only the outcome the proposal actually had, whatever the link says.
        outcome:
          "applied" in query && row.status === "applied"
            ? "applied"
            : "rejected" in query && row.status === "rejected"
              ? "rejected"
              : null,
      }),
      script: clientScript(session.csrfToken),
    });
  });

  // Every change to the rules files: your own; admins see everyone's and the org file.
  app.get("/rules/history", signedIn, (c) => {
    const session = c.get("session");
    const everyone = session.role === "admin";
    return renderPage(c, {
      title: "Rule history",
      viewer: viewerOf(session),
      current: "rule-history",
      body: ruleHistoryPage({
        changes: listRuleChanges(deps.db, deps.orgId, everyone ? null : [session.userId]),
        now: deps.now(),
        everyone,
      }),
    });
  });

  app.post("/proposals/:id/reject", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const row = ownProposal(deps, session, c.req.param("id"));
    if (row === null) return notFound(c, session);
    rejectProposal(deps.db, row, session.userId, deps.now());
    rememberRejected(deps.db, row, deps.now());
    deps.log.info({ proposal: row.id, by: session.userId }, "rule proposal rejected");
    return c.redirect(`/proposals/${encodeURIComponent(row.id)}?rejected`, 303);
  });

  app.post("/proposals/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const row = ownProposal(deps, session, stringField(body, "proposalId") ?? "");
    if (row === null || row.status !== "pending") {
      return c.json({ ok: false, message: "That proposal isn't waiting for you." }, 404);
    }
    const { effect } = preview(row);
    if (!effect.ok) return c.json({ ok: false, message: effect.problem }, 409);
    const stale = staleSuggestion(row);
    if (stale !== null) return c.json({ ok: false, message: stale }, 409);
    // The page showed the file as it was when it loaded; sign only that file.
    if (stringField(body, "sha") !== effect.sha) {
      return c.json(
        {
          ok: false,
          message:
            "The rules file or the agent's workdirs changed since you opened this page. Reload it.",
        },
        409,
      );
    }
    return passkeyChallenge(c, deps, "rules", { proposal: row.id, sha: effect.sha });
  });

  app.post("/proposals/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const binding = await verifiedBinding(c, deps, "rules");
    if (binding === null) return passkeyFailed(c);
    // What to add comes from the signed challenge, never from this body.
    const { proposal, sha } = binding;
    const row = typeof proposal === "string" ? ownProposal(deps, session, proposal) : null;
    if (row === null || typeof sha !== "string") {
      return c.json({ ok: false, message: "That proposal isn't waiting for you." }, 409);
    }
    const stale = staleSuggestion(row);
    if (stale !== null) return c.json({ ok: false, message: stale }, 409);
    const { where, effect } = preview(row);
    if (where === null || !effect.ok) {
      return c.json(
        { ok: false, message: effect.ok ? "heel can't write rules here." : effect.problem },
        409,
      );
    }
    const applied = applyProposal(
      deps.db,
      row,
      where.file,
      effect,
      sha,
      session.userId,
      deps.now(),
      where.display,
    );
    if (!applied.ok) return c.json({ ok: false, message: applied.problem }, 409);
    deps.log.warn(
      {
        proposal: row.id,
        agent: where.agent,
        file: where.display,
        workdirs: effect.workRoots,
        by: session.userId,
      },
      "proposed rules added",
    );
    // Load them now rather than waiting for the file watcher.
    deps.ruleFiles?.reload();
    return c.json({ ok: true, next: `/proposals/${encodeURIComponent(row.id)}?applied` });
  });

  return app;
}
