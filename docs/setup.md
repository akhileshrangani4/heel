# Set up heel with one prompt

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

Once your agent is connected to heel ([Connect your agent](agents.md)), one prompt has it put the rest of your services behind heel. It finds the services you use, asks heel to connect each one, proposes rules for them, and walks you through removing the raw keys heel now holds.

Nothing happens on its own. Every connection and every rule waits on heel's approval page until you approve it with your passkey, and the agent never reads a key's value.

## Run it

- **Claude Code:** type `/mcp__heel__setup`.
- **Other agents that support MCP prompts:** pick heel's `setup` prompt.
- **Anything else:** paste the prompt below.

## What you'll do

1. Read the agent's list of services it found and where each key lives now.
2. On heel's approval page, approve each connection: sign in (Gmail, Calendar, Outlook) or paste the service's key on heel's page (GitHub, Slack, Linear, Notion, Stripe).
3. Approve the rules it proposes, or change them first. Each one says what it's for.
4. Let the agent show you which old keys to remove, one change at a time.

## The prompt

```text
Help me put the services I use behind heel, so you reach them through heel and never hold their keys.

Rules for the whole task:
- Never read, print, copy or send the value of a key, token, password or secret. You may look at names only: environment variable names, which config files exist, which servers an MCP config lists.
- Don't edit, move or delete any file or setting without asking me first.
- Everything you ask heel for waits for me. I approve each request on heel's approval page with my passkey.

1. Call heel_accounts to see what's already behind heel and what's still waiting.

2. Find the services I use, by name only:
   - environment variables such as GH_TOKEN, GITHUB_TOKEN, SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_TOKEN, STRIPE_API_KEY (names only, never values);
   - the gh CLI's login (whether ~/.config/gh/hosts.yml exists);
   - the MCP servers in your own client's config, and which of them carry a token;
   - .env files in the project I'm working in (variable names only).
   Tell me what you found as a short list: service, where its key lives now. Leave out anything already behind heel.

3. For each one heel can hold, call heel_request_connection with a short alias and a one-line why. heel takes Gmail, Google Calendar, Outlook, GitHub, Slack, Linear, Notion, Stripe, and remote MCP servers on public https hosts. For anything else, tell me it stays as it is.

4. Propose rules with heel_propose_rules, one short why per rule. A good start for each new account: reads run, anything that sends, merges, pays or deletes asks me, and nothing else is allowed. Keep it to what you need for the work I do with you.

5. Tell me what's waiting for me and where to approve it. Then wait for me; call heel_accounts again when I say I've approved.

6. Once an account is connected, walk me through removing the raw key heel replaced: which variable, file or MCP config entry to change, and whether to revoke the old key with the service. Show me each change first; make it only if I say yes.

Finish with a short summary: what's behind heel now, what's still waiting, and what still holds its own key.
```
