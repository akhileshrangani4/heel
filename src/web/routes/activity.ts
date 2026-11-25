import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AUDIT_EXPORT_MAX_PAGE } from "../../admin/protocol.ts";
import { exportAuditPage } from "../../audit/export.ts";
import { AUDIT_KINDS, type AuditKind } from "../../core/audit.ts";
import { suggestRules } from "../../core/suggestions.ts";
import { listAgents, workRootsOf } from "../../gateway/agents.ts";
import {
  accountsSeen,
  agentInventory,
  readActivity,
  wouldHaveStopped,
} from "../../store/activity.ts";
import { agents } from "../../store/schema.ts";
import {
  type HumanPlaneDeps,
  readSessionCookie,
  renderPage,
  requireCsrfField,
  requireSession,
  type SignedInEnv,
  viewerOf,
} from "../http.ts";
import { readSession, type SessionView } from "../sessions.ts";
import { ACTIVITY_SCRIPT, activityPage, activityRow } from "../ui/activity-page.ts";
import { clientScript } from "../ui/client.ts";
import { toHtmlString } from "../ui/html.ts";
import { agentsPage } from "../ui/manage-agents.ts";
import { suggestionCards } from "../ui/suggestions.ts";
import { suggestionsOf } from "./suggestions.ts";

/**
 * Observability on the human plane.
 *
 * - `GET /agents`: the agent inventory, with the last day's decisions.
 * - `GET /activity`: the event explorer, newest first, filtered by agent,
 *   account or decision, plus hide counts and rule suggestions.
 * - `GET /activity/stream`: new rows as server-sent events, resuming from
 *   `Last-Event-ID` after a reconnect.
 *
 * Members see their own agents only; admins see everyone's.
 */

const PAGE = 100;
const DAY_MS = 24 * 60 * 60_000;
const SUGGESTION_WINDOW_MS = 7 * DAY_MS;
const STREAM_POLL_MS = 1_000;
const STREAM_LIFETIME_MS = 10 * 60_000;

function visibleOwners(session: SessionView): string[] | null {
  return session.role === "admin" ? null : [session.userId];
}

/** A day from a date field (`YYYY-MM-DD`, UTC), or null for none or a bad one. */
function dayOf(text: string | undefined): Date | null {
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(day.getTime()) ? null : day;
}

function isKind(value: string | undefined): value is AuditKind {
  return value !== undefined && (AUDIT_KINDS as readonly string[]).includes(value);
}

/** What an agent change from the web app did, for the notice on Agents. */
function doneMessage(query: Record<string, string>): string | null {
  if ("revoked" in query) return "Revoked.";
  if ("workdir-added" in query) return "Folder added.";
  if ("workdir-removed" in query) return "Folder removed.";
  return null;
}

