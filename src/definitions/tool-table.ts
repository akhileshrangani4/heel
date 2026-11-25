import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Call, ProviderFields } from "../core/call.ts";
import type { Hiding } from "../core/hide.ts";
import type { StateCheck } from "../core/rules/compile.ts";
import {
  CredentialRejectedError,
  type Definition,
  type HardDenyReason,
  keyRejectedMessage,
  type Normalized,
  ResponseUnparseableError,
} from "../gateway/pipeline/ports.ts";
import { returnsSchema } from "./mail/returns-schema.ts";

/**
 * The shape of one built-in tool, shared by every built-in service:
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
 * `M` is the provider's per-call box: its client plus what several tools
 * read once per call.
 */

export interface Prepared<P> {
  args: P;
  /** Absent for a read: reads have no action. */
  action?: string;
  recipients?: string[];
  targets?: string[];
  /** Messages the call affects, after expanding threads and batches; 1 when absent. */
  items?: number;
  /** The tool leaves something behind that outlives revoking heel (I-70). */
  persistence?: boolean;
  /** The calendar a calendar tool touches. */
  calendar?: string;
  /** `owner/name` for a GitHub tool, lower-cased. */
  repo?: string;
  /** Provider fields rules can name. */
  fields?: ProviderFields;
}

export type Preparation<P> = Prepared<P> | { deny: HardDenyReason };

export interface ToolRow<M, S extends z.ZodType = z.ZodType, P = unknown, R = unknown> {
  description: string;
  /**
   * The shape of what `show` gives the agent, keys only:
   * `{"issues": [{"number", "title", ...}]}`. It's listed after the
   * description, so code mode's stubs and MCP clients know a result's shape
   * before the first call.
   */
  returns: string;
  args: S;
  readOnly: boolean;
  prepare(box: M, args: z.output<S>, hiding: Hiding, signal: AbortSignal): Promise<Preparation<P>>;
  run(box: M, args: P, signal: AbortSignal): Promise<R>;
  show(box: M, result: R, hiding: Hiding, signal: AbortSignal): Promise<unknown>;
}

/** Keeps each tool's own types while a service's table holds them all. */
export function toolRow<M>() {
  return <S extends z.ZodType, P, R>(row: ToolRow<M, S, P, R>) => row as unknown as ToolRow<M>;
}

/** `outputSchema` for a tool whose `returns` describes an object; nothing otherwise. */
function outputSchemaOf(returns: string): { outputSchema?: Tool["outputSchema"] } {
  const schema = returnsSchema(returns);
  return schema === null ? {} : { outputSchema: schema as Tool["outputSchema"] };
}

/** The tools as MCP lists them. */
export function listedTools<M>(tools: Record<string, ToolRow<M>>): Tool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: `${tool.description} Returns ${tool.returns}.`,
    inputSchema: z.toJSONSchema(tool.args, { io: "input" }) as Tool["inputSchema"],
    ...outputSchemaOf(tool.returns),
    annotations: tool.readOnly
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }));
}

/** A provider read found nothing. While preparing, it's denied like a hidden target (I-42). */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/**
 * A definition from a table of tools. It only routes: each tool's row
 * does the work.
 *
 * - The table is the only place a tool is marked read (I-20).
 * - Unknown tools and arguments outside a tool's schema are refused before
 *   any read.
 * - A read that fails while preparing denies the call; a missing target is
 *   denied exactly like a hidden one, `not_available` (I-42).
 * - Writes are never retried.
 */
export function toolTableDefinition<M>(input: {
  tools: Record<string, ToolRow<M>>;
  listed: readonly Tool[];
  box: M;
  stateCheck: (
    check: StateCheck,
    box: M,
    call: Call,
    signal: AbortSignal,
  ) => Promise<"pass" | "fail">;
}): Definition {
  const { tools, box } = input;
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
        prepared = await tool.prepare(box, parsed.data, ctx.hide, ctx.signal);
      } catch (error) {
        if (error instanceof NotFoundError) return { ok: false, reason: "not_available" };
        if (error instanceof CredentialRejectedError) {
          const detail = keyRejectedMessage(error.service, base.account);
          return { ok: false, reason: "lookup_unavailable", detail };
        }
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

    stateCheck: (check, call, signal) => input.stateCheck(check, box, call, signal),

    async execute(call, signal) {
      const tool = toolNamed(call.tool);
      if (tool === null) throw new Error(`no tool ${call.tool}`);
      return tool.run(box, call.args, signal);
    },

    async hide(call, result, hiding) {
      const tool = toolNamed(call.tool);
      if (tool === null) throw new ResponseUnparseableError();
      return tool.show(box, result, hiding, AbortSignal.timeout(60_000));
    },
  };
}
