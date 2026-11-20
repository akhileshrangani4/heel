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
MCP URL: http://127.0.0.1:7300/mcp?tools=direct
```

Give each agent and machine its own token, so you can see which one made a call and pause one without the others.

## Add heel to your agent

**Claude Code**

```sh
claude mcp add --transport http heel "http://127.0.0.1:7300/mcp?tools=direct" \
  --header "Authorization: Bearer heel_…"
```

**Codex**

```sh
export HEEL_TOKEN=heel_…
codex mcp add heel --url "http://127.0.0.1:7300/mcp?tools=direct" --bearer-token-env-var HEEL_TOKEN
```

**Cursor, or any client with an `mcp.json`**

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

**Claude, ChatGPT or Grok connectors** sign in with OAuth instead of a token. Give heel's agent plane an HTTPS address, set it as `agent_public_url` in `heel.yaml`, and add `<agent_public_url>/mcp` as a custom connector. See [Running heel](running.md#one-heel-for-every-machine).

Then remove the agent's own access to those accounts (its GitHub MCP server, `gh` login, API keys), or it can go around heel.

## What the agent gets

One MCP server with every connected account's tools, named by alias: `github__merge_pull_request`, `gmail-work__send`. Or one account at a time at `/mcp/<alias>`.

- **On Linux,** `/mcp` without `?tools=direct` is code mode: one `run_code` tool where the agent writes a short Python script against your accounts (`github.list_pull_requests(...)`).
- **HTTP APIs** are at `/http/<alias>/<path>`, and **CLIs** run with `heel run`. Neither is an MCP tool.
- **`heel_status`** tells the agent where an approval stands. **`heel_propose_rules`** lets it [propose rules and hide entries](rules.md#your-agent-can-propose-rules) for you to add. **`heel_request_connection`** lets it [ask you to connect an account](connect.md#your-agent-can-ask-for-a-connection).

## What happens to each call

| Outcome | The agent gets | It should |
| --- | --- | --- |
| **Allowed** | The normal result. | Carry on. |
| **Needs approval** | "Approval needed: reply_all on gmail-work. Check with heel_status, then re-send the same call once it's approved." | Keep working, and re-send once you approve. |
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
