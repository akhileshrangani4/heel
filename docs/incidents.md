# Incidents heel would have stopped

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

Each of these is replayed against heel in [`e2e/incidents`](../e2e/incidents/incidents.test.ts), with the [example rules](rules.md) unchanged: the harmful call is stopped before it reaches the mailbox, and the useful part of the same story still runs.

| Incident | What happened | Rule that blocks it | What it wouldn't catch |
| --- | --- | --- | --- |
| [claude-code#99453](https://github.com/anthropics/claude-code/issues/99453) (Oct 2026, open, one user's report) | Gmail send set to "Needs approval" sent with no prompt in Claude's Projects thread sessions | `email.send` → `ask`, enforced in heel with Gmail added to Claude as a custom MCP server pointing at heel | The built-in Gmail connector, if it's left connected too |
| [claude-code#96004](https://github.com/anthropics/claude-code/issues/96004) (Sep 2026, open) | Three client emails and a vendor ticket went out from the user's personal Gmail instead of their work account. The tool had no `from` field, and the user's guard hook only covered Bash | The two accounts are separate servers, and `gmail-personal` is denied any send to client domains. Sends to other outside domains fall through to `ask` | A send the approver approves by mistake |
| [Kiro#8500](https://github.com/kirodotdev/Kiro/issues/8500) (May 2026, closed as not planned) | Asked for drafts, the agent called the Outlook reply-all tool, which sends at once, and emailed a customer | Reply-all is `email.send`, and sends to anyone outside `company.com` fall through to `ask` | A send the approver approves by mistake |
| [OpenClaw clears an inbox](https://techcrunch.com/2026/02/23/a-meta-ai-security-researcher-said-an-openclaw-agent-ran-amok-on-her-inbox/) (Feb 2026, self-reported) | Told to suggest deletions and wait, it bulk-trashed or archived mail and ignored stop messages from a phone | `email.remove` over 20 messages a run asks first, and `heel pause` from the phone stops it | Removals under the limit |

Checking calls doesn't stop every prompt injection. When each call in an attack is allowed, nothing gets blocked. heel narrows where data can go and what an agent can destroy, and it doesn't claim more than that.
