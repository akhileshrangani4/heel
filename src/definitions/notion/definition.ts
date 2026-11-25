import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Definition, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { listedTools, type MailTool, mailDefinition } from "../mail/tool.ts";
import type { FetchFn } from "../sign-in.ts";
import { NotionClient, NotionNotFoundError, NotionRefused } from "./client.ts";

/**
 * The Notion definition: heel's own tools on Notion's REST API
 * (https://developers.notion.com/reference), connected with
 * `heel connect notion --credential-stdin` (an integration token).
 *
 * - Actions: `notion.read`, `notion.page.create`, `notion.page.update` and
 *   `notion.page.delete` (Notion's trash: the API can't delete for good).
 * - Rules see `parent`: the id of the page or database a page sits directly
 *   under (a database row's parent is its database, even when Notion names
 *   the data source too), or `workspace`. A page under a block (a column, a
 *   toggle) is followed up to the page holding the block. Only that nearest
 *   page counts: a rule on a page doesn't cover pages two levels below it.
 *   Read from Notion before any rule; a failed read denies the call, and
 *   every write reads it again just before sending, sending nothing if the
 *   page moved while the call waited.
 * - `search` has no parent: a rule keyed on `parent` doesn't limit what it
 *   lists.
 * - Content is plain paragraphs only, so what an approver reads is what is
 *   written.
 * - heel offers no tool for sharing or publishing a page, which outlives
 *   revoking heel (I-70).
 *
 * Endpoints: POST /v1/search, GET /v1/pages/{id}, GET /v1/blocks/{id},
 * GET and PATCH /v1/blocks/{id}/children, POST /v1/pages, PATCH /v1/pages/{id}.
 */

export interface NotionDeps {
  vault: Vault;
  fetch: FetchFn;
}

interface Box {
  client: NotionClient;
}

type NotionTool = MailTool<Box>;
const tool = <S extends z.ZodType, P, R>(t: MailTool<Box, S, P, R>) => t as unknown as NotionTool;

/** A Notion id, with or without dashes, as heel stores it: dashed and lower-case. */
const Id = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
    "expected a Notion id",
  )
  .transform((id) => {
    const hex = id.replaceAll("-", "").toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
const Cursor = z.string().max(500).optional();
const PageSize = z.number().int().min(1).max(100).default(25);
/** Notion caps one text object at 2,000 characters and one append at 100 blocks. */
const Paragraphs = z.array(z.string().min(1).max(2_000)).min(1).max(100);
const Title = z.string().min(1).max(2_000);

const MAX_HOPS = 8;

type Parent = { type?: unknown } & Record<string, unknown>;

/**
 * The `parent` rules see for an object: a page, database or data source id,
 * or `workspace`. A block parent is followed up until one of those.
 */
async function parentOf(
  box: Box,
  parent: Parent | undefined,
  signal: AbortSignal,
): Promise<string> {
  let current = parent;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const type = current?.type;
    if (type === "workspace") return "workspace";
    // A database row names its data source and its database: rules name the database.
    if (type === "data_source_id" && typeof current?.["database_id"] === "string") {
      return Id.parse(current["database_id"]);
    }
    if (type === "page_id" || type === "database_id" || type === "data_source_id") {
      const id = current?.[type];
      if (typeof id !== "string") break;
      return Id.parse(id);
    }
    if (type !== "block_id" || typeof current?.["block_id"] !== "string") break;
    const block = await box.client.request(
      "GET",
      `/v1/blocks/${Id.parse(current["block_id"])}`,
      signal,
    );
    current = block["parent"] as Parent | undefined;
  }
  throw new Error("Notion's parent for this object isn't readable");
}

/** The page's parent again, just before a write; nothing is sent if it moved. */
async function unmoved(box: Box, pageId: string, parent: string, signal: AbortSignal) {
  const now = await pageWithParent(box, pageId, signal);
  if (now.parent !== parent) throw new NotionRefused(409, "moved_after_check");
}

async function pageWithParent(box: Box, pageId: string, signal: AbortSignal) {
  const page = await box.client.request("GET", `/v1/pages/${pageId}`, signal);
  if (
    page["object"] !== "page" ||
    page["id"] === undefined ||
    Id.parse(String(page["id"])) !== pageId
  ) {
    throw new Error("Notion answered for another object");
  }
  return { page, parent: await parentOf(box, page["parent"] as Parent | undefined, signal) };
}

const plainText = (rich: unknown) =>
  Array.isArray(rich)
    ? rich.map((r) => (r as { plain_text?: unknown }).plain_text ?? "").join("")
    : "";

function titleOf(page: Record<string, unknown>): string {
  const props = (page["properties"] ?? {}) as Record<string, { type?: unknown; title?: unknown }>;
  const title = Object.values(props).find((p) => p?.type === "title");
  return plainText(title?.title);
}

const shownPage = (page: Record<string, unknown>) => ({
  id: page["id"],
  title: titleOf(page),
  url: page["url"] ?? null,
  in_trash: page["in_trash"] === true,
});

const paragraph = (content: string) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content } }] },
});

