import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * heel's releases, from release-please's CHANGELOG.md (copied into
 * content/ by scripts/sync.mjs). Parsing is pure so the page and the
 * roadmap's "latest release" read the same thing.
 */

export type ChangeKind = 'new' | 'fixed' | 'docs' | 'other';

export interface Change {
  /** The conventional-commit scope, e.g. `web`, when there is one. */
  scope: string | null;
  text: string;
  pr: { number: number; url: string } | null;
}

export interface Release {
  version: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** The GitHub compare link, when release-please gave one. */
  compareUrl: string | null;
  groups: { kind: ChangeKind; changes: Change[] }[];
}

const KIND: Record<string, ChangeKind> = {
  Features: 'new',
  'Bug Fixes': 'fixed',
  Documentation: 'docs',
};

/** "D5a MCP agent plane…" reads as "MCP agent plane…": the D/A codes are internal plan ids. */
function plain(text: string): string {
  return text.replace(/^[AD]\d+[a-z]?(?:-\d+)?\s+/, '').replaceAll(' — ', ': ');
}

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: Release['groups'][number] | null = null;
  for (const line of markdown.split('\n')) {
    const heading = /^## \[?(\d+\.\d+\.\d+)\]?(?:\(([^)]+)\))? \((\d{4}-\d{2}-\d{2})\)/.exec(line);
    if (heading) {
      release = {
        version: heading[1] ?? '',
        compareUrl: heading[2] ?? null,
        date: heading[3] ?? '',
        groups: [],
      };
      releases.push(release);
      group = null;
      continue;
    }
    const section = /^### (.+)$/.exec(line);
    if (section && release) {
      group = { kind: KIND[section[1]?.trim() ?? ''] ?? 'other', changes: [] };
      release.groups.push(group);
      continue;
    }
    const item = /^\* (?:\*\*([^*]+):\*\* )?(.+)$/.exec(line);
    if (item && group) {
      const body = item[2] ?? '';
      const prLink = /\(\[#(\d+)\]\(([^)]+)\)\)/.exec(body);
      const text = body
        .replace(/\s*\(\[#\d+\]\([^)]+\)\)/g, '')
        .replace(/\s*\(\[[0-9a-f]{7,}\]\([^)]+\)\)/g, '')
        .trim();
      group.changes.push({
        scope: item[1] ?? null,
        text: plain(text),
        pr: prLink ? { number: Number(prLink[1]), url: prLink[2] ?? '' } : null,
      });
    }
  }
  // Releases with nothing a person would notice (a version-only chore) keep
  // their place in history, with no groups.
  for (const r of releases) r.groups = r.groups.filter((g) => g.kind !== 'other');
  return releases;
}

/** The releases this site was built with. */
export function releases(): Release[] {
  try {
    return parseChangelog(readFileSync(join(process.cwd(), 'content', 'changelog.md'), 'utf8'));
  } catch {
    return [];
  }
}

/** "november 20, 2026", in the site's lowercase voice. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  return `${months.at((m ?? 1) - 1)} ${d}, ${y}`;
}
