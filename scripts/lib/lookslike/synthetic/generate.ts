/**
 * Renders synthetic families into `LooksLikeMessage`s and splits them.
 *
 * Every message gets its own RNG seeded from `seed:family:index`, so adding or
 * editing one family never changes another family's messages. The layout
 * around the template wording is randomized identically for positives and
 * negatives (format, greeting, footer, click tracking, forwarding) so none of
 * it can tell the classes apart.
 */
import type { LooksLikeCategory, LooksLikeMessage } from "../../../../src/core/lookslike/types.ts";
import { unitHash } from "../hashing.ts";
import { type Ctx, makeContext, makeRng } from "./context.ts";
import { type Block, type Draft, FAMILIES, type Family } from "./families.ts";
import type { SourceId } from "./sources.ts";

export interface RenderVariant {
  format: "text" | "html";
  /** Links rewritten through an email click tracker. */
  tracked: boolean;
  /** Wrapped as a forwarded message. */
  forwarded: boolean;
}

export interface SyntheticMessage {
  id: string;
  family: string;
  source: SourceId;
  /** The unit the held-out split is drawn over: the source, or the family for heel-written mail. */
  splitUnit: string;
  labels: readonly LooksLikeCategory[];
  variant: RenderVariant;
  message: LooksLikeMessage;
}

const GREETINGS = [
  "Hi {first},",
  "Hello {first},",
  "Hello,",
  "Hi there,",
  "Dear {first} {last},",
] as const;

function footers(ctx: Ctx): string[] {
  return [
    `You're receiving this email because you have an account with ${ctx.brand}.`,
    `© 2026 ${ctx.brand}. All rights reserved.`,
    "This is an automated message. Please do not reply.",
    `Need help? Contact us at support@${ctx.host}.`,
    `Privacy: https://${ctx.host}/privacy · Terms: https://${ctx.host}/terms`,
    `${ctx.brand}, ${ctx.rng.int(1, 999)} Main Street, Springfield`,
  ];
}

function trackerUrl(ctx: Ctx): string {
  const host = ctx.rng.pick([
    `email.${ctx.host}`,
    `links.${ctx.host}`,
    "click.mailer.example",
    "t.sendgrid.example",
  ]);
  return `https://${host}/ls/click?upn=${ctx.token(ctx.rng.int(60, 140))}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function greetingFor(draft: Draft, ctx: Ctx): string | undefined {
  if (draft.greeting !== undefined) return draft.greeting;
  if (!ctx.rng.chance(0.5)) return undefined;
  return ctx.rng
    .pick(GREETINGS)
    .replace("{first}", ctx.user.first)
    .replace("{last}", ctx.user.last);
}

function renderTextBlock(block: Block, ctx: Ctx, tracked: boolean): string {
  switch (block.kind) {
    case "heading":
    case "text":
      return block.text;
    case "code":
      return ctx.rng.chance(0.3) ? `    ${block.code}` : block.code;
    case "rule":
      return "----------------------------------------";
    case "link": {
      const href = tracked ? trackerUrl(ctx) : block.url;
      return block.label !== undefined && block.label !== block.url && ctx.rng.chance(0.6)
        ? `${block.label}: ${href}`
        : href;
    }
  }
}

function renderHtmlBlock(block: Block, ctx: Ctx, tracked: boolean): string {
  const multiline = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");
  switch (block.kind) {
    case "heading":
      return `<h2 style="font-size:20px;margin:0 0 16px">${multiline(block.text)}</h2>`;
    case "text":
      return `<p style="margin:0 0 12px;line-height:1.5">${multiline(block.text)}</p>`;
    case "code":
      return `<p style="font-size:28px;letter-spacing:6px;font-weight:bold;font-family:monospace">${escapeHtml(block.code)}</p>`;
    case "rule":
      return '<hr style="border:none;border-top:1px solid #ddd">';
    case "link": {
      const href = tracked ? trackerUrl(ctx) : block.url;
      const label = block.label ?? block.url;
      return block.label === undefined
        ? `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`
        : `<table role="presentation"><tr><td style="background:#1a73e8;border-radius:4px;padding:10px 18px"><a href="${escapeHtml(href)}" style="color:#fff;text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`;
    }
  }
}

function forwardHeader(ctx: Ctx, subject: string): string {
  return [
    "---------- Forwarded message ---------",
    `From: ${ctx.from}`,
    `Date: ${ctx.when()}`,
    `Subject: ${subject}`,
    `To: <${ctx.user.email}>`,
  ].join("\n");
}

