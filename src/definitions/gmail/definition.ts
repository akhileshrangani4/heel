import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Definition,
  type Normalized,
  ResponseUnparseableError,
  UpstreamError,
} from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import type { FetchFn } from "../google/oauth.ts";
import { GmailClient, GmailNotFoundError, GmailWriteRefused } from "./client.ts";
import { Mailbox } from "./mailbox.ts";
import { READ_TOOLS } from "./reads.ts";
import { allInThread, SEND_TOOLS } from "./send.ts";
import type { GmailTool } from "./tool.ts";

/**
 * The Gmail definition: heel's own tools, calling the Gmail API with the
 * account's credential (spec: Email, "Gmail and Outlook"). Each tool is one
 * row in `reads.ts` or `send.ts`; this file only routes a call to its row.
 *
 * - The table is the only place a Gmail tool is marked read (I-20).
 * - Unknown tools and arguments outside a tool's schema are refused before
 *   any read.
 * - A read that fails while preparing denies the call; a missing target is
 *   denied exactly like a hidden one, `not_available` (I-42).
 * - Gmail refusing a write is an upstream error: the outcome is known. A
 *   write that never got an answer is left to the pipeline as unknown, and
 *   never retried.
 */

export interface GmailDeps {
  vault: Vault;
  fetch: FetchFn;
}

const TOOLS: Record<string, GmailTool> = { ...READ_TOOLS, ...SEND_TOOLS };

function toolNamed(name: string): GmailTool | null {
  return Object.hasOwn(TOOLS, name) ? (TOOLS[name] as GmailTool) : null;
}

/** The tools as MCP lists them. */
export const GMAIL_TOOLS: readonly Tool[] = Object.entries(TOOLS).map(([name, tool]) => ({
  name,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.args, { io: "input" }) as Tool["inputSchema"],
  annotations: tool.readOnly
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}));

export function gmailDefinition(account: AccountRecord, deps: GmailDeps): Definition {
  const mailbox = new Mailbox(
    new GmailClient(deps.fetch, async () => (await deps.vault.accessToken(account.id)).reveal()),
  );

  return {
    tools: async () => [...GMAIL_TOOLS],

    async normalize(base, ctx): Promise<Normalized> {
      const tool = toolNamed(base.tool);
      if (tool === null) return { ok: false, reason: "unsupported" };
      const parsed = tool.args.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      let prepared: Awaited<ReturnType<GmailTool["prepare"]>>;
      try {
        prepared = await tool.prepare(mailbox, parsed.data, ctx.hide, ctx.signal);
      } catch (error) {
        if (error instanceof GmailNotFoundError) return { ok: false, reason: "not_available" };
        return { ok: false, reason: "lookup_unavailable" };
      }
      if ("deny" in prepared) return { ok: false, reason: prepared.deny };
      return {
        ok: true,
        call: {
          ...base,
          args: prepared.args,
          kind: tool.readOnly ? "read" : "write",
          items: 1,
          ...(prepared.action === undefined ? {} : { action: prepared.action }),
          ...(prepared.recipients === undefined ? {} : { recipients: prepared.recipients }),
          ...(prepared.targets === undefined ? {} : { targets: prepared.targets }),
        },
      };
    },

    async stateCheck(check, call, signal) {
      if (check !== "all_in_thread") return "fail";
      return allInThread(mailbox, call, signal);
    },

    async execute(call, signal) {
      const tool = toolNamed(call.tool);
      if (tool === null) throw new Error(`no Gmail tool ${call.tool}`);
      try {
        return await tool.run(mailbox, call.args, signal);
      } catch (error) {
        if (error instanceof GmailWriteRefused) throw new UpstreamError(error.status, error.body);
        throw error;
      }
    },

    async hide(call, result, hiding) {
      const tool = toolNamed(call.tool);
      if (tool === null) throw new ResponseUnparseableError();
      return tool.show(mailbox, result, hiding, AbortSignal.timeout(60_000));
    },
  };
}