export function activityRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  function filterOf(query: Record<string, string>) {
    const nonEmpty = (v: string | undefined) => (v === undefined || v === "" ? undefined : v);
    const kind = nonEmpty(query["kind"]);
    return {
      agentId: nonEmpty(query["agent"]),
      account: nonEmpty(query["account"]),
      kind: isKind(kind) ? kind : undefined,
      scriptId: nonEmpty(query["script"]),
    };
  }

  function agentChoices(session: SessionView) {
    return deps.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        session.role === "admin"
          ? eq(agents.orgId, deps.orgId)
          : and(eq(agents.orgId, deps.orgId), eq(agents.ownerId, session.userId)),
      )
      .all();
  }

  app.get("/agents", signedIn, (c) => {
    const session = c.get("session");
    const list = agentInventory(deps.db, {
      orgId: deps.orgId,
      ownerIds: visibleOwners(session),
      since: new Date(deps.now().getTime() - DAY_MS),
    });
    return renderPage(c, {
      title: "Agents",
      viewer: viewerOf(session),
      script: clientScript(session.csrfToken),
      current: "agents",
      body: agentsPage({
        agents: list,
        sinceHours: 24,
        scripts: (deps.background?.list(visibleOwners(session)) ?? []).map((s) => ({
          ...s,
          stop: {
            action: `/agents/scripts/${encodeURIComponent(s.id)}/stop`,
            csrfToken: session.csrfToken,
          },
        })),
        stopped: "script-stopped" in c.req.query(),
        manage: {
          csrfToken: session.csrfToken,
          viewerId: session.userId,
          admin: session.role === "admin",
          workRoots: new Map(
            list.map((a) => [a.agentId, a.revoked ? [] : workRootsOf(deps.db, a.agentId)]),
          ),
          done: doneMessage(c.req.query()),
        },
        tokens: new Map(
          listAgents(deps.db, deps.orgId).map((a) => [
            a.id,
            a.hasToken ? (a.tokenExpiresAt ?? "never") : null,
          ]),
        ),
        now: deps.now(),
      }),
    });
  });

  // Stopping a background script only takes something away: a plain form, no passkey.
  app.post("/agents/scripts/:id/stop", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const mine = (deps.background?.list(visibleOwners(session)) ?? []).some((s) => s.id === id);
    if (!mine) return c.text("There's no running script with that id that you can stop.", 404);
    deps.background?.stop(id);
    deps.log.info({ script: id, by: session.userId }, "background script stopped");
    return c.redirect("/agents?script-stopped", 303);
  });

  app.get("/activity", signedIn, (c) => {
    const session = c.get("session");
    const query = c.req.query();
    const filter = filterOf(query);
    const before = Number.parseInt(query["before"] ?? "", 10);
    const rows = readActivity(deps.db, {
      orgId: deps.orgId,
      ownerIds: visibleOwners(session),
      ...filter,
      ...(Number.isFinite(before) ? { beforeId: before } : {}),
      limit: PAGE,
    });
    const stopped = wouldHaveStopped(deps.db, {
      orgId: deps.orgId,
      ownerIds: visibleOwners(session),
      since: new Date(deps.now().getTime() - SUGGESTION_WINDOW_MS),
    });
    return renderPage(c, {
      title: "Activity",
      viewer: viewerOf(session),
      current: "activity",
      body: activityPage({
        rows,
        now: deps.now(),
        agents: agentChoices(session),
        accounts: accountsSeen(deps.db, { orgId: deps.orgId, ownerIds: visibleOwners(session) }),
        filter: {
          agent: filter.agentId,
          account: filter.account,
          kind: filter.kind,
          script: filter.scriptId,
        },
        nextBefore: rows.length === PAGE ? (rows.at(-1)?.id ?? null) : null,
        paged: Number.isFinite(before),
        hidden: deps.hiddenCounts === undefined ? null : deps.hiddenCounts(),
        suggestions: suggestRules(stopped),
        canExport: session.role === "admin",
        learned: suggestionCards(
          suggestionsOf(deps, session, deps.now()),
          session.csrfToken,
          "activity",
        ),
      }),
      script: ACTIVITY_SCRIPT,
    });
  });

  /**
   * The whole audit log as JSON Lines, as `heel audit export` writes it:
   * admins only, since it's everyone's. Optional
   * `since` and `until` are days, both included. Paged from one snapshot, so
   * rows written meanwhile don't shift it.
   */
  app.get("/activity/export", signedIn, (c) => {
    const session = c.get("session");
    if (session.role !== "admin") return c.text("Only an admin exports the audit log.", 403);
    const since = dayOf(c.req.query("since"));
    const untilDay = dayOf(c.req.query("until"));
    const until = untilDay === null ? null : new Date(untilDay.getTime() + DAY_MS);
    deps.log.warn({ by: session.userId }, "audit log exported from the web app");
    let afterId = 0;
    let throughId: number | undefined;
    let done = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (done) {
          controller.close();
          return;
        }
        const page = exportAuditPage(deps.db, deps.orgId, {
          afterId,
          limit: AUDIT_EXPORT_MAX_PAGE,
          ...(since === null ? {} : { since }),
          ...(until === null ? {} : { until }),
          ...(throughId === undefined ? {} : { throughId }),
        });
        if (page.lines.length > 0) controller.enqueue(encoder.encode(page.lines.join("")));
        afterId = page.nextAfterId;
        throughId = page.throughId;
        done = page.done;
        if (done) controller.close();
      },
    });
    const day = deps.now().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="heel-audit-${day}.jsonl"`,
        "cache-control": "no-store",
      },
    });
  });

  app.get("/activity/stream", signedIn, (c) => {
    const session = c.get("session");
    const query = c.req.query();
    const filter = filterOf(query);
    const resumeFrom = Number.parseInt(c.req.header("last-event-id") ?? query["after"] ?? "0", 10);
    let after = Number.isFinite(resumeFrom) ? resumeFrom : 0;
    const names = new Map(agentChoices(session).map((a) => [a.id, a.name]));
    const cookie = readSessionCookie(c, deps);
    return streamSSE(c, async (stream) => {
      const ends = Date.now() + STREAM_LIFETIME_MS;
      while (!stream.aborted && Date.now() < ends) {
        // Signed out or expired since the stream opened: stop sending rows now,
        // not at the stream's 10-minute end. The browser's reconnect then fails
        // the session check, and the page says it's signed out.
        if (cookie === undefined || readSession(deps.db, cookie, deps.now()) === null) break;
        const rows = readActivity(deps.db, {
          orgId: deps.orgId,
          ownerIds: visibleOwners(session),
          ...filter,
          afterId: after,
          limit: PAGE,
        });
        for (const row of rows) {
          await stream.writeSSE({
            event: "row",
            id: String(row.id),
            data: toHtmlString(activityRow(row, names.get(row.agentId))),
          });
          after = row.id;
        }
        await stream.sleep(STREAM_POLL_MS);
      }
    });
  });

  return app;
}
