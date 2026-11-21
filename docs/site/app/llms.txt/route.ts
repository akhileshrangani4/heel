import { docsLlms } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export const revalidate = false;

/**
 * What an agent reads first (llmstxt.org): what heel is, how to set it up
 * for its user, then every docs page as markdown.
 */
const INTRO = `# heel

> heel is an open-source, self-hosted permission gateway for AI agents. Agents reach GitHub, Gmail, Slack, any MCP server, API or CLI through heel, which holds the credentials and decides each call by its user's rules: it runs, it asks the user (who approves with a passkey), or it never runs. No model decides a call.

## Set up heel for your user

Follow ${siteUrl}/setup.md. It installs heel on your user's machine, connects you to it, and puts their services behind it. Your user makes a passkey and approves each connection and rule; you never hold their keys.

If you already reach heel over MCP, use its \`setup\` prompt and the \`heel_accounts\`, \`heel_request_connection\` and \`heel_propose_rules\` tools.

## Also

- [Roadmap](${siteUrl}/roadmap): what heel is building next.
- [Changelog](${siteUrl}/changelog): every release.
- [Source](https://github.com/akhileshrangani4/heel) and npm package \`useheel\`.

## Docs
`;

export async function GET() {
  const generated = await (await docsLlms.serve('/llms.txt'))!.text();
  // The generated index starts with its own "# heel" title; ours replaces it.
  const pages = generated.replace(/^# heel\s*/, '');
  return new Response(`${INTRO}\n${pages}`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
