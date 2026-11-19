# How heel works

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Rules reference](rules-reference.md) · [Approvals](approvals.md) · [Running](running.md)

```
            MCP ─┐                 ┌─▶ any MCP server
agent ──── HTTP ─┼──▶ heel ───────┼─▶ any HTTP API
            CLI ─┘     │           └─▶ any CLI (gh, gcloud, stripe, kubectl, ...)
                       ├─ allow
                       ├─ deny
                       └─ pending: a person approves on their phone
```

heel is one process with two HTTP planes: the agent plane (port 7300), where agents call MCP, the HTTP proxy and `heel run`, and the human plane (port 7301), where people sign in and approve. Operators use the `heel` CLI over a local admin socket. Each connected account (`gmail-work`, `gmail-personal`, `github`) gets its own alias, and each agent its own heel token. To set one up, see the [quick start](../README.md#quick-start).

## Every way an agent reaches a system

| Surface | How the agent uses it | What heel adds |
| --- | --- | --- |
| **MCP** | Point the client at heel's MCP URL. Clients that only offer built-in connectors can add heel as a custom MCP server. | heel connects to the real servers and exposes each account as its own server (`gmail-work`, `gmail-personal`), so the agent always picks the account explicitly. |
| **Code mode** (the default) | One `run_code` tool with typed definitions per account (`gmail_work.send(...)`, `github.merge(...)`), instead of listing every tool. | The script runs in a sandbox with no network and no credentials, so its only way out is heel. Every call inside is checked on its own: a loop over 500 messages hits the same counts as 500 calls, hidden messages never reach the script, and a pause stops it at its next call. When a call needs approval, the script stops and returns the pending id with what already ran. |
| **HTTP APIs** | Send requests through heel. | heel adds the credentials. Rules match method, path, query and body. heel reads JSON and form bodies; a rule that checks the body of any other type denies the call, since heel can't tell what it says. Built-in definitions cover common APIs; describe others with an OpenAPI file. |
| **CLIs** | `heel run -- gh pr merge 123` | heel parses flags of CLIs it knows (`kubectl -n prod delete pod x` is still a `delete`) and runs the binary directly, never through a shell. The command runs in a runner heel controls, so the agent can't swap the binary or read the credential. gh never holds the token at all: heel adds it to GitHub requests at its egress proxy. Other CLIs (npm included) work the same way once you name the hosts they authenticate to; one that would hold its credential runs only if you chose that. Commands that print credentials (`gh auth token`), or that could read the credential from the environment (gh's `--jq`/`-q` filter), can never be allowed. Unknown CLIs match on raw arguments and run only when a rule allows them. |

## Trust boundary

| heel assumes | Because |
| --- | --- |
| **heel holds every credential** | Each agent gets only its own heel token. That's how heel tells agents apart, pauses one, and logs what each did. |
| **The agent can't reach heel's host** | Run heel as a separate server, container or user. An agent that can read heel's files or the provider tokens can go around it. |
| **No other path to the same account** | A token you also gave a client directly, like Claude's or ChatGPT's own Gmail connector left connected, goes around heel. |
| **Down means denied** | If heel is down, every call fails until it's back. |

## For teams

| | |
| --- | --- |
| **Admins set the ceiling** | Organization rules are checked first and can only deny or ask, so no personal rule or approval loosens them. |
| **Owners approve** | Each account, repo or service names its approver, so requests go to the person who owns it, not to IT. |
| **Everything is logged** | Agent, run, arguments, the deciding rule or approval, and who approved. Export to your SIEM. |
| **Your identity provider** | Sign-in and groups come from it. Roles still decide what a person can reach; heel decides which part of that their agents can use. |

## Built-in definitions

Gmail, Outlook, Calendar, GitHub, Slack, Linear, Notion and Stripe. Tools that leave something behind after you revoke the agent (forwarding rules, new OAuth grants, scheduled automations, webhooks) are denied until you allow them by name.

Rules and hiding are in [rules.md](rules.md), and every key and action in the [rules reference](rules-reference.md); approvals, grants and pause in [approvals.md](approvals.md).
