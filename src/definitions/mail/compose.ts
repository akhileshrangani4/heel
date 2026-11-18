import { createHash } from "node:crypto";
import { z } from "zod";
import { isPlainAddress, normalizeAddress } from "../../core/rules/address.ts";
import { UpstreamError } from "../../gateway/pipeline/ports.ts";
import { ComposeMismatchError, composeRaw, type Outgoing } from "./mime.ts";

/**
 * What every built-in mail provider's sending tools share: how an agent's
 * addresses and text are validated, and how a failure before sending is
 * reported. See `mime.ts` for why heel sends only to plain addresses.
 */

/** An address as the agent gave it: a plain addr-spec, lower-cased. */
export const Address = z
  .string()
  .max(320)
  .transform((text, ctx) => {
    const address = normalizeAddress(text);
    if (address === null || !isPlainAddress(address)) {
      ctx.addIssue({ code: "custom", message: "expected a plain email address" });
      return z.NEVER;
    }
    return address;
  });

export const Addresses = z.array(Address).max(100);

/** Text that goes into a header: one line. */
export const HeaderText = z
  .string()
  .max(998)
  .regex(/^[^\r\n]*$/, "must be one line");

export const Body = z.string().max(1_000_000);

/** The arguments of a message heel composes from scratch. */
export const Composed = {
  from: Address,
  to: Addresses.min(1),
  cc: Addresses.default([]),
  bcc: Addresses.default([]),
  subject: HeaderText,
  body: Body,
  html: Body.optional(),
};

/** A message heel composes, exactly as it will run. */
export interface ComposedArgs {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: string | undefined;
}

export function unique(addresses: readonly string[]): string[] {
  return [...new Set(addresses)];
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A failure in `run` before anything was posted: the call's outcome is known. */
export function notSent(reason: string, status = 409): UpstreamError {
  return new UpstreamError(status, { error: `${reason}; nothing was sent` });
}

/** `Re:` or `Fwd:` in front of a subject, once. */
export function prefixed(prefix: "Re" | "Fwd", subject: string | null): string {
  const text = (subject ?? "").replace(/[\r\n]+/g, " ");
  return new RegExp(`^${prefix}:`, "i").test(text) ? text : `${prefix}: ${text}`;
}

/** An RFC 5322 message id, angle brackets included. */
export const MESSAGE_ID = /^<[^<>\s]+>$/;

/** `composeRaw`, with a mismatch reported as "not sent". */
export async function composeOrRefuse(message: Outgoing): Promise<string> {
  try {
    return await composeRaw(message);
  } catch (error) {
    if (error instanceof ComposeMismatchError) throw notSent(error.message, 422);
    throw error;
  }
}
