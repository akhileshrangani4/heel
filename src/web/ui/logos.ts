import { type Html, html, trusted } from "./html.ts";

/**
 * Small inline marks for the services heel connects to, so a row reads
 * "Gmail" at a glance. They are simple drawings of each service's mark,
 * used only to say "this account is on X"; no image is fetched from
 * anywhere. Services without a mark here get a letter tile.
 */

const MARKS: Record<string, string> = {
  gmail: `<path fill="#4285F4" d="M2 7.2v10.4c0 .8.6 1.4 1.4 1.4h3.1v-8.4z"/><path fill="#34A853" d="M22 7.2v10.4c0 .8-.6 1.4-1.4 1.4h-3.1v-8.4z"/><path fill="#EA4335" d="M2 7.2 12 14.2l10-7v-.8c0-1.3-1.5-2.1-2.6-1.3L12 10.4 4.6 5.1C3.5 4.3 2 5.1 2 6.4z"/><path fill="#FBBC04" d="M17.5 8.3v2.3L22 7.2v-.8c0-1.3-1.5-2.1-2.6-1.3z"/><path fill="#C5221F" d="M2 6.4v.8l4.5 3.4V8.3L4.6 5.1C3.5 4.3 2 5.1 2 6.4z"/>`,
  "google-calendar": `<rect x="3" y="3" width="18" height="18" rx="2.5" fill="#fff" stroke="#4285F4" stroke-width="1.6"/><path fill="#4285F4" d="M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5V8H3z"/><text x="12" y="17.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="8.2" font-weight="700" fill="#1A73E8">31</text>`,
  outlook: `<rect x="9" y="4" width="13" height="16" rx="2" fill="#28A8EA"/><path fill="#0364B8" d="M9 9.5 22 9.5V7.6L15.5 4H11a2 2 0 0 0-2 2z" opacity=".55"/><rect x="2" y="6" width="12" height="12" rx="2" fill="#0A64C8"/><ellipse cx="8" cy="12" rx="2.6" ry="3.2" fill="none" stroke="#fff" stroke-width="1.7"/>`,
  github: `<path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>`,
  globe: `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></g>`,
  plug: `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></g>`,
  terminal: `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></g>`,
};

/** Which mark stands for a provider, or null for a letter tile. */
function markFor(provider: string): string | null {
  if (provider === "gmail") return "gmail";
  if (provider === "google-calendar") return "google-calendar";
  if (provider.startsWith("outlook") || provider === "microsoft") return "outlook";
  if (provider === "github" || provider === "cli:gh") return "github";
  if (provider === "http") return "globe";
  if (provider === "mcp") return "plug";
  if (provider.startsWith("cli")) return "terminal";
  return null;
}

/**
 * A service's mark in a small tile. `letterFrom` names the tile's letter when
 * the service has no mark (the alias or provider); decorative, since the row
 * names the service in words.
 */
export function serviceLogo(provider: string, letterFrom: string = provider): Html {
  const mark = markFor(provider);
  if (mark === null) {
    const letter = (letterFrom.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
    return html`<span class="svc-logo svc-letter" data-provider="${provider}" aria-hidden="true">${letter}</span>`;
  }
  return html`<span class="svc-logo" data-provider="${provider}" data-mark="${mark}" aria-hidden="true"
    >${trusted(`<svg viewBox="0 0 24 24" width="20" height="20">${MARKS[mark] ?? ""}</svg>`)}</span
  >`;
}
