import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ProviderFields } from "../../core/call.ts";
import { type Definition, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { listedTools, type MailTool, mailDefinition } from "../mail/tool.ts";
import type { FetchFn } from "../sign-in.ts";
import { LinearClient, LinearNotFoundError, LinearRefused } from "./client.ts";

/**
 * The Linear definition (D12b; spec: "Calendar, Slack, Linear, Notion,
 * Stripe"): heel's own tools on Linear's GraphQL API
 * (https://linear.app/developers/graphql), connected with
 * `heel connect linear --credential-stdin` (a personal API key or an OAuth
 * access token).
 *
 * - Actions: `linear.read`, `linear.issue.create`, `linear.issue.update`,
 *   `linear.issue.delete` and `linear.comment`.
 * - Rules see `team` (the team key, e.g. `ENG`) and `project` (the project
 *   id, when the issue has one), read from Linear before any rule. An issue
 *   named by its identifier (`ENG-123`) is resolved to its id, and the change
 *   is made to that id, the one rules saw.
 * - Moving an issue to another team or project isn't offered: a rule on the
 *   issue's team or project couldn't see where it goes.
 * - Deleting moves the issue to Linear's trash (`issueDelete`).
 * - heel offers no tool for webhooks, API keys or OAuth apps, which outlive
 *   revoking heel (I-70).
 */

export interface LinearDeps {
  vault: Vault;
  fetch: FetchFn;
}

interface Box {
  client: LinearClient;
}

type LinearTool = MailTool<Box>;
const tool = <S extends z.ZodType, P, R>(t: MailTool<Box, S, P, R>) => t as unknown as LinearTool;

const TeamKey = z
  .string()
  .regex(/^[A-Za-z0-9]{1,10}$/, "expected a team key like ENG")
  .transform((k) => k.toUpperCase());
const IssueRef = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9]{1,10}-[0-9]{1,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    "expected an issue identifier like ENG-123, or its id",
  );
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Title = z.string().min(1).max(255);
const Markdown = z.string().max(100_000);
const Priority = z.number().int().min(0).max(4);

const ISSUE_FIELDS = `id identifier title description url priority
  state { name } team { id key } project { id name } assignee { name }`;

interface LinearIssue {
  id: string;
  identifier: string;
  team: { id: string; key: string };
  project: { id: string } | null;
}

/**
 * The issue again, just before a write: if its team or project changed
 * since rules saw it (a person moved it while the call waited for approval),
 * nothing is sent.
 */
async function unmoved(
  box: Box,
  id: string,
  fields: { team?: unknown; project?: unknown },
  signal: AbortSignal,
) {
  const now = fieldsOf(await issueOf(box, id, signal));
  if (now.team !== fields.team || (now.project ?? null) !== (fields.project ?? null)) {
    throw new LinearRefused(["the issue moved to another team or project after heel checked it"]);
  }
}

/** Every sub-issue of an issue, at any depth, with its team and project. */
async function subIssues(
  box: Box,
  id: string,
  signal: AbortSignal,
): Promise<{ id: string; team: string; project: string | undefined }[]> {
  const found: { id: string; team: string; project: string | undefined }[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page > 20 || found.length > 1_000) throw new Error("too many sub-issues to read");
      const data = await box.client.request(
        `query Children($id: String!, $after: String) { issue(id: $id) {
          children(first: 100, after: $after) { nodes { id team { key } project { id } } pageInfo { hasNextPage endCursor } } } }`,
        { id: parent, after },
        signal,
      );
      const children = (data["issue"] as { children?: unknown } | null)?.children as
        | {
            nodes?: { id: string; team: { key: string }; project: { id: string } | null }[];
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          }
        | undefined;
      if (children?.nodes === undefined) throw new Error("the sub-issues aren't readable");
      for (const child of children.nodes) {
        found.push({
          id: child.id,
          team: child.team.key.toUpperCase(),
          project: child.project?.id,
        });
        queue.push(child.id);
      }
      if (children.pageInfo?.hasNextPage !== true) break;
      after = children.pageInfo.endCursor ?? null;
    }
  }
  return found;
}

