# Connect your agent

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

Each agent gets its own heel token. It's the only credential the agent holds: heel uses your accounts' credentials on its behalf.

```sh
heel agent add my-agent
```

```text
Added agent "my-agent".
Token (shown once; heel keeps only its hash): heel_…
Expires: 2027-02-17. Before then, get a new one with: heel agent rotate my-agent
MCP URL: http://127.0.0.1:7300/mcp
```

Give each agent and machine its own token, so you can see which one made a call and pause one without the others.

**Or from the web app.** On **Agents**, **Add an agent** asks for your passkey, then shows the token once with its MCP address and the `claude mcp add` command to copy. Each agent's **Manage** gives it a new token (passkey; the old one stops working), adds a folder its `heel run` may work in (passkey) or removes one, and revokes it. Members manage their own agents; admins anyone's.

## Add heel to your agent

**Claude Code**

Let heel add itself, for every project, with the token going straight into Claude Code's config:

```sh
heel agent add my-agent --client claude-code
```

`heel agent rotate my-agent --client claude-code` swaps in a new token the same way. Or add it yourself:

```sh
claude mcp add --scope user --transport http heel "http://127.0.0.1:7300/mcp" \
  --header "Authorization: Bearer heel_…"
```

**Codex**

```sh
export HEEL_TOKEN=heel_…
codex mcp add heel --url "http://127.0.0.1:7300/mcp" --bearer-token-env-var HEEL_TOKEN
```

**Cursor, or any client with an `mcp.json`**

```json
{
  "mcpServers": {
    "heel": {
      "url": "http://127.0.0.1:7300/mcp",
      "headers": { "Authorization": "Bearer heel_…" }
    }
  }
}
```

**heel on another machine: sign in instead of a token.** When heel's agent plane has an HTTPS address (`agent_public_url`, which `heel init --approve-from tailscale` or `cloudflare` sets), an agent signs in to heel with OAuth: you confirm it on heel's page with your passkey, and no token is copied anywhere. heel names the agent after the app; each new sign-in is a new agent, so revoke an old one you no longer use on the **Agents** page. Only approve a sign-in you just started.

```sh
claude mcp add --transport http --scope user heel https://heel-box.your-tailnet.ts.net:8443/mcp
# then /mcp in Claude Code, pick heel, Authenticate

codex mcp add heel --url https://heel-box.your-tailnet.ts.net:8443/mcp
# usually opens heel's sign-in page itself; if it doesn't: codex mcp login heel
```

**Claude, ChatGPT or Grok connectors** sign in the same way: add `<agent_public_url>/mcp` as a custom connector. See [One heel for every machine](running.md#one-heel-for-every-machine).

Then remove the agent's own access to those accounts (its GitHub MCP server, `gh` login, API keys), or it can go around heel.

## What the agent gets

One MCP server with every connected account's tools, named by alias: `github__merge_pull_request`, `gmail-work__send`. Or one account at a time at `/mcp/<alias>`.

- **`/mcp` is code mode,** on every OS: the agent gets one `run_code` tool and writes a short Python script against your accounts (`github.list_pull_requests(...)`), so its context stays small however many accounts you connect. Each function's docstring says what it returns (`list_issues` gives `{"issues": [{"number", "title", ...}]}`), so the agent doesn't have to guess a result's shape. Every call in the script is decided by your rules like any other. See [How code mode runs](sandbox.md#how-code-mode-runs).
- **`/mcp?tools=direct`** gives one tool per account action instead, for clients that work better that way. Each built-in tool lists an MCP `outputSchema` for what it returns, so a client that writes its own code against heel's tools (Claude Code's code mode, say) knows a result's shape.
- **HTTP APIs** are at `/http/<alias>/<path>`, and **CLIs** run with `heel run`. Neither is an MCP tool.
- **`heel_status`** tells the agent where an approval stands. **`heel_accounts`** lists the accounts it can use and what it asked for that still waits, by name only. **`heel_history`** tells it how you decided its own requests, as counts, and which rules [heel would suggest](rules.md#heel-suggests-rules-from-what-you-decide) for it. **`heel_propose_rules`** lets it [propose rules, hide entries and workdirs](rules.md#your-agent-can-propose-rules) for you to add. **`heel_request_connection`** lets it [ask you to connect an account](connect.md#your-agent-can-ask-for-a-connection). heel also serves a **`setup`** prompt that has the agent put the rest of your services behind heel ([Set up heel with one prompt](setup.md)).

## Give your agent the heel skill

```sh
npx skills add akhileshrangani4/heel
```

It teaches Claude Code, Codex and other agents that support skills how to set heel up and how to work through it: what to do when a call needs approval, is denied or is paused, and to ask for a connection instead of a key. It's listed on [skills.sh](https://skills.sh).

## What happens to each call

| Outcome | The agent gets | It should |
| --- | --- | --- |
| **Allowed** | The normal result. | Carry on. |
| **Needs approval** | Over MCP, nothing yet: the call waits while you approve on your phone, then returns the normal result (or the denial). If no one decides within a few minutes (under a minute in Codex): "Approval needed: reply_all on gmail-work. ... Check with heel_status, then re-send the same call once it's approved." | Tell you what's waiting, and carry on once you tap. |
| **Denied** | "heel denied send on gmail-personal (rule)." Nothing ran. | Take another route, or tell you. |
| **Paused** | "send on gmail-work is paused. Nothing ran." | Stop and wait for you. |

Over HTTP these are status codes (202 needs approval, 403 denied, 423 paused); `heel run` uses exit codes (75, 77, 69). The agent never sees why a rule matched, and it can't approve anything: only your passkey can.

**The agent can say why.** Every tool takes an optional `heel_reason`, one sentence that shows on the approval page as the agent's own words. Over HTTP it's a `Heel-Reason` header; with `heel run`, `--reason "..."`. It never changes what runs.

## Tokens expire after 90 days

- **From 14 days out,** heel warns: at startup, on the Agents page, and in every tool result the agent gets.
- **Renew** with `heel agent rotate my-agent`. It prints a new token, and the old one stops working at once. Put the new one in the agent's settings.
- **Choose the length** with `--expires 30d`, `--expires 365d` or `--expires never` on `heel agent add` or `heel agent rotate`.
- Connectors that sign in with OAuth renew on their own.

`heel agent list` shows every agent and when its token expires.
