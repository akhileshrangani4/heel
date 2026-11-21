import { siteUrl } from '@/lib/shared';

/**
 * Everyone may crawl, AI crawlers and agents fetching for a person included:
 * an agent is often who reads these docs and sets heel up. The named ones are
 * allowed explicitly so a blanket block elsewhere never reads as ours. Agents
 * are pointed at llms.txt and the setup prompt.
 */

export const dynamic = 'force-static';

const AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'cohere-ai',
  'Meta-ExternalAgent',
  'Amazonbot',
  'DuckAssistBot',
  'MistralAI-User',
];

export function GET() {
  const body = [
    '# Agents: start at /llms.txt. To set heel up for your user, follow /setup.md.',
    `# ${siteUrl}/llms.txt`,
    `# ${siteUrl}/setup.md`,
    '',
    ...AGENTS.flatMap((agent) => [`User-agent: ${agent}`, 'Allow: /', '']),
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
