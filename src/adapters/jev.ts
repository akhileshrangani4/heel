import {
  type ApprovalHint,
  hintsFromAnswers,
  JEV_QUESTIONS,
  type JevQuestionId,
  type JevState,
} from "../core/hints.ts";
import type { ApprovalAdapter, ApprovalHintInput } from "../gateway/pipeline/ports.ts";

/**
 * The Jev approval adapter: asks TypeSafe's Jev the questions in
 * core/hints.ts about a pending call and turns the answers into hints.
 *
 * Opt-in (`adapters.approval` in heel.yaml): it sends the call's arguments
 * and the agent's recent tool names to TypeSafe. It runs only for calls that
 * are already waiting for a person, never for allowed or denied ones.
 */

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** Arguments past this many characters of JSON are cut, with a marker. */
const MAX_ARGUMENTS = 24_000;

export interface JevAdapterOptions {
  apiKey: string;
  /** e.g. "jev-latest". */
  model: string;
  fetch?: typeof fetch;
  url?: string;
}

/** What Jev is shown: the call and the agent's recent work, no credentials. */
export function jevState(input: ApprovalHintInput): JevState {
  const json = JSON.stringify(input.call.args) ?? "null";
  return {
    agent: input.agentName,
    account: input.call.account,
    provider: input.call.provider,
    call: {
      tool: input.call.tool,
      action: input.call.action ?? null,
      arguments:
        json.length <= MAX_ARGUMENTS
          ? input.call.args
          : `${json.slice(0, MAX_ARGUMENTS)}… (cut: ${json.length} characters in all)`,
    },
    recent_calls: input.recentCalls.map((c) => ({
      account: c.account,
      tool: c.tool,
      action: c.action,
      outcome: c.outcome,
    })),
  };
}

export class JevAdapter implements ApprovalAdapter {
  readonly name = "jev";
  readonly #options: JevAdapterOptions;

  constructor(options: JevAdapterOptions) {
    this.#options = options;
  }

  async hints(input: ApprovalHintInput, signal: AbortSignal): Promise<ApprovalHint[]> {
    const firstCall = input.recentCalls.length === 0;
    // With nothing to compare against, code says so instead of asking.
    const questions = Object.fromEntries(
      Object.entries(JEV_QUESTIONS).filter(([id]) => !(firstCall && id === "like_recent_calls")),
    );
    const response = await (this.#options.fetch ?? fetch)(this.#options.url ?? TYPESAFE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify({ model: this.#options.model, state: jevState(input), questions }),
      signal,
    });
    if (!response.ok) throw new Error(`TypeSafe answered ${response.status}`);
    const body = (await response.json()) as { answers?: Record<string, unknown> };
    const answers: Partial<Record<JevQuestionId, number>> = {};
    for (const id of Object.keys(questions) as JevQuestionId[]) {
      const answer = body.answers?.[id] as { type?: unknown; noul?: unknown } | undefined;
      // A missing or malformed answer is an error, never a "no".
      if (
        answer?.type !== "noul" ||
        typeof answer.noul !== "number" ||
        !(answer.noul >= 0 && answer.noul <= 1)
      ) {
        throw new Error(`TypeSafe's answer to ${id} wasn't a Noul`);
      }
      answers[id] = answer.noul;
    }
    return hintsFromAnswers(answers, firstCall);
  }
}