/** One issue, read before rules: its id, team and project. */
async function issueOf(box: Box, ref: string, signal: AbortSignal): Promise<LinearIssue> {
  const data = await box.client.request(
    `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    { id: ref },
    signal,
  );
  const issue = data["issue"] as LinearIssue | null;
  if (issue === null || typeof issue?.id !== "string" || typeof issue.team?.key !== "string") {
    throw new LinearNotFoundError(`issue ${ref}`);
  }
  return issue;
}

function fieldsOf(issue: LinearIssue): ProviderFields {
  return {
    team: issue.team.key.toUpperCase(),
    ...(issue.project === null ? {} : { project: issue.project.id }),
  };
}

async function teamId(box: Box, key: string, signal: AbortSignal): Promise<string> {
  const data = await box.client.request(
    `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
    { key },
    signal,
  );
  const nodes = (data["teams"] as { nodes?: { id: string; key: string }[] } | null)?.nodes ?? [];
  const match = nodes.filter((t) => t.key.toUpperCase() === key);
  if (match.length !== 1 || match[0] === undefined) throw new LinearNotFoundError(`team ${key}`);
  return match[0].id;
}

const shownIssue = (raw: unknown) => {
  const i = raw as Record<string, unknown> | null;
  if (i === null) return null;
  return {
    id: i["id"],
    identifier: i["identifier"],
    title: i["title"],
    description: i["description"] ?? null,
    state: (i["state"] as { name?: unknown } | null)?.name ?? null,
    priority: i["priority"] ?? null,
    team: (i["team"] as { key?: unknown } | null)?.key ?? null,
    project: (i["project"] as { name?: unknown } | null)?.name ?? null,
    assignee: (i["assignee"] as { name?: unknown } | null)?.name ?? null,
    url: i["url"] ?? null,
  };
};

/** The result of a mutation: its `success`, or an error when Linear said no. */
function mutated(data: Record<string, unknown>, name: string) {
  const payload = data[name] as { success?: unknown } & Record<string, unknown>;
  if (payload?.success !== true) throw new LinearRefused([`${name} didn't succeed`]);
  return payload;
}

