import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AUDIT_KINDS, type AuditKind } from "../../core/audit.ts";
import { suggestRules } from "../../core/suggestions.ts";
import { agentInventory, readActivity, wouldHaveStopped } from "../../store/activity.ts";
import { agents } from "../../store/schema.ts";
import {
  type HumanPlaneDeps,
  renderPage,
  requireSession,
  type SignedInEnv,
  viewerOf,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";
import { ACTIVITY_SCRIPT, activityPage, activityRow, agentsPage } from "../ui/activity-page.ts";
import { toHtmlString } from "../ui/html.ts";

/**
 * Observability on the human plane (A5).
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

function isKind(value: string | undefined): value is AuditKind {
  return value !== undefined && (AUDIT_KINDS as readonly string[]).includes(value);
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
      current: "agents",
      body: agentsPage({ agents: list, sinceHours: 24 }),
    });
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
        agents: agentChoices(session),
        filter: { agent: filter.agentId, account: filter.account, kind: filter.kind },
        nextBefore: rows.length === PAGE ? (rows.at(-1)?.id ?? null) : null,
        hidden: deps.hiddenCounts === undefined ? null : deps.hiddenCounts(),
        suggestions: suggestRules(stopped),
      }),
      script: ACTIVITY_SCRIPT,
    });
  });

  app.get("/activity/stream", signedIn, (c) => {
    const session = c.get("session");
    const query = c.req.query();
    const filter = filterOf(query);
    const resumeFrom = Number.parseInt(c.req.header("last-event-id") ?? query["after"] ?? "0", 10);
    let after = Number.isFinite(resumeFrom) ? resumeFrom : 0;
    return streamSSE(c, async (stream) => {
      const ends = Date.now() + STREAM_LIFETIME_MS;
      while (!stream.aborted && Date.now() < ends) {
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
            data: toHtmlString(activityRow(row)),
          });
          after = row.id;
        }
        await stream.sleep(STREAM_POLL_MS);
      }
    });
  });

  return app;
}