const TOOLS: Record<string, NotionTool> = {
  search: tool({
    returns: '{"pages": [{"id", "title", "url", "in_trash"}, ...], "next_cursor"}',
    description: "Search the pages this integration can see, by title.",
    args: z.strictObject({
      query: z.string().max(500).default(""),
      page_size: PageSize,
      start_cursor: Cursor,
    }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, action: "notion.read" }),
    run: (box, a, signal) =>
      box.client.request("POST", "/v1/search", signal, {
        query: a.query,
        page_size: a.page_size,
        filter: { property: "object", value: "page" },
        ...(a.start_cursor === undefined ? {} : { start_cursor: a.start_cursor }),
      }),
    show: async (_box, body: Record<string, unknown>) => ({
      pages: Array.isArray(body["results"])
        ? (body["results"] as Record<string, unknown>[]).map(shownPage)
        : [],
      next_cursor: body["next_cursor"] ?? null,
    }),
  }),

  get_page: tool({
    returns: '{"id", "title", "url", "in_trash"}',
    description: "Read a page's title and where it is.",
    args: z.strictObject({ page_id: Id }),
    readOnly: true,
    prepare: async (box, args, _h, signal) => {
      const { parent } = await pageWithParent(box, args.page_id, signal);
      return { args, action: "notion.read", fields: { parent }, targets: [args.page_id] };
    },
    run: (box, a, signal) => box.client.request("GET", `/v1/pages/${a.page_id}`, signal),
    show: async (_box, page: Record<string, unknown>) => shownPage(page),
  }),

  read_page: tool({
    returns: '{"blocks": [{"id", "type", "text"}, ...], "next_cursor"}',
    description: "Read a page's content, as plain text, one entry per block.",
    args: z.strictObject({ page_id: Id, start_cursor: Cursor, page_size: PageSize }),
    readOnly: true,
    prepare: async (box, args, _h, signal) => {
      const { parent } = await pageWithParent(box, args.page_id, signal);
      return { args, action: "notion.read", fields: { parent }, targets: [args.page_id] };
    },
    run: (box, a, signal) =>
      box.client.request("GET", `/v1/blocks/${a.page_id}/children`, signal, undefined, {
        page_size: a.page_size,
        start_cursor: a.start_cursor,
      }),
    show: async (_box, body: Record<string, unknown>) => ({
      blocks: Array.isArray(body["results"])
        ? (body["results"] as Record<string, unknown>[]).map((b) => {
            const type = String(b["type"] ?? "");
            const content = (b[type] ?? {}) as { rich_text?: unknown };
            return { id: b["id"], type, text: plainText(content.rich_text) };
          })
        : [],
      next_cursor: body["next_cursor"] ?? null,
    }),
  }),

  create_page: tool({
    returns: '{"id", "title", "url", "in_trash"}',
    description: "Create a page under another page, with a title and plain paragraphs.",
    args: z.strictObject({ parent_page_id: Id, title: Title, paragraphs: Paragraphs.optional() }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      // The parent must be there, and readable: a missing one is not available.
      await pageWithParent(box, args.parent_page_id, signal);
      return { args, action: "notion.page.create", fields: { parent: args.parent_page_id } };
    },
    run: (box, a, signal) =>
      box.client.request("POST", "/v1/pages", signal, {
        parent: { type: "page_id", page_id: a.parent_page_id },
        properties: { title: { title: [{ type: "text", text: { content: a.title } }] } },
        ...(a.paragraphs === undefined ? {} : { children: a.paragraphs.map(paragraph) }),
      }),
    show: async (_box, page: Record<string, unknown>) => shownPage(page),
  }),

  append_paragraphs: tool({
    returns: '{"appended"}',
    description: "Add plain paragraphs to the end of a page.",
    args: z.strictObject({ page_id: Id, paragraphs: Paragraphs }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const { parent } = await pageWithParent(box, args.page_id, signal);
      return {
        args: { ...args, checked_parent: parent },
        action: "notion.page.update",
        fields: { parent },
        targets: [args.page_id],
      };
    },
    run: async (box, a, signal) => {
      await unmoved(box, a.page_id, a.checked_parent, signal);
      return box.client.request("PATCH", `/v1/blocks/${a.page_id}/children`, signal, {
        children: a.paragraphs.map(paragraph),
      });
    },
    show: async () => ({ appended: true }),
  }),

  trash_page: tool({
    returns: '{"id", "title", "url", "in_trash"}',
    description: "Move a page to Notion's trash, where it can be restored for 30 days.",
    args: z.strictObject({ page_id: Id }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const { parent } = await pageWithParent(box, args.page_id, signal);
      return {
        args: { ...args, checked_parent: parent },
        action: "notion.page.delete",
        fields: { parent },
        targets: [args.page_id],
      };
    },
    run: async (box, a, signal) => {
      await unmoved(box, a.page_id, a.checked_parent, signal);
      return box.client.request("PATCH", `/v1/pages/${a.page_id}`, signal, { in_trash: true });
    },
    show: async (_box, page: Record<string, unknown>) => shownPage(page),
  }),
};

export const NOTION_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function notionDefinition(account: AccountRecord, deps: NotionDeps): Definition {
  const token = async () => (await deps.vault.accessToken(account.id)).reveal();
  return mailDefinition({
    tools: TOOLS,
    listed: NOTION_TOOLS,
    mailbox: { client: new NotionClient(deps.fetch, token) },
    errors: {
      isNotFound: (error) => error instanceof NotionNotFoundError,
      refusal: (error) =>
        error instanceof NotionRefused
          ? new UpstreamError(error.status, { code: error.code })
          : null,
    },
    stateCheck: async () => "fail",
  });
}