const TOOLS: Record<string, LinearTool> = {
  list_issues: tool({
    description: "List a team's issues, most recently updated first.",
    args: z.strictObject({
      team: TeamKey,
      first: z.number().int().min(1).max(100).default(25),
      after: z.string().max(500).optional(),
    }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, action: "linear.read", fields: { team: args.team } }),
    run: (box, a, signal) =>
      box.client.request(
        `query Issues($team: String!, $first: Int!, $after: String) {
          issues(filter: { team: { key: { eq: $team } } }, first: $first, after: $after, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { team: a.team, first: a.first, after: a.after ?? null },
        signal,
      ),
    show: async (_box, data: Record<string, unknown>) => {
      const issues = data["issues"] as {
        nodes?: unknown[];
        pageInfo?: { endCursor?: unknown; hasNextPage?: unknown };
      };
      return {
        issues: (issues?.nodes ?? []).map(shownIssue),
        next: issues?.pageInfo?.hasNextPage === true ? (issues.pageInfo.endCursor ?? null) : null,
      };
    },
  }),

  get_issue: tool({
    description: "Read one issue by its identifier (ENG-123) or id.",
    args: z.strictObject({ issue: IssueRef }),
    readOnly: true,
    prepare: async (box, args, _h, signal) => {
      const issue = await issueOf(box, args.issue, signal);
      return {
        args: { issue: issue.id },
        action: "linear.read",
        fields: fieldsOf(issue),
        targets: [issue.id],
      };
    },
    run: (box, a, signal) =>
      box.client.request(
        `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id: a.issue },
        signal,
      ),
    show: async (_box, data: Record<string, unknown>) => shownIssue(data["issue"]),
  }),

  create_issue: tool({
    description: "Open an issue in a team.",
    args: z.strictObject({
      team: TeamKey,
      title: Title,
      description: Markdown.optional(),
      priority: Priority.optional(),
      project_id: Uuid.optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => ({
      args: { ...args, team_id: await teamId(box, args.team, signal) },
      action: "linear.issue.create",
      fields: {
        team: args.team,
        ...(args.project_id === undefined ? {} : { project: args.project_id }),
      },
    }),
    run: async (box, a, signal) =>
      mutated(
        await box.client.request(
          `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
          {
            input: {
              teamId: a.team_id,
              title: a.title,
              ...(a.description === undefined ? {} : { description: a.description }),
              ...(a.priority === undefined ? {} : { priority: a.priority }),
              ...(a.project_id === undefined ? {} : { projectId: a.project_id }),
            },
          },
          signal,
          true,
        ),
        "issueCreate",
      ),
    show: async (_box, payload: Record<string, unknown>) => shownIssue(payload["issue"]),
  }),

  update_issue: tool({
    description:
      "Change an issue's title, description, priority or state. Moving it to another team or project isn't offered.",
    args: z.strictObject({
      issue: IssueRef,
      title: Title.optional(),
      description: Markdown.optional(),
      priority: Priority.optional(),
      state_id: Uuid.optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const issue = await issueOf(box, args.issue, signal);
      return {
        args: { ...args, issue: issue.id, checked: fieldsOf(issue) },
        action: "linear.issue.update",
        fields: fieldsOf(issue),
        targets: [issue.id],
      };
    },
    run: async (box, { issue, state_id, checked, ...change }, signal) => {
      await unmoved(box, issue, checked, signal);
      return mutated(
        await box.client.request(
          `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
          {
            id: issue,
            input: { ...change, ...(state_id === undefined ? {} : { stateId: state_id }) },
          },
          signal,
          true,
        ),
        "issueUpdate",
      );
    },
    show: async (_box, payload: Record<string, unknown>) => shownIssue(payload["issue"]),
  }),

  delete_issue: tool({
    description:
      "Move an issue to Linear's trash, with its sub-issues. Refused when a sub-issue is in another team or project.",
    args: z.strictObject({ issue: IssueRef }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const issue = await issueOf(box, args.issue, signal);
      const fields = fieldsOf(issue);
      // issueDelete also trashes the issue's sub-issues: each must sit where rules looked.
      const children = await subIssues(box, issue.id, signal);
      if (
        children.some(
          (c) => c.team !== fields.team || (c.project ?? null) !== (fields.project ?? null),
        )
      ) {
        return { deny: "unsupported" };
      }
      return {
        args: { issue: issue.id, checked: fields },
        action: "linear.issue.delete",
        fields,
        targets: [issue.id, ...children.map((c) => c.id)],
        items: 1 + children.length,
      };
    },
    run: async (box, a, signal) => {
      await unmoved(box, a.issue, a.checked, signal);
      return mutated(
        await box.client.request(
          `mutation Delete($id: String!) { issueDelete(id: $id) { success } }`,
          { id: a.issue },
          signal,
          true,
        ),
        "issueDelete",
      );
    },
    show: async () => ({ deleted: true }),
  }),

  add_comment: tool({
    description: "Comment on an issue.",
    args: z.strictObject({ issue: IssueRef, body: Markdown.min(1) }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const issue = await issueOf(box, args.issue, signal);
      return {
        args: { ...args, issue: issue.id, checked: fieldsOf(issue) },
        action: "linear.comment",
        fields: fieldsOf(issue),
        targets: [issue.id],
      };
    },
    run: async (box, a, signal) => {
      await unmoved(box, a.issue, a.checked, signal);
      return mutated(
        await box.client.request(
          `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
          { input: { issueId: a.issue, body: a.body } },
          signal,
          true,
        ),
        "commentCreate",
      );
    },
    show: async (_box, payload: Record<string, unknown>) => {
      const c = payload["comment"] as { id?: unknown; url?: unknown } | undefined;
      return { id: c?.id ?? null, url: c?.url ?? null };
    },
  }),
};

export const LINEAR_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function linearDefinition(account: AccountRecord, deps: LinearDeps): Definition {
  const token = async () => (await deps.vault.accessToken(account.id)).reveal();
  return mailDefinition({
    tools: TOOLS,
    listed: LINEAR_TOOLS,
    mailbox: { client: new LinearClient(deps.fetch, token) },
    errors: {
      isNotFound: (error) => error instanceof LinearNotFoundError,
      refusal: (error) =>
        error instanceof LinearRefused ? new UpstreamError(400, { errors: error.messages }) : null,
    },
    stateCheck: async () => "fail",
  });
}
