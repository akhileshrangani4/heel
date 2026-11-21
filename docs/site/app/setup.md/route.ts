import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The setup prompt, as plain text an agent reads: "set up heel for me by
 * following useheel.dev/setup.md" is all an owner has to say. It's the
 * prompt block of docs/setup.md (copied in at build by scripts/sync.mjs),
 * which heel's own tests keep identical to the prompt heel serves.
 */

export const dynamic = 'force-static';

function prompt(): string {
  const page = readFileSync(join(process.cwd(), 'content', 'docs', 'setup.md'), 'utf8');
  const start = page.indexOf('```text\n', page.indexOf('## The prompt'));
  const end = page.indexOf('\n```', start + 8);
  if (start < 0 || end < 0) throw new Error('docs/setup.md has no prompt block under "## The prompt"');
  return page.slice(start + 8, end);
}

export function GET() {
  return new Response(`${prompt()}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
