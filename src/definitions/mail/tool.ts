import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Call, ProviderFields } from "../../core/call.ts";
import type { Hiding } from "../../core/hide.ts";
import type { StateCheck } from "../../core/rules/compile.ts";
import {
  type Definition,
  type HardDenyReason,
  type Normalized,
  ResponseUnparseableError,
} from "../../gateway/pipeline/ports.ts";

/**
 * The shape of one built-in mail tool, shared by Gmail and Outlook:
 * everything heel knows about a tool in one place.
 *
 * 1. `args` validates what the agent sent; anything else is refused.
 * 2. `prepare` makes every read the call needs before rules run, and
 *    returns the arguments exactly as they will run plus the facts rules
 *    see (`action`, `recipients`, `targets`, `items`). What it returns is
 *    what the call hash covers and what an approver sees.
 * 3. `run` does the call, from those prepared arguments only.
 * 4. `show` turns what `run` returned into what the agent reads, dropping
 *    hidden messages.
 *
 * `M` is the provider's per-call mailbox: its client plus what several
 * tools read once per call.
 */

export interface Prepared<P> {
  args: P;
  /** Absent for a read: reads have no action (spec: Email, "—, read"). */
  action?: string;
  recipients?: string[];
  targets?: string[];
  /** Messages the call affects, after expanding threads and batches; 1 when absent. */
  items?: number;
  /** The tool leaves something behind that outlives revoking heel (I-70). */
  persistence?: boolean;
  /** The calendar a calendar tool touches (spec: Calendar). */
  calendar?: string;
  /** `owner/name` for a GitHub tool, lower-cased (D11). */
  repo?: string;
  /** Provider fields rules can name (D12b). */
  fields?: ProviderFields;
}

export type Preparation<P> = Prepared<P> | { deny: HardDenyReason };

export interface MailTool<M, S extends z.ZodType = z.ZodType, P = unknown, R = unknown> {
  description: string;
  args: S;
  readOnly: boolean;
  prepare(
    mailbox: M,
    args: z.output<S>,
    hiding: Hiding,
    signal: AbortSignal,
  ): Promise<Preparation<P>>;
  run(mailbox: M, args: P, signal: AbortSignal): Promise<R>;
  show(mailbox: M, result: R, hiding: Hiding, signal: AbortSignal): Promise<unknown>;
}

/** The tools as MCP lists them. */
export function listedTools<M>(tools: Record<string, MailTool<M>>): Tool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.args, { io: "input" }) as Tool["inputSchema"],
    annotations: tool.readOnly
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }));
}

/** How a provider's errors map onto the pipeline's outcomes. */
export interface ErrorMapping {
  /** A read while preparing found nothing: denied like a hidden target (I-42). */
  isNotFound(error: unknown): boolean;
  /**
   * A write the provider refused, so nothing happened: an upstream error
   * with a known outcome. Return null for anything else, which leaves the
   * outcome unknown.
   */
  refusal(error: unknown): Error | null;
}

/**
 * A definition from a table of mail tools. It only routes: each tool's row
 * does the work.
 *
 * - The table is the only place a tool is marked read (I-20).
 * - Unknown tools and arguments outside a tool's schema are refused before
 *   any read.
 * - A read that fails while preparing denies the call; a missing target is
 *   denied exactly like a hidden one, `not_available` (I-42).
 * - Writes are never retried.
 */
export function mailDefinition<M>(input: {
  tools: Record<string, MailTool<M>>;
  listed: readonly Tool[];
  mailbox: M;
  errors: ErrorMapping;
  stateCheck: (
    check: StateCheck,
    mailbox: M,
    call: Call,
    signal: AbortSignal,
  ) => Promise<"pass" | "fail">;
}): Definition {
  const { tools, mailbox, errors } = input;
  const toolNamed = (name: string) => (Object.hasOwn(tools, name) ? (tools[name] ?? null) : null);

  return {
    tools: async () => [...input.listed],

    async normalize(base, ctx): Promise<Normalized> {
      const tool = toolNamed(base.tool);
      if (tool === null) return { ok: false, reason: "unsupported" };
      const parsed = tool.args.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      let prepared: Preparation<unknown>;
      try {
        prepared = await tool.prepare(mailbox, parsed.data, ctx.hide, ctx.signal);
      } catch (error) {
        if (errors.isNotFound(error)) return { ok: false, reason: "not_available" };
        return { ok: false, reason: "lookup_unavailable" };
      }
      if ("deny" in prepared) return { ok: false, reason: prepared.deny };
      return {
        ok: true,
        call: {
          ...base,
          args: prepared.args,
          kind: tool.readOnly ? "read" : "write",
          items: prepared.items ?? 1,
          ...(prepared.action === undefined ? {} : { action: prepared.action }),
          ...(prepared.persistence === undefined ? {} : { persistence: prepared.persistence }),
          ...(prepared.calendar === undefined ? {} : { calendar: prepared.calendar }),
          ...(prepared.repo === undefined ? {} : { repo: prepared.repo }),
          ...(prepared.fields === undefined ? {} : { fields: prepared.fields }),
          ...(prepared.recipients === undefined ? {} : { recipients: prepared.recipients }),
          ...(prepared.targets === undefined ? {} : { targets: prepared.targets }),
        },
      };
    },

    stateCheck: (check, call, signal) => input.stateCheck(check, mailbox, call, signal),

    async execute(call, signal) {
      const tool = toolNamed(call.tool);
      if (tool === null) throw new Error(`no tool ${call.tool}`);
      try {
        return await tool.run(mailbox, call.args, signal);
      } catch (error) {
        throw errors.refusal(error) ?? error;
      }
    },

    async hide(call, result, hiding) {
      const tool = toolNamed(call.tool);
      if (tool === null) throw new ResponseUnparseableError();
      return tool.show(mailbox, result, hiding, AbortSignal.timeout(60_000));
    },
  };
}