/** Renders one draft. Pure given `ctx`'s RNG state. */
export function renderDraft(draft: Draft, ctx: Ctx, variant: RenderVariant): LooksLikeMessage {
  const greeting = greetingFor(draft, ctx);
  const pool = footers(ctx);
  const footerLines = Array.from({ length: ctx.rng.int(0, 2) }, () => ctx.rng.pick(pool));
  const subject = variant.forwarded ? `Fwd: ${draft.subject}` : draft.subject;
  // A forward comes from the user's own mailbox, not from the service.
  const from = variant.forwarded
    ? `${ctx.user.first} ${ctx.user.last} <${ctx.user.email}>`
    : ctx.from;

  if (variant.format === "text") {
    const parts = [
      ...(variant.forwarded ? [forwardHeader(ctx, draft.subject)] : []),
      ...(greeting === undefined ? [] : [greeting]),
      ...draft.blocks.map((block) => renderTextBlock(block, ctx, variant.tracked)),
      ...footerLines,
    ];
    return { subject, from, body: `${parts.join("\n\n")}\n`, bodyFormat: "text" };
  }

  const inner = [
    ...(variant.forwarded
      ? [
          `<div class="gmail_quote">${escapeHtml(forwardHeader(ctx, draft.subject)).replace(/\n/g, "<br>")}<br><br>`,
        ]
      : []),
    ...(greeting === undefined ? [] : [`<p>${escapeHtml(greeting)}</p>`]),
    ...draft.blocks.map((block) => renderHtmlBlock(block, ctx, variant.tracked)),
    ...footerLines.map((line) => `<p style="color:#888;font-size:12px">${escapeHtml(line)}</p>`),
    ...(variant.forwarded ? ["</div>"] : []),
  ].join("\n");
  const preheader =
    draft.preheader === undefined
      ? ""
      : `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(draft.preheader)}</div>\n`;
  const body = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(draft.subject)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;color:#222}a{color:#1a73e8}</style></head>
<body>${preheader}<table role="presentation" width="100%"><tr><td style="max-width:600px;padding:24px">
${inner}
</td></tr></table></body></html>
`;
  return { subject, from, body, bodyFormat: "html" };
}

/** The held-out unit: a whole source, except heel-written mail, which is split per family. */
export function splitUnit(family: Pick<Family, "id" | "source">): string {
  return family.source === "heel" ? `heel:${family.id}` : family.source;
}

export function generateFamily(family: Family, seed: string, count: number): SyntheticMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const rng = makeRng(`${seed}:${family.id}:${index}`);
    const ctx = makeContext(rng);
    const variant: RenderVariant = {
      format: rng.chance(0.25) ? (family.format === "html" ? "text" : "html") : family.format,
      tracked: rng.chance(0.3),
      forwarded: rng.chance(0.08),
    };
    return {
      id: `${family.id}#${index}`,
      family: family.id,
      source: family.source,
      splitUnit: splitUnit(family),
      labels: family.labels,
      variant,
      message: renderDraft(family.draft(ctx), ctx, variant),
    };
  });
}

export interface SyntheticCorpusOptions {
  seed: string;
  perFamily: number;
  /** Share of split units held out in each stratum, rounded up. */
  heldOutShare: number;
}

export interface SyntheticCorpus {
  train: SyntheticMessage[];
  heldOut: SyntheticMessage[];
  heldOutUnits: string[];
}

function lowestHashed(units: ReadonlySet<string>, seed: string, share: number): string[] {
  const ranked = [...units].sort(
    (a, b) => unitHash(seed, a) - unitHash(seed, b) || a.localeCompare(b),
  );
  return ranked.slice(0, Math.ceil(share * ranked.length));
}

/**
 * Units are stratified into those with a positive family (template sources)
 * and negative-only ones (heel-written families). In each stratum the
 * `ceil(share * n)` units with the lowest `unitHash(seed, unit)` are held out:
 * an exact count, so the held-out size never depends on hash luck.
 */
export function selectHeldOutUnits(
  families: readonly Family[],
  seed: string,
  share: number,
): string[] {
  const withPositives = new Set(families.filter((f) => f.labels.length > 0).map(splitUnit));
  const negativeOnly = new Set(families.map(splitUnit).filter((unit) => !withPositives.has(unit)));
  return [
    ...lowestHashed(withPositives, seed, share),
    ...lowestHashed(negativeOnly, seed, share),
  ].sort();
}

/** Each split must hold both categories and negatives, or the gate measures nothing. */
function assertCoverage(name: string, families: readonly Family[]): void {
  const has = (category: LooksLikeCategory) => families.some((f) => f.labels.includes(category));
  const missing = [
    ...(has("password_reset") ? [] : ["password_reset"]),
    ...(has("login_code") ? [] : ["login_code"]),
    ...(families.some((f) => f.labels.length === 0) ? [] : ["negatives"]),
  ];
  if (missing.length > 0)
    throw new Error(`${name} split has no ${missing.join(", ")}: change the seed`);
}

export function generateSyntheticCorpus(
  options: SyntheticCorpusOptions,
  families: readonly Family[] = FAMILIES,
): SyntheticCorpus {
  const seen = new Set<string>();
  for (const family of families) {
    if (seen.has(family.id)) throw new Error(`duplicate family id ${family.id}`);
    seen.add(family.id);
  }
  const heldOutUnits = selectHeldOutUnits(families, options.seed, options.heldOutShare);
  const heldOutSet = new Set(heldOutUnits);
  const isHeldOut = (family: Family) => heldOutSet.has(splitUnit(family));
  assertCoverage("held-out", families.filter(isHeldOut));
  assertCoverage(
    "train",
    families.filter((family) => !isHeldOut(family)),
  );
  const train: SyntheticMessage[] = [];
  const heldOut: SyntheticMessage[] = [];
  for (const family of families) {
    const target = isHeldOut(family) ? heldOut : train;
    target.push(...generateFamily(family, options.seed, options.perFamily));
  }
  return { train, heldOut, heldOutUnits };
}
