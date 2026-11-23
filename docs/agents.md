# Connect your agent

Give an agent its own heel token or sign-in, so every call it makes goes through your rules.

The token is the only credential the agent holds. heel uses your accounts' credentials on its behalf.

```sh
heel agent add my-agent
```

```text
Added agent "my-agent".
Token (shown once; heel keeps only its hash): heel_…
Expires: 2027-02-17. Before then, get a new one with: heel agent rotate my-agent
MCP URL: http://127.0.0.1:7300/mcp
```

Give each agent and machine its own token, so you can see which one made a call and pause one without the others. In the web app, **Agents > + Add agent** does the same with your passkey and shows the token once, and each agent's **⋯** menu gives it a new token, manages its `heel run` folders, or revokes it.

## Add heel to your agent

**Claude Code.** Let heel add itself for every project, with the token going straight into Claude Code's config:

```sh
heel agent add my-agent --client claude-code
```

`heel agent rotate my-agent --client claude-code` swaps in a new token the same way.

**Codex:**

```sh
export HEEL_TOKEN=heel_…
codex mcp add heel --url "http://127.0.0.1:7300/mcp" --bearer-token-env-var HEEL_TOKEN
```

**Cursor, or any client with an `mcp.json`:**

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

**heel on another machine: sign in instead of a token.** When heel's agent plane has an HTTPS address (`agent_public_url`, which `heel init --approve-from tailscale` or `cloudflare` sets), the agent signs in with OAuth and you confirm it with your passkey. No token is copied anywhere. Each sign-in is a new agent, named after the app, so revoke old ones on **Agents**. Only approve a sign-in you just started.

```sh
claude mcp add --transport http --scope user heel https://heel-box.your-tailnet.ts.net:8443/mcp
# then /mcp in Claude Code, pick heel, Authenticate
```

**Claude, ChatGPT or Grok connectors** sign in the same way: add `<agent_public_url>/mcp` as a custom connector. See [Running heel](running.md).

Then remove the agent's own access to those accounts (its GitHub MCP server, `gh` login, API keys), or it can go around heel.

## What the agent gets

One MCP server with every connected account's tools, named by alias (`github__merge_pull_request`, `gmail-work__send`), or one account at a time at `/mcp/<alias>`.

- **`/mcp` is code mode,** on every OS. The agent gets one `run_code` tool and writes a short Python script against your accounts, so its context stays small however many accounts you connect. Every call in the script is decided by your rules. See [Security](security.md).
- **`/mcp?tools=direct`** gives one tool per action instead, for clients that work better that way.
- **HTTP APIs** are at `/http/<alias>/<path>`, and **CLIs** run with `heel run` ([Connect accounts](connect.md)).

heel's own tools:

| Tool | What it's for |
| --- | --- |
| `heel_status` | Where an approval stands. |
| `heel_accounts` | The accounts the agent can use, and what it asked for that still waits. |
| `heel_history` | How you decided its requests, as counts, and rules heel would suggest. |
| `heel_propose_rules` | Propose rules, hide entries and workdirs for you to add. |
| `heel_request_connection` | Ask you to connect an account. |

heel also serves a `setup` prompt that has the agent put the rest of your services behind heel ([Quickstart](quickstart.md)).

## Give your agent the heel skill

```sh
npx skills add akhileshrangani4/heel
```

It teaches Claude Code, Codex and other agents that support skills how to work through heel: what to do when a call waits, is denied or is paused, and to ask for a connection instead of a key.

## What happens to each call

| Outcome | The agent gets | It should |
| --- | --- | --- |
| **Allowed** | The normal result. | Carry on. |
| **Needs approval** | Over MCP, the call waits while you approve on your phone, then returns the result (or the denial). If no one decides in time (four minutes in Claude Code, 50 seconds elsewhere), it gets "Approval needed … re-send the same call once it's approved." | Tell you what's waiting, and carry on once you tap. |
| **Denied** | "heel denied send on gmail-personal (rule)." Nothing ran. | Take another route, or tell you. |
| **Paused** | "send on gmail-work is paused. Nothing ran." | Stop and wait for you. |

Over HTTP these are status codes (202, 403, 423); `heel run` uses exit codes (75, 77, 69). The agent never sees why a rule matched, and it can't approve anything.

**The agent can say why.** Every tool takes an optional `heel_reason`, one sentence shown on the approval page as the agent's own words (`Heel-Reason` header over HTTP, `--reason` with `heel run`). It never changes what runs.

## Tokens expire after 90 days

- From 14 days out, heel warns at startup, on **Agents**, and in every tool result.
- `heel agent rotate my-agent` prints a new token; the old one stops working at once.
- Choose the length with `--expires 30d`, `365d` or `never`. Agents that sign in with OAuth renew on their own.
