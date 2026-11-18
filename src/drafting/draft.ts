import type { Secret } from "../vault/secret.ts";

/**
 * Rule drafting (D13b; spec: Teams, "Rule drafting"; README "You can
 * describe a rule in words"). A configured, OpenAI-compatible model turns a
 * description into a rules file.
 *
 * What the model is sent is exactly four things, and `draftMessages` is the
 * only place they're put together: the description, the rules JSON Schema,
 * the person's account aliases with their providers, and the action names
 * those providers have. Never call data, messages, audit rows or credentials
 * (I-17). Drafting is never on the decision path: it is a CLI command that
 * prints a draft, and nothing reads its output but a person.
 */

export interface DraftingConfig {
  /** The API base, e.g. `https://api.openai.com/v1`; `chat/completions` is appended. */
  baseUrl: URL;
  model: string;
  /** Null for an endpoint that needs no key (a local model). */
  apiKey: Secret | null;
}

export interface DraftInput {
  description: string;
  schema: string;
  accounts: readonly { alias: string; provider: string }[];
  actions: readonly string[];
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class DraftingError extends Error {
  override readonly name = "DraftingError";
}

/** The actions each built-in provider maps its tools to (spec: Built-in providers). */
const PROVIDER_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["email.send", "email.draft", "email.remove", "email.filter", "email.label"],
  outlook: ["email.send", "email.draft", "email.remove", "email.filter", "email.label"],
  "google-calendar": [
    "calendar.read",
    "calendar.event.create",
    "calendar.event.update",
    "calendar.event.delete",
  ],
  github: [
    "github.read",
    "github.comment",
    "github.issue.create",
    "github.issue.update",
    "github.pr.create",
    "github.pr.update",
    "github.push",
    "github.merge",
    "github.workflow.push",
    "github.workflow.merge",
    "github.api",
  ],
  slack: ["slack.read", "slack.post", "slack.update", "slack.delete", "slack.schedule"],
  linear: [
    "linear.read",
    "linear.issue.create",
    "linear.issue.update",
    "linear.issue.delete",
    "linear.comment",
  ],
  notion: ["notion.read", "notion.page.create", "notion.page.update", "notion.page.delete"],
  stripe: [
    "stripe.read",
    "stripe.refund",
    "stripe.payment.create",
    "stripe.customer.update",
    "stripe.subscription.update",
  ],
};

/** The action names a set of providers has, sorted and without repeats. */
export function actionsFor(providers: readonly string[]): string[] {
  const out = new Set<string>();
  for (const provider of providers) {
    const key = provider === "cli:gh" ? "github" : provider;
    for (const action of PROVIDER_ACTIONS[key] ?? []) out.add(action);
  }
  return [...out].sort();
}

/** The chat messages sent to the model. Pure, and built from `DraftInput` alone. */
export function draftMessages(input: DraftInput): { role: "system" | "user"; content: string }[] {
  const accounts =
    input.accounts.length === 0
      ? "(none connected)"
      : input.accounts.map((a) => `- ${a.alias} (${a.provider})`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You write heel rules files: YAML with a top-level `rules:` list and an optional `hide:` list.",
        "Answer with the YAML file only, no prose and no code fences.",
        "Rules are evaluated top to bottom; the first match decides; anything unmatched is denied.",
        "Prefer `ask` over `allow` when a description is unsure. Never invent accounts or actions.",
        "The file must validate against this JSON Schema:",
        input.schema,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Accounts:\n${accounts}`,
        `Actions:\n${input.actions.length === 0 ? "(none)" : input.actions.join(", ")}`,
        `Describe as rules:\n${input.description}`,
      ].join("\n\n"),
    },
  ];
}

/** The YAML in a model's answer: the whole answer, or the inside of one fenced block. */
export function extractYaml(content: string): string {
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(content);
  const text = (fenced?.[1] ?? content).trim();
  return `${text}\n`;
}

/** Asks the model for a draft. Throws `DraftingError` for anything but a usable answer. */
export async function requestDraft(
  config: DraftingConfig,
  input: DraftInput,
  fetch: FetchFn,
  signal: AbortSignal,
): Promise<string> {
  const base = config.baseUrl.href.endsWith("/") ? config.baseUrl.href : `${config.baseUrl.href}/`;
  let response: Response;
  try {
    response = await fetch(new URL("chat/completions", base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey === null ? {} : { authorization: `Bearer ${config.apiKey.reveal()}` }),
      },
      body: JSON.stringify({ model: config.model, messages: draftMessages(input), temperature: 0 }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw new DraftingError(`the drafting model isn't reachable: ${(error as Error).message}`);
  }
  if (!response.ok) throw new DraftingError(`the drafting model answered ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DraftingError("the drafting model's answer isn't JSON");
  }
  const content = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
    ?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new DraftingError("the drafting model's answer has no draft in it");
  }
  return extractYaml(content);
}

/**
 * A line diff of `before` and `after`, `-` for removed lines and `+` for
 * added ones, unchanged lines indented. Small inputs only (rules files).
 */
export function lineDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return `${out.join("\n")}\n`;
}
