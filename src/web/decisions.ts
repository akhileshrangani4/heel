import { type DecisionIntent, isStandingDuration } from "../core/approvals.ts";
import { PAUSE_SCOPES, type PauseScope } from "../core/call.ts";
import type { StandingChoice } from "../store/approvals.ts";
import { STANDING_SCOPES } from "../store/schema.ts";
import type { ChallengeBinding } from "./challenges.ts";

/**
 * What a passkey assertion authorizes, written into its challenge (I-56).
 *
 * The page asks for a challenge naming the exact decision, the person's
 * authenticator signs it, and the server reads the decision back out of the
 * verified challenge. Nothing a decision depends on comes from the request
 * that carries the assertion, so a captured assertion can't be replayed as a
 * different decision: not another approval, not another call, and not
 * "approve as standing for 30 days" in place of "approve once".
 *
 * Pure: these functions only translate between decisions and bindings.
 */

export interface Decision {
  approvalId: string;
  /** The call hash the person saw on the page. */
  callHash: string;
  intent: DecisionIntent;
  /** Set only for "approve as standing". */
  standing: StandingChoice | null;
}

/** A resume of one pause, by the scope and target the page showed. */
export interface Resume {
  scope: PauseScope;
  /** The name the page showed; "" for a global pause. */
  target: string;
}

/** Every field is always present, so two bindings differ only where the decisions do. */
export function decisionBinding(decision: Decision): ChallengeBinding {
  return {
    approvalId: decision.approvalId,
    callHash: decision.callHash,
    intent: decision.intent,
    standingScope: decision.standing?.scope ?? "",
    standingDuration: decision.standing?.duration ?? "",
  };
}

/** The decision a verified challenge authorizes, or null if the binding isn't a decision. */
export function decisionFromBinding(binding: ChallengeBinding): Decision | null {
  const { approvalId, callHash, intent, standingScope, standingDuration } = binding;
  if (!approvalId || !callHash) return null;
  if (intent !== "approve" && intent !== "deny") return null;
  if (standingScope === "" && standingDuration === "") {
    return { approvalId, callHash, intent, standing: null };
  }
  // A standing choice only makes sense on an approve, and both halves must be valid.
  if (intent !== "approve") return null;
  if (!isStandingScope(standingScope) || !isStandingDuration(standingDuration)) return null;
  return {
    approvalId,
    callHash,
    intent,
    standing: { scope: standingScope, duration: standingDuration },
  };
}

export function resumeBinding(resume: Resume): ChallengeBinding {
  return { scope: resume.scope, target: resume.target };
}

export function resumeFromBinding(binding: ChallengeBinding): Resume | null {
  const { scope, target } = binding;
  if (!isPauseScope(scope) || target === undefined) return null;
  return { scope, target };
}

function isStandingScope(value: unknown): value is StandingChoice["scope"] {
  return (STANDING_SCOPES as readonly unknown[]).includes(value);
}

function isPauseScope(value: unknown): value is PauseScope {
  return (PAUSE_SCOPES as readonly unknown[]).includes(value);
}
