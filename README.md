# heel

**Your agent has the tools. heel decides what it does with them.**

Open source, self-hosted access control for AI agents. heel sits between an agent and everything it touches (MCP servers, HTTP APIs, and CLIs) and checks every call against rules on the actual arguments: who an email goes to, which account it comes from, which repo, how many messages this run has deleted. It also hides what an agent shouldn't read, like mail from your partner or password reset codes. Approvals go to a signed-in person outside the agent's session, so the agent can't answer them itself, and one switch pauses any agent or all of them.

[![heel in 38 seconds](assets/heel.gif)](assets/heel.mp4)

## The problem

Agent permissions today mostly stop at the tool. You can allow `send_email`, ask before it, or block it. You can't say "send only to coworkers already in this thread" or "never email a client from my personal account" or "read my inbox, except password reset emails", because OAuth scopes can't express it and most clients only see tool names. The last one matters more than it sounds: an agent that can read your reset codes can sign in to your other accounts.

The gateways that do read arguments still leave gaps:

- **Rules mostly see one call at a time.** "No more than 20 deletes this run" needs a counter, and "only people in this thread" needs to look the thread up first.
- **Many approvals run inside the session.** Docker's MCP gateway docs say its approval prompt (in Docker Sandboxes) runs in the session, leaves out the tool's arguments, and can be answered in code by an autonomous client. An unattended agent can approve itself.
- **Approval settings live in each client.** In [claude-code#99453](https://github.com/anthropics/claude-code/issues/99453), Gmail send was set to "Needs approval", but in Projects thread sessions it sent with no prompt.
- **Stopping a run usually means revoking credentials or killing the process.**

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

### Trust boundary

- **heel holds every credential.** Each agent gets its own heel token and nothing else. That token is how heel tells agents apart, pauses one of them, and logs what each did.
- **heel has to run where the agent can't reach it,** for example a separate server, container, or user. An agent that can read heel's files or the provider tokens can go around it.
- **A token you also gave a client directly goes around heel.** That includes a built-in connector left connected next to heel, such as Claude's or ChatGPT's own Gmail connector.

### Every way an agent reaches a system

- **MCP.** Point the client at heel's MCP URL. heel connects to the real servers, local or remote, and exposes each connected account as its own server (`gmail-work`, `gmail-personal`), so the agent always picks the account explicitly. Clients that only offer built-in connectors can still add heel as a custom MCP server.
- **Code mode.** With many servers connected, listing every tool fills the agent's context. So by default heel's MCP server offers one `run_code` tool instead, with typed definitions for each connected account (`gmail_work.send(...)`, `github.merge(...)`). The agent writes a short script, and the script runs in a sandbox heel controls, with no network and no credentials, so its only way out is heel. Every call inside the script goes through the rules one at a time: a loop over 500 messages hits the same item counts as 500 separate calls, hidden messages never reach the script, and a paused agent's script stops on its next call. When a call needs approval, the script stops there and returns the pending id along with what already ran, and the agent writes the rest as a new script once the call is approved. Clients that work better with plain tools can get every tool listed directly instead.
- **HTTP APIs.** Send requests through heel, and it adds the credentials. Rules match on method, path, query, and body. Built-in definitions cover common APIs, and you can describe others with an OpenAPI file.
- **CLIs.** `heel run -- gh pr merge 123` checks the command before it runs. heel parses the flags of CLIs it knows, so `kubectl -n prod delete pod x` is still a `delete`, and it runs the binary directly, never through a shell, so `sh -c` and pipes can't hide a command. The command runs in a runner heel controls, not on the agent's machine, with the agent's working directory mounted in. That way the agent can't swap the binary or read the credential heel puts in the command's environment. Commands that print credentials, such as `gh auth token`, can never be allowed. For a CLI heel doesn't know, rules match the raw arguments, and nothing runs until a rule allows it.

### Rules

Rules are a file you can read, review, and test. They're checked in this order, and the first match decides:

1. **Organization rules.** These can only deny or ask, never allow, so nothing below them can loosen them.
2. **Standing approvals.** Each one sits just above the rule that asked for it, so it can turn that `ask` into `allow` but can't get past an earlier `deny`.
3. **Your rules,** from top to bottom.

A call no rule matches is denied.

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

- **Actions.** Built-in definitions map tools from different servers to one action. `email.send` covers send, reply, reply-all, and forward on Gmail and Outlook servers, with `recipients` meaning to, cc, and bcc together. For a server heel doesn't know, rules use its own tool and argument names.
- **Plain checks** work on anything: `equals`, `one_of`, `matches`, `any_domain_in`, `all_domain_in`, `max`, and counts.
- **State checks** look something up first, using heel's own read access to that service.
  - `all_in_thread` means every recipient was on a message you sent in that thread, so someone who only emailed you doesn't count, and a new message isn't in a thread.
  - `checks: passing` reads the pull request's status and passes the commit it checked to GitHub's merge call, so the merge fails if new commits landed in between.
  - State checks only exist for services heel knows.
- **Counts** use `items` (messages, files, records) rather than calls, so one `batch_delete` of 1,000 messages counts as 1,000. A count includes the call being checked. The `per: run` period means the run id the agent sends with its calls. Because the agent picks that id, pair a run limit with a `per: hour` limit, which counts per agent and can't be reset. An agent that sends no run id is counted per hour only.
- **You can describe a rule in words.** A model drafts the YAML for you to read and save. Apart from `looks_like` (below), a model never sees a live call; every decision comes from the file and the data it names.

### Hiding what the agent reads

Rules decide whether a call runs. `hide` decides what comes back from it. It applies to every allowed call on every account, so a read rule can stay a plain `allow`.

```yaml
hide:
  # mail from family never reaches the agent
  - email: { from: { any_of: [sarah@example.com] } }
  # neither do password resets or login codes
  - email: { looks_like: [password_reset, login_code] }
```

- **Hidden messages drop out of the results.** Searches, lists, and threads come back without them, with a placeholder that says how many were hidden, so the agent knows the list is incomplete without learning the sender or subject. Fetching a hidden message by id, or forwarding, replying to, or deleting it, is denied.
- **`from`, `to`, `subject`, and `labels` are plain checks.** They work like the checks in rules.
- **`looks_like` is the one place a model decides on a live call.** Patterns catch common reset links and codes, and a classifier running inside heel catches the rest. It sees each message before the agent does. When it's unsure, or can't run, the message is hidden. It can still miss one, which is why `looks_like` only ever hides and never allows.
- **Hiding only works where heel knows the response shape.** That covers built-in definitions and APIs described with an OpenAPI file. For an MCP server or CLI heel doesn't know, it can allow or deny the call but can't remove items from what comes back.
- **A hidden message can still show up quoted.** If someone replies and quotes the hidden one, that reply only gets hidden if it matches too.

### Approvals

When a rule says `ask`, heel doesn't hold the agent's request open:

- **The agent gets an answer right away.** The call returns "pending approval" with an id: an MCP tool result, HTTP `202`, or a CLI exit code. The agent can keep working, or check back with the id.
- **Repeats join the same request.** The approval is tied to the exact call, so an agent that retries the same call joins the same pending request instead of creating a duplicate.
- **The approver signs in to see it.** heel pushes a notification to their phone, Slack, or email. The notification only links to heel's approval page, where the approver signs in with a passkey and sees the tool, the account, and the full arguments. Replying to the message approves nothing, so an agent with access to the same Slack or inbox can't approve.
- **An approved call runs once.** It runs when the agent asks for it, so a late approval never runs a call the agent has given up on. Unapproved requests expire.
- **An approval can stand.** Instead of covering this call only, it can add a rule ("allow this for 30 days") just above the rule that asked. Widening that rule asks again.

### Pause

`heel pause` stops one agent, one service, or everything, from the CLI or the approval page on your phone. While paused, every call gets a "paused" error, and pending approvals can't be approved. After `heel resume`, the agent's next call goes through the rules as usual.

### For teams

- **Admins set the ceiling.** Organization rules are checked first and can only deny or ask, so no personal rule or approval can loosen them.
- **Owners approve.** Each connected account, repo, or service names its approver, so the request goes to the person who owns it, not to IT for every call.
- **Every decision is logged.** The log records the agent, the run, the arguments, the rule or approval that decided the call, and who approved it. It can be exported to your SIEM.
- **Sign-in and groups come from your identity provider.** Roles still decide what a person can reach; heel decides which part of that their agents can use.

### Built-in definitions

These cover Gmail, Outlook, Calendar, GitHub, Slack, Linear, Notion, and Stripe. In these definitions, tools that leave something behind after you revoke the agent are denied until you allow them by name. That includes forwarding rules, new OAuth grants, scheduled automations, and webhooks.

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

- **WorkOS Airlock** (closed, early access) checks endpoints and arguments, can add model-judged runtime rules, and sends approvals to Slack. **Keycard** (closed) applies one policy across shell commands, MCP tools, and API calls.
- **Overslash** (source-available, Elastic License, pre-release) is the closest in shape. It has a vault, covers MCP, REST, CLI, and HTTP, scopes each action by one argument, and sends approvals through a dashboard, email, or webhook, with "allow & remember" for a set time.
- **airlock-dev/airlock** (MIT) covers MCP, CLI, REST, and HTTP, with approvals over Telegram, Slack, and iOS push. Its rules allow, ask, or deny by tool name, with no checks on arguments that we found.
- **Open source MCP gateways:**
  - **Archestra** matches arguments, such as every `to` address in a domain, though its pricing page puts these rules in a paid tier.
  - **IBM ContextForge** has a plugin system with Cedar and OPA, covers MCP and REST, and its CPEX policy layer ties approvals to arguments over CIBA.
  - **Stacklok ToolHive** has Cedar rules on arguments, but a list argument only shows whether it's present.
  - **agentgateway** has CEL rules over MCP and HTTP.
  - **Docker's gateway** checks arguments only under a Docker Sandboxes organization policy.
  - None of them documents counts across a run, thread checks, or a pause.
- **StrongDM Leash** (Apache 2.0) runs a coding agent in a container and enforces Cedar policies on file access, network connections, and MCP calls. Its MCP rules can block a tool but not allow one, and process rules match the binary, not its arguments.
- **agent-chaperone** (open source) is an MCP proxy that screens each call and result with a model, using thresholds in a policy file.
- **Warden** (stephnangue/warden, open source) holds credentials, checks MCP calls down to their arguments, and can carry the identity of the person the agent acts for.
- **Connector platforms:** Composio lets you allow, ask, or block a tool by name or type, and adds a classifier Firewall. Arcade calls webhooks before execution, where you write the checks yourself.
- **OpenClaw's own approvals** reach Telegram, Slack, and Signal, but they run inside the agent, which holds the credentials.

What heel puts together:

- rules on arguments with state checks and item counts
- hiding results the agent shouldn't read
- approvals tied to the exact call, that the agent can't answer
- pause and resume
- one rule file for MCP, HTTP, and CLI
- an open source license

## Where this comes from

We run a narrower version of this in production at [Charming](https://charm.ing), where apps that agents build call people's Gmail, GitHub, and other connected accounts. Each app function declares the tools it uses, the account owner approves each function, and the approval lapses when the function's tools, output, or allowed callers change. A classifier screens every tool across 124 services and keeps out the ones that leave access behind after a revoke. heel takes that model out of one product and puts it in front of any agent.
