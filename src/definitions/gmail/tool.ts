import { z } from "zod";
import type { Hiding } from "../../core/hide.ts";
import type { HardDenyReason } from "../../gateway/pipeline/ports.ts";
import type { Mailbox } from "./mailbox.ts";

/**
 * The shape of one Gmail tool: everything heel knows about it in one place.
 *
 * 1. `args` validates what the agent sent; anything else is refused.
 * 2. `prepare` makes every read the call needs before rules run, and
 *    returns the arguments exactly as they will run plus the facts rules
 *    see (`action`, `recipients`, `targets`). What it returns is what the
 *    call hash covers and what an approver sees.
 * 3. `run` does the call, from those prepared arguments only.
 * 4. `show` turns what `run` returned into what the agent reads, dropping
 *    hidden messages.
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
}

export type Preparation<P> = Prepared<P> | { deny: HardDenyReason };

export interface GmailTool<S extends z.ZodType = z.ZodType, P = unknown, R = unknown> {
  description: string;
  args: S;
  readOnly: boolean;
  prepare(
    mailbox: Mailbox,
    args: z.output<S>,
    hiding: Hiding,
    signal: AbortSignal,
  ): Promise<Preparation<P>>;
  run(mailbox: Mailbox, args: P, signal: AbortSignal): Promise<R>;
  show(mailbox: Mailbox, result: R, hiding: Hiding, signal: AbortSignal): Promise<unknown>;
}

/** Keeps each tool's own types while the table holds them all. */
export function gmailTool<S extends z.ZodType, P, R>(tool: GmailTool<S, P, R>): GmailTool {
  return tool as unknown as GmailTool;
}

/** A Gmail message, thread or draft id. */
export const GmailId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "expected a Gmail id");
