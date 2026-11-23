# Why heel

Why agent permissions need to look at what a call does, not just which tool it uses, and how heel compares to other tools.

## The problem

Most agent permissions stop at the tool: allow `send_email`, ask first, or block it. What people need to say is about the arguments:

| What you want to say | Why today's tools can't |
| --- | --- |
| "Send only to coworkers already in this thread" | OAuth scopes can't express it, most clients only see tool names, and it needs a lookup of the thread first. |
| "Never email a client from my personal account" | Scopes are per service, not per account and recipient. |
| "Read my inbox, except password reset emails" | Nothing filters what comes back, and reset codes can sign the agent in elsewhere. |
| "No more than 20 deletes this run" | Rules see one call at a time; a limit needs a counter across calls. |

Gateways that read arguments still leave gaps. Approvals often run inside the agent's own session, where an unattended agent can answer them. Approval settings live in each client, and stopping one run means revoking credentials or killing the process.

## Intent-based access control

An agent is useful because it can act, and dangerous because what it reads can steer it. So the question for every call is "is this what its owner meant it to do", answered from intent you give heel, never from what the agent says about itself.

- **Rules you write down** check the call's actual arguments; the first match decides.
- **You decide** when a call falls outside them: it waits, and you approve or deny with a passkey. An approval can cover this exact call, everything that rule asks about, or a run.
- **A task stated up front** (planned): a model proposes narrow grants from your words alone, before the agent reads anything, and you confirm them once.

Rules decide every call, not a model: whoever shapes a call could shape a model judging it too. Checks you plug in beside the rules can stop a call but never let one through. heel's own model use is on the safe side only: `looks_like` can only hide a message, and hints are advice the approver reads.

heel comes from a narrower version running in production at [Charming](https://charm.ing), where apps that agents build call people's Gmail, GitHub and other accounts, and each app function's tools are approved by the account owner.

## How heel compares

| Project | How it decides | Where it differs from heel |
| --- | --- | --- |
| **IBAC** ([ibac.dev](https://ibac.dev)) | A model writes OpenFGA grants from the user's request; OpenFGA checks every call | Needs OpenFGA. heel shares the idea and adds counts, thread checks, hiding, approvals tied to the call, and pause. |
| **WorkOS Airlock** | Endpoints and arguments, plus optional model-judged rules | Closed and hosted; approvals go to Slack. |
| **Keycard** | One policy over shell, MCP and API calls | Closed. |
| **Overslash** | Vault; MCP, REST, CLI, HTTP; one argument per action | Source-available, pre-release. The closest in shape. |
| **airlock-dev/airlock** | Allow, ask or deny by tool name | No argument checks that we found. |
| **Archestra** | Argument matching | Argument rules are paid. |
| **IBM ContextForge** | Cedar and OPA plugins over MCP and REST | Approvals over CIBA. |
| **Stacklok ToolHive** | Cedar rules on arguments | A list argument only shows whether it's present. |
| **agentgateway** | CEL rules over MCP and HTTP | |
| **Docker's MCP gateway** | Arguments only under an organization policy | Approval runs inside the session. |
| **StrongDM Leash** | Cedar on files, network and MCP in a container | MCP rules can block a tool but not allow one. |
| **agent-chaperone** | A model screens each call | A model decides live calls. |
| **Warden** | Holds credentials, checks MCP arguments | Carries the identity of the person the agent acts for. |
| **Composio, Arcade** | By tool name or type, or your own webhook checks | Tied to their connections. |
| **OpenClaw's approvals** | Prompts in Telegram, Slack, Signal | Run inside the agent, which holds the credentials. |

None of the open source gateways documents counts across a run, thread checks, or a pause.

## Incidents heel would have stopped

Each is replayed against heel in [`e2e/incidents`](../e2e/incidents/incidents.test.ts) with the [example rules](rules.md) unchanged.

| Incident | What happened | What stops it in heel |
| --- | --- | --- |
| [claude-code#99453](https://github.com/anthropics/claude-code/issues/99453) | Gmail send set to "Needs approval" sent with no prompt in Projects sessions | `email.send` asks, enforced in heel (unless the built-in Gmail connector is left connected too) |
| [claude-code#96004](https://github.com/anthropics/claude-code/issues/96004) | Client emails went out from a personal Gmail instead of work | Accounts are separate, and `gmail-personal` may not send to client domains |
| [Kiro#8500](https://github.com/kirodotdev/Kiro/issues/8500) | Asked for drafts, the agent used reply-all, which sends at once | Reply-all is `email.send`; sends outside `company.com` ask |
| [OpenClaw clears an inbox](https://techcrunch.com/2026/02/23/a-meta-ai-security-researcher-said-an-openclaw-agent-ran-amok-on-her-inbox/) | It bulk-trashed mail and ignored stop messages | Removing over 20 messages a run asks, and `heel pause` stops it |

Checking calls doesn't stop every prompt injection: when each call in an attack is allowed, nothing is blocked. heel narrows where data can go and what an agent can destroy, and claims no more than that.
