<p align="center">
  <img src="assets/logo/heel-icon.svg" alt="heel logo: a dog sitting at heel" width="128">
</p>

<h1 align="center">heel</h1>

<p align="center">
  <strong>Your agent has the tools. heel decides what it does with them.</strong><br>
  Intent-based access control for AI agents. Open source and self-hosted.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-16181D"></a>
  <a href="https://github.com/akhileshrangani4/heel/pull/1"><img alt="Status: building v0.1" src="https://img.shields.io/badge/status-building%20v0.1-F2A33A"></a>
</p>

<p align="center">
  <a href="#how-it-works">How it works</a>
  &nbsp;•&nbsp;
  <a href="#rules">Rules</a>
  &nbsp;•&nbsp;
  <a href="#approvals">Approvals</a>
  &nbsp;•&nbsp;
  <a href="#how-it-compares">How it compares</a>
</p>

heel is intent-based access control (IBAC): you say what an agent is for, and heel holds it to that on every call. It sits between an agent and everything it touches (MCP servers, HTTP APIs, and CLIs) and checks every call against rules on the actual arguments: who an email goes to, which account it comes from, which repo, how many messages this run has deleted. It also hides what an agent shouldn't read, like mail from your partner or password reset codes. Approvals go to a signed-in person outside the agent's session, so the agent can't answer them itself, and one switch pauses any agent or all of them.

[![heel in 38 seconds](assets/heel.gif)](assets/heel.mp4)

## The problem

Agent permissions mostly stop at the tool: allow `send_email`, ask first, or block it. What people actually need to say is about the arguments:

| What you want to say | Why today's tools can't |
| --- | --- |
| "Send only to coworkers already in this thread" | OAuth scopes can't express it, and most clients only see tool names. It also needs a lookup of the thread first. |
| "Never email a client from my personal account" | Scopes are per service, not per account and recipient. |
| "Read my inbox, except password reset emails" | Nothing filters what comes back. An agent that reads your reset codes can sign in to your other accounts. |
| "No more than 20 deletes this run" | Rules see one call at a time. A limit needs a counter across calls. |

Gateways that do read arguments still leave gaps:

