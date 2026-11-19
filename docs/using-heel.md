# Using heel

[README](../README.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

This is what working with heel looks like day to day: what you set up once, what your agent sees, and what you see when it needs you. [Running heel](running.md) covers installing and configuring it.

## 1. Set it up once

```sh
npm install -g useheel
export HEEL_HOME=~/.heel
heel vault init
heel serve
```

In a second terminal:

1. **Register your passkey.** `heel user enroll owner` prints a one-time link; opening it registers a passkey on that device.
   - **More devices:** once you have a passkey, add a phone or another computer from the approval page with **Add another device**: confirm with your passkey and open the link it gives you on the new device. `heel user enroll` for someone who already has a passkey makes a recovery link instead. It works only after a day, and until then the approval page shows it with a button to cancel it, so an agent that can run `heel` on the host can't quietly add a passkey of its own.
   - **On `localhost`,** that's this computer: you approve here, with Touch ID, say.
   - **To approve from your phone,** give the approval page an HTTPS address first, and set it as `public_url` before you enroll, because a passkey is tied to the address. Tailscale (`tailscale serve --bg 7301`), a Cloudflare tunnel or a server with TLS all work. Only port 7301 needs to be reachable. Then open the enrollment link on your phone, add the page to your home screen, and allow notifications. [Approve from your phone](../README.md#approve-from-your-phone) has the steps.
2. **Connect the accounts your agent should use.** Each one gets an alias, and the agent only ever sees the alias.
   ```sh
   gh auth token | heel connect github --as github --credential-stdin
   heel connect gmail --as gmail-work          # then sign in from the Connections page
   heel connect mcp --as notion --url https://mcp.notion.com/mcp --oauth
   ```
   Any MCP server, any HTTP API with an OpenAPI file, and any CLI can go behind heel. `heel --help` lists the forms.
3. **Write your rules** in `$HEEL_HOME/rules/owner.yaml` ([Rules](rules.md)). If you're unsure where to start, run `heel serve --watch` for a while. Every call runs, and the Activity page shows what each rule would have done.
4. **Add the agent.** `heel agent add my-agent` prints its heel token, once, and the MCP URL. That token is the only credential the agent gets.

## 2. Connect your agent

Point the agent at heel instead of at the services. Then remove the agent's own connections to those accounts, or it can go around heel.

**Claude Code:**

```sh
claude mcp add --transport http heel "http://127.0.0.1:7300/mcp?tools=direct" \
  --header "Authorization: Bearer heel_…"
```

**Cursor, or any client with an `mcp.json`:**

```json
{
  "mcpServers": {
    "heel": {
      "url": "http://127.0.0.1:7300/mcp?tools=direct",
      "headers": { "Authorization": "Bearer heel_…" }
    }
  }
}
```

The agent now has one MCP server with every connected account's tools, named by alias (`gmail-work__send`, `github__merge`). Or give it one account at a time at `/mcp/<alias>`.

- **On Linux,** `/mcp` without `?tools=direct` is code mode: one `run_code` tool, where the agent writes a short Python script against typed modules (`gmail_work.search(...)`).
- **Claude, ChatGPT or Grok connectors** sign in with OAuth. Set `agent_public_url` ([Running](running.md#configuration)) and add heel as a custom connector.
- **CLIs:** the agent runs them as `heel run -- gh pr merge 123`, with `HEEL_TOKEN` and `HEEL_URL` set.
- **HTTP APIs:** the agent calls `/http/<alias>/<path>` with its heel token.

## 3. What your agent sees

Every call gets one of these answers, right away:

| Outcome | What the agent gets | What it should do |
| --- | --- | --- |
| **Allowed** | The normal result. Hidden messages are dropped, with "heel hid 2 items from this result." | Carry on. |
| **Denied** | An error: "heel denied send on gmail-personal (rule)." Nothing ran. | Take a different route, or tell you. |
| **Needs approval** | "Approval needed: reply_all on gmail-work. Check with heel_status, then re-send the same call once it's approved." Nothing ran yet. | Keep working, check `heel_status`, and re-send once you've approved. |
| **Paused** | "send on gmail-work is paused. Nothing ran." | Stop and wait for you. |

- **Over HTTP,** these are status codes: 403 denied, 202 needs approval, 423 paused.
- **For `heel run`,** they're exit codes: 77 denied, 75 needs approval, 69 paused.
- **In code mode,** a denial is an exception the script can catch, while "needs approval" and "paused" stop the script and return what already ran.

The agent never sees why a rule matched, and it can't answer an approval. Approving only happens with your passkey on heel's page.

## 4. When it needs you

1. **You get a notification** on your phone (web push), or by email or Slack, if heel has an HTTPS address ([setting one up](../README.md#approve-from-your-phone)). It says which agent wants to do what, and links to heel. Replying to it approves nothing. Without notifications, waiting requests are listed on the approval page.
2. **You open the request.** The page shows the account, the tool, the rule that asked, the counts, and the **full arguments**: every recipient and the whole body, exactly what will run. If you've turned on the optional [hints](approvals.md#hints), they appear under the call ("asks someone for money", "looks routine for this agent"). Without them, everything else here works the same.
3. **You decide, with your passkey:**
   - **Approve once:** this exact call runs the next time the agent sends it, once.
   - **Approve as standing:** also allow this exact call, or everything this rule asks about, for a while (an hour up to 90 days), so you aren't asked again. Standing approvals are listed on the Standing approvals page, where you can revoke them.
   - **Deny:** the agent gets "denied" when it re-sends.
4. **The agent re-sends and the call runs**, checked against your rules again. A request nobody answers expires after 24 hours.

## 5. When something looks wrong

Tap **Pause** on the approval page, or run `heel pause --agent my-agent`. You can pause one agent, one account, or everything. Every call in scope stops at once, even one you already approved. Resuming needs your passkey, and nothing called during the pause is replayed.

## 6. Over time

- **Activity** shows every call, with its decision and the rule that made it, as they happen. It also suggests rules from what got asked or denied often.
- **Grants** and **standing approvals** list what you've allowed beyond your rules, and let you revoke any of it.
- **Modes** let a new rule, or a new agent, run in watch mode first: heel logs what the rule would have done, then you switch it to enforce.
- **Rules:** edit the file and heel reloads it. Run `heel rules check` and `heel rules test` before you rely on a change. Editing a rule ends the grants made from it, so widening a rule asks again.
