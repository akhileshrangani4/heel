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
import { agents, users } from "../../store/schema.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  viewerOf,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { html } from "../ui/html.ts";
import { type ProposalCard, proposalCards, proposalPage } from "../ui/proposals.ts";
import { hideInWords, ruleInWords } from "../ui/rule-words.ts";

/**
 * Rules an agent proposed (roadmap 2.1), on the human plane.
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
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
  return { count: cards.length, cards: proposalCards(cards, now) };
}

export function proposalRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

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
    const existingNames =
      effect.ok && deps.rules.set !== null
        ? (deps.rules.set.owners.get(nameOf(deps, "user", row.ownerId))?.rules ?? [])
            .map((rule) => rule.ref.name)
            .filter((name): name is string => name !== null)
        : [];
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

  app.post("/proposals/:id/reject", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const row = ownProposal(deps, session, c.req.param("id"));
    if (row === null) return notFound(c, session);
    rejectProposal(deps.db, row, session.userId, deps.now());
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
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "rules",
      userId: session.userId,
      binding: { proposal: row.id, sha: effect.sha },
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/proposals/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "rules",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to add comes from the signed challenge, never from this body.
    const { proposal, sha } = verified.binding;
    const row = typeof proposal === "string" ? ownProposal(deps, session, proposal) : null;
    if (row === null || typeof sha !== "string") {
      return c.json({ ok: false, message: "That proposal isn't waiting for you." }, 409);
    }
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