| Gap | Example |
| --- | --- |
| Approvals run inside the agent's session | Docker's MCP gateway docs say its approval prompt (in Docker Sandboxes) runs in the session, leaves out the arguments, and can be answered in code. An unattended agent can approve itself. |
| Approval settings live in each client | In [claude-code#99453](https://github.com/anthropics/claude-code/issues/99453), Gmail send was set to "Needs approval", but Projects thread sessions sent with no prompt. |
| Stopping a run means revoking credentials or killing the process | There's no switch that stops one agent and leaves the rest running. |

## Intent-based access control

An agent is useful because it can act, and dangerous for the same reason: what it reads can steer it. So the question for every call isn't "may this agent use Gmail" but "is this call what its owner meant it to do". heel answers that from intent you give it, never from what the agent says about itself.

| How intent reaches heel | What it looks like | Status |
| --- | --- | --- |
| **Rules you write down** | "Send only to coworkers already in the thread." "Ask before deleting more than 20 messages." Rules check the call's actual arguments, and the first match decides. | In v0.1 |
| **A person, when a call falls outside them** | The call waits for its owner, who approves or denies it with a passkey. An approval can become a grant: this exact call, everything that rule asks about, or this run. | In v0.1 (grants for a run: planned) |
| **A task stated up front** | Describe what a run is for. A model proposes narrow grants from your words alone, before the agent reads anything. You confirm them once, and the rules enforce them. | Planned |

**A model never decides a live call.** Whoever shapes a call (say, an injected instruction in an email) could shape a model judging it too, so every decision comes from rules, grants and people. Checks you plug in beside the rules (your own security service, an OpenFGA store, a classifier) can stop a call but never let one through.

## How it works

```
            MCP ─┐                 ┌─▶ any MCP server
agent ──── HTTP ─┼──▶ heel ───────┼─▶ any HTTP API
            CLI ─┘     │           └─▶ any CLI (gh, gcloud, stripe, kubectl, ...)
                       ├─ allow
                       ├─ deny
                       └─ pending: a person approves on their phone
```

```sh
heel connect gmail --as gmail-work        # OAuth; the token stays in heel
heel connect gmail --as gmail-personal
heel connect github --as github
heel agent add inbox-bot                  # prints the agent's heel token and MCP URL
heel serve
```

### Every way an agent reaches a system

| Surface | How the agent uses it | What heel adds |
| --- | --- | --- |
| **MCP** | Point the client at heel's MCP URL. Clients that only offer built-in connectors can add heel as a custom MCP server. | heel connects to the real servers and exposes each account as its own server (`gmail-work`, `gmail-personal`), so the agent always picks the account explicitly. |
| **Code mode** (the default) | One `run_code` tool with typed definitions per account (`gmail_work.send(...)`, `github.merge(...)`), instead of listing every tool. | The script runs in a sandbox with no network and no credentials, so its only way out is heel. Every call inside is checked on its own: a loop over 500 messages hits the same counts as 500 calls, hidden messages never reach the script, and a pause stops it at its next call. When a call needs approval, the script stops and returns the pending id with what already ran. |
| **HTTP APIs** | Send requests through heel. | heel adds the credentials. Rules match method, path, query and body. Built-in definitions cover common APIs; describe others with an OpenAPI file. |
| **CLIs** | `heel run -- gh pr merge 123` | heel parses flags of CLIs it knows (`kubectl -n prod delete pod x` is still a `delete`) and runs the binary directly, never through a shell. The command runs in a runner heel controls, so the agent can't swap the binary or read the credential. Commands that print credentials (`gh auth token`) can never be allowed. Unknown CLIs match on raw arguments and run only when a rule allows them. |

### Rules

Rules are a file you can read, review and test. A call no rule matches is denied. They're checked in this order, and the first match decides:

1. **Organization rules.** These can only deny or ask, so nothing below can loosen them.
2. **Grants.** Each sits just above the rule that asked for it, so it can turn that `ask` into `allow` but can't get past an earlier `deny`.
3. **Your rules,** top to bottom.

```yaml
rules:
  # reads: anything a built-in definition marks as read-only
  - match: { kind: read }
    then: allow

  # the personal account never emails clients
  - match:
      action: email.send
      account: gmail-personal
      recipients:
        any_domain_in: [clientco.com, partner.io]
    then: deny

  # coworkers already in the thread: no need to ask
  - match:
      action: email.send
      account: gmail-work
      recipients:
        all_in_thread: true
        all_domain_in: [company.com]
        max: 5
    then: allow

  # every other send, including reply-all to a customer
  - match: { action: email.send }
    then: ask

  # trash, delete, and archive count messages, not calls
  - match: { action: email.remove, items: { over: 20, per: run } }
    then: ask
  - match: { action: email.remove, items: { over: 100, per: hour } }
    then: ask
  - match: { action: email.remove }
    then: allow

  - match: { action: github.merge, repo: { one_of: [acme/web, acme/api] }, checks: passing }
    then: allow

  - match: { command: kubectl, verb: { one_of: [get, describe, logs] } }
    then: allow
  - match: { command: kubectl, verb: delete }
    then: ask
```

| Part of a rule | What it does |
| --- | --- |
| **Actions** | Built-in definitions map tools from different servers to one action. `email.send` covers send, reply, reply-all and forward on Gmail and Outlook, with `recipients` meaning to, cc and bcc together. For a server heel doesn't know, rules use its own tool and argument names. |
| **Plain checks** | Work on anything: `equals`, `one_of`, `matches`, `any_domain_in`, `all_domain_in`, `max`. |
| **State checks** | Look something up first, with heel's own read access, and only exist for services heel knows. `all_in_thread`: every recipient was on a message you sent in that thread. `checks: passing`: reads the pull request's status and passes the checked commit to GitHub's merge, so the merge fails if new commits landed. |
| **Counts** | Count `items` (messages, files, records), not calls, so one `batch_delete` of 1,000 messages counts as 1,000, including the call being checked. `per: run` uses the run id the agent sends, so pair it with a `per: hour` limit, which the agent can't reset. |

- **Try before enforcing.** `heel serve --watch` lets calls through and logs what each rule would have done. One new rule can run that way on its own with `watch: true`.
- **Describe a rule in words.** A model drafts the YAML for you to read and save. It never sees a live call.

### Hiding what the agent reads

Rules decide whether a call runs. `hide` decides what comes back from it, on every allowed call and every account, so a read rule can stay a plain `allow`.

```yaml
hide:
  # mail from family never reaches the agent
  - email: { from: { any_of: [sarah@example.com] } }
  # neither do password resets or login codes
  - email: { looks_like: [password_reset, login_code] }
```

| Behavior | Detail |
| --- | --- |
| Hidden messages drop out | Searches, lists and threads come back without them, with a placeholder saying how many were hidden. Fetching, forwarding, replying to or deleting a hidden message is denied. |
| `from`, `to`, `subject`, `labels` | Plain checks, like in rules. |
| `looks_like` | The one place a model decides on a live call, and it can only hide. Patterns catch common reset links and codes, and a classifier inside heel catches the rest. When it's unsure or can't run, the message is hidden. |
| Where it works | Only where heel knows the response shape: built-in definitions and OpenAPI-described APIs. For an unknown MCP server or CLI, heel can allow or deny the call but can't remove items. |
| Known gap | A hidden message quoted inside a reply is only hidden if the reply matches too. |

### Approvals and pause

When a rule says `ask`:

1. **The agent gets an answer right away:** "pending approval" with an id (an MCP result, HTTP `202`, or a CLI exit code). Retrying the same call joins the same request.
2. **The approver is notified** on their phone, Slack or email. The message only links to heel; replying approves nothing, so an agent with access to the same inbox can't approve.
3. **They decide on heel's page** with a passkey, after seeing the tool, the account, the rule and the full arguments.
4. **The call runs once,** when the agent re-sends it, after the rules are checked again. A late approval never runs a call the agent gave up on. Unapproved requests expire.

An approval can become a **grant**, placed just above the rule that asked:

| Grant | Covers | Lasts |
| --- | --- | --- |
| This exact call | The same account, tool and arguments | Up to 90 days |
| Everything this rule asks about | The rule's whole match, for this agent | Up to 90 days |

Editing the rule ends its grants, so widening a rule asks again.

**Pause** stops one agent, one account or service, or everything, from `heel pause` or one tap on the approval page. Every call in scope returns "paused", even one already approved. Resuming needs a passkey, and nothing called during the pause is replayed.

### Trust boundary

| heel assumes | Because |
| --- | --- |
| **heel holds every credential** | Each agent gets only its own heel token. That's how heel tells agents apart, pauses one, and logs what each did. |
| **The agent can't reach heel's host** | Run heel as a separate server, container or user. An agent that can read heel's files or the provider tokens can go around it. |
| **No other path to the same account** | A token you also gave a client directly, like Claude's or ChatGPT's own Gmail connector left connected, goes around heel. |
| **Down means denied** | If heel is down, every call fails until it's back. |

### For teams

| | |
| --- | --- |
| **Admins set the ceiling** | Organization rules are checked first and can only deny or ask, so no personal rule or approval loosens them. |
| **Owners approve** | Each account, repo or service names its approver, so requests go to the person who owns it, not to IT. |
| **Everything is logged** | Agent, run, arguments, the deciding rule or approval, and who approved. Export to your SIEM. |
| **Your identity provider** | Sign-in and groups come from it. Roles still decide what a person can reach; heel decides which part of that their agents can use. |

### Built-in definitions

Gmail, Outlook, Calendar, GitHub, Slack, Linear, Notion and Stripe. Tools that leave something behind after you revoke the agent (forwarding rules, new OAuth grants, scheduled automations, webhooks) are denied until you allow them by name.

## Status

heel v0.1 is being built on [`release/heel-v0.1`](https://github.com/akhileshrangani4/heel/pull/1), and `main` stays README-only until the incident replays below pass. Done so far: the rules engine, the decision pipeline, approvals, grants, pause, passkeys and the approval page, the adapter chain, and the CLI sandbox. Next: notifications, the MCP endpoint, and Gmail.

## Incidents heel would have stopped

We'll replay each of these against heel and publish exactly what was blocked and what got through.

| Incident | What happened | Rule that blocks it | What it wouldn't catch |
| --- | --- | --- | --- |
| [claude-code#99453](https://github.com/anthropics/claude-code/issues/99453) (Oct 2026, open, one user's report) | Gmail send set to "Needs approval" sent with no prompt in Claude's Projects thread sessions | `email.send` → `ask`, enforced in heel with Gmail added to Claude as a custom MCP server pointing at heel | The built-in Gmail connector, if it's left connected too |
| [claude-code#96004](https://github.com/anthropics/claude-code/issues/96004) (Sep 2026, open) | Three client emails and a vendor ticket went out from the user's personal Gmail instead of their work account. The tool had no `from` field, and the user's guard hook only covered Bash | The two accounts are separate servers, and `gmail-personal` is denied any send to client domains. Sends to other outside domains fall through to `ask` | A send the approver approves by mistake |
| [Kiro#8500](https://github.com/kirodotdev/Kiro/issues/8500) (May 2026, closed as not planned) | Asked for drafts, the agent called the Outlook reply-all tool, which sends at once, and emailed a customer | Reply-all is `email.send`, and sends to anyone outside `company.com` fall through to `ask` | A send the approver approves by mistake |
| [OpenClaw clears an inbox](https://techcrunch.com/2026/02/23/a-meta-ai-security-researcher-said-an-openclaw-agent-ran-amok-on-her-inbox/) (Feb 2026, self-reported) | Told to suggest deletions and wait, it bulk-trashed or archived mail and ignored stop messages from a phone | `email.remove` over 20 messages a run asks first, and `heel pause` from the phone stops it | Removals under the limit |

Checking calls doesn't stop every prompt injection. When each call in an attack is allowed, nothing gets blocked. heel narrows where data can go and what an agent can destroy, and it doesn't claim more than that.

## How it compares

| Project | What it is | How it decides | Where it differs from heel |
| --- | --- | --- | --- |
| **IBAC** ([ibac.dev](https://ibac.dev)) | A paper by Jordan Potti that named the idea | A model reads only the user's request and writes OpenFGA grants up front; OpenFGA checks every call | Needs OpenFGA. heel shares the principle and adds counts, thread checks, hiding, approvals tied to the exact call, and pause. |
| **WorkOS Airlock** | Closed, early access | Endpoints and arguments, plus optional model-judged runtime rules | Approvals go to Slack. Closed and hosted. |
| **Keycard** | Closed | One policy across shell commands, MCP tools and API calls | Closed. |
| **Overslash** | Source-available (Elastic License), pre-release | Vault; MCP, REST, CLI and HTTP; each action scoped by one argument | Approvals by dashboard, email or webhook, with "allow & remember". The closest in shape. |
| **airlock-dev/airlock** | MIT | MCP, CLI, REST and HTTP; allow, ask or deny by tool name | No argument checks that we found. Approvals over Telegram, Slack and iOS push. |
| **Archestra** | Open source MCP gateway | Argument matching, such as every `to` address in a domain | Argument rules are in a paid tier. |
| **IBM ContextForge** | Open source MCP gateway | Plugins with Cedar and OPA over MCP and REST | Its CPEX layer ties approvals to arguments over CIBA. |
| **Stacklok ToolHive** | Open source MCP gateway | Cedar rules on arguments | A list argument only shows whether it's present. |
| **agentgateway** | Open source gateway | CEL rules over MCP and HTTP | |
| **Docker's MCP gateway** | Open source | Arguments only under a Docker Sandboxes organization policy | Approval runs inside the session. |
| **StrongDM Leash** | Apache 2.0 | Cedar on a coding agent's files, network and MCP calls, in a container | MCP rules can block a tool but not allow one; process rules see the binary, not its arguments. |
| **agent-chaperone** | Open source MCP proxy | A model screens each call and result against thresholds | A model decides live calls. |
| **Warden** (stephnangue/warden) | Open source | Holds credentials, checks MCP calls down to their arguments | Can carry the identity of the person the agent acts for. |
| **Composio, Arcade** | Connector platforms | Composio: allow, ask or block a tool by name or type, plus a classifier Firewall. Arcade: webhooks before execution, where you write the checks. | Tied to their connections. |
| **OpenClaw's approvals** | Built into the agent | Telegram, Slack and Signal prompts | They run inside the agent, which holds the credentials. |

None of the open source gateways documents counts across a run, thread checks, or a pause.

**What heel puts together:** intent enforced on every call with no model deciding it, rules on arguments with state checks and item counts, hiding what the agent shouldn't read, approvals tied to the exact call that the agent can't answer, pause and resume, one rule file for MCP, HTTP and CLI, and an open source license.

## Where this comes from

We run a narrower version of this in production at [Charming](https://charm.ing), where apps that agents build call people's Gmail, GitHub, and other connected accounts. Each app function declares the tools it uses, the account owner approves each function, and the approval lapses when the function's tools, output, or allowed callers change. A classifier screens every tool across 124 services and keeps out the ones that leave access behind after a revoke. heel takes that model out of one product and puts it in front of any agent.

## License

Apache 2.0. See [LICENSE](LICENSE).
