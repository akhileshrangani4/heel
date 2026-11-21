/**
 * The setup prompt (roadmap 2.6). heel is agent first: on a machine without
 * heel, one prompt has an agent install it, set it up, get its owner to make
 * a passkey, connect itself, and then put the owner's services behind heel.
 * The owner does two things by hand, make the passkey and reload the agent's
 * MCP servers, and approves everything else with that passkey.
 *
 * - `installPrompt`: from nothing to an agent connected to heel. It uses
 *   heel's CLI only to install, start, link the passkey page and add itself;
 *   it never connects an account or writes a rule directly.
 * - `setupPrompt`: from there, the owner's services behind heel. Every
 *   connection and rule is a request or a proposal that waits for the owner.
 * - `fullSetupPrompt`: both, as one prompt. It's printed in docs/setup.md
 *   and served at useheel.dev/setup.md, so "follow useheel.dev/setup.md" is
 *   all an owner has to tell an agent. A test keeps the copies the same.
 *
 * `setupPrompt` alone is also served as heel's MCP prompt `setup` (in Claude
 * Code: /mcp__heel__setup), for an agent that's already connected.
 */

export const SETUP_PROMPT_NAME = "setup";

/** Pure: the prompt's text. `approvals` is heel's approval page when heel knows it. */
export function setupPrompt(approvals: string | null): string {
  const page = approvals === null ? "heel's approval page" : `heel's approval page (${approvals})`;
  return `Help me put the services I use behind heel, so you reach them through heel and never hold their keys.

Rules for the whole task:
- Never read, print, copy or send the value of a key, token, password or secret. You may look at names only: environment variable names, which config files exist, which servers an MCP config lists.
- Don't edit, move or delete any file or setting without asking me first.
- Everything you ask heel for waits for me. I approve each request on ${page} with my passkey.

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

Finish with a short summary: what's behind heel now, what's still waiting, and what still holds its own key.`;
}

/** Pure: from a machine without heel to an agent connected to it. */
export function installPrompt(): string {
  return `Set up heel for me. heel is a permission gateway: you'll reach my accounts through it, it holds their keys, and I approve anything risky with a passkey. Go step by step and tell me what you're doing.

Some steps may be done already, for example if I restarted you partway: check each one first and skip it if it's done. If heel's tools (such as heel_accounts) are already available to you, skip straight to the part after step 6.

Rules for the whole task:
- Never read, print, copy or send the value of a key, token, password or secret. The one exception is heel's own token for you in step 5: pass it straight to the command that adds heel to your app, and don't repeat it in our chat.
- Use heel's command line only for the steps below. Don't run heel connect, edit heel's rules files or approve anything yourself: connections and rules go through requests I approve.
- Don't install system software, edit shell profiles or change files outside heel without asking me first.

1. Check Node: node -v must be 26.13 or later. If it isn't, stop and tell me how to install it (from nodejs.org, or with mise or nvm). Don't install it yourself.

2. If heel --version fails, install heel: npm install -g useheel

3. Set heel up and start it: heel init --yes, then heel start. Run heel status to check it's running.

4. My passkey: run heel user enroll owner and give me the link it prints. Ask me to open it and choose Create a passkey. Wait until I say I'm done, then run heel status and check that Passkeys is 1 or more.

5. Add yourself as an agent: heel agent add <a short name for you, like claude-code> --client claude-code (or --client codex). Run the command it prints to add heel to your app. For any other app, leave out --client and tell me the MCP URL to add, with the token as a bearer token.

6. Ask me to load heel in your app (in Claude Code, run /mcp or restart), and to tell you when it's done. Then check that heel's tools are there, such as heel_accounts.

heel now runs on this machine as me, so you could still read its files. When we're done, tell me that heel is safest under its own user or on a server, and point me to https://useheel.dev/docs/running.`;
}

/** Pure: the whole thing, install and then services, as one prompt. */
export function fullSetupPrompt(approvals: string | null): string {
  return `${installPrompt()}

Once heel's tools are loaded, carry on:

${setupPrompt(approvals)}`;
}
