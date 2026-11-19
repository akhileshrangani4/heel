# Rules reference

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Rules reference](rules-reference.md) · [Approvals](approvals.md) · [Running](running.md)

Everything a heel rules file can say, and exactly how heel reads it. [Rules and hiding](rules.md) is the short tour; this page is the one to keep open while you write rules. Every example on it is a complete file, and heel's test suite loads each one and runs its cases, so they all parse and behave as shown.

## Contents

- [A first rules file](#a-first-rules-file)
- [Where rules live](#where-rules-live)
- [How a call is decided](#how-a-call-is-decided)
- [The rules file](#the-rules-file)
- [Match keys](#match-keys)
- [Operators](#operators)
- [Counts and limits](#counts-and-limits)
- [State checks](#state-checks)
- [Calls that outlive heel](#calls-that-outlive-heel)
- [Grants, standing approvals and watch mode](#grants-standing-approvals-and-watch-mode)
- [Built-in services](#built-in-services)
- [Your own MCP servers](#your-own-mcp-servers)
- [HTTP accounts](#http-accounts)
- [CLI accounts](#cli-accounts)
- [Hiding](#hiding)
- [Testing rules](#testing-rules)
- [Recipes](#recipes)
- [Load errors and warnings](#load-errors-and-warnings)

## A first rules file

Save this as `$HEEL_HOME/rules/owner.yaml` (`owner` is the user name you enrolled with `heel user enroll`):

```yaml title="rules/owner.yaml"
rules:
  - name: reads
    match: { kind: read }
    then: allow

  - name: mail-to-coworkers
    match:
      action: email.send
      recipients: { all_domain_in: [company.com] }
    then: allow

  - name: other-mail
    match: { action: email.send }
    then: ask
```

Then describe calls and what you expect, in a cases file:

```yaml title="cases.yaml"
cases:
  - name: reading mail is fine
    call: { agent: my-agent, account: gmail-work, provider: gmail, tool: search, kind: read }
    expect: { decision: allow, rule: reads }

  - name: a coworker gets mail without asking
    call:
      agent: my-agent
      account: gmail-work
      action: email.send
      recipients: [sam@company.com]
    expect: { decision: allow, rule: mail-to-coworkers }

  - name: anyone else needs a yes
    call:
      agent: my-agent
      account: gmail-work
      action: email.send
      recipients: [sam@company.com, buyer@customer.com]
    expect: { decision: ask, rule: other-mail }

  - name: anything else is denied
    call: { agent: my-agent, account: github, action: github.merge, repo: acme/web }
    expect: { decision: deny, rule: default }
```

```text
$ heel rules test cases.yaml
ok    reading mail is fine: allow by rule 1 "reads" (rules/owner.yaml:2)
ok    a coworker gets mail without asking: allow by rule 2 "mail-to-coworkers" (rules/owner.yaml:6)
ok    anyone else needs a yes: ask by rule 3 "other-mail" (rules/owner.yaml:12)
ok    anything else is denied: deny by default

4 passed, 0 failed
```

heel reloads the file as soon as you save it.

## Where rules live

| File | Whose calls | Notes |
| --- | --- | --- |
| `$HEEL_HOME/org-rules.yaml` | Every agent | Checked first. Can only `deny` or `ask`, so nothing below it can loosen it. |
| `$HEEL_HOME/rules/<user>.yaml` | Agents owned by `<user>` | One file per person. The file name is the user name. |

- **Either file may be missing.** No org file means no org rules. A person with no file has no rules of their own, so their agents' calls fall through to the default deny.
- **Only `.yaml`.** A `rules/<user>.yml` file is ignored, and `heel rules check` warns about it. Hidden files and editor leftovers (`alice.yaml~`, `.alice.yaml.swp`) are skipped.
- **Reloading.** heel watches `$HEEL_HOME` and `rules/` and reloads about 100 ms after the last change. All files are read and checked first, then swapped in together, so no call ever sees half an edit.
- **A bad edit keeps the last good rules.** If a change doesn't load, heel keeps deciding with that file's last good rules and logs the problem; other people's valid edits still apply ([details](#load-errors-and-warnings)). If no valid rules have loaded since heel started, every call is denied.
- **`heel rules check` and `heel rules test` read the files directly,** so they work with heel stopped.

## How a call is decided

1. **Before any rule:** a pause, a hidden target, a tool or argument heel doesn't know, a command that would print a credential, and a few other hard denies stop the call. No rule can allow these.
2. **Calls that outlive heel** need a rule that names them: see [Calls that outlive heel](#calls-that-outlive-heel).
3. **Org rules, then your rules, top to bottom.** The first rule whose `match` holds decides with its `then`. Rules with `watch: true` are logged and skipped.
4. **Nothing matched:** the call is denied (`deny by default`).
5. **Standing approvals and intent grants** can turn an `ask` from your own rules into `allow`, and an intent grant can also allow a call nothing matched. Neither ever overrides a `deny` or an org `ask`. See [Grants, standing approvals and watch mode](#grants-standing-approvals-and-watch-mode).

There is no merging of decisions: one rule decides, and the order of the file is the priority. Put specific rules (deny this domain, limit this count) above broad ones (allow every send).

A rule can also deny a call even though it was going to match, when heel can't decide it safely. These denies show as the reason in Activity and in `heel rules test`:

| Reason | When |
| --- | --- |
| `rule` | A `deny` rule matched. |
| `no_rule_matched` | Nothing matched (the default deny). |
| `rules_unavailable` | No valid rules have loaded since heel started. |
| `persistence_unnamed` | A call that outlives heel, and no rule names its action or tool. |
| `address_unparseable` | An address in the call, or one a rule reads, doesn't parse. |
| `state_check_unavailable` | A rule would match, but its state check couldn't be looked up. |
| `body_unreadable` | A rule checks `body.*`, and the request body is in a content type heel doesn't parse. |

The last three never fall through to a broader rule below: a call heel can't judge is denied, not judged by a looser rule.

## The rules file

A rules file is YAML with two top-level keys, both optional:

| Key | Type | What it holds |
| --- | --- | --- |
| `rules` | list of rules | Checked top to bottom. |
| `hide` | list of hide entries | What agents never read from this person's accounts. See [Hiding](#hiding). |

Each rule has these keys. Any other key is an error.

| Key | Required | Type | What it does |
| --- | --- | --- | --- |
| `match` | yes | mapping | The conditions. Every key must hold. `match: {}` matches every call. |
| `then` | yes | `allow`, `ask` or `deny` | The decision when `match` holds. |
| `name` | no | text | A stable id, unique in the file. Shown in Activity, on the approval page and in `heel rules test`. |
| `watch` | no | `true` or `false` | `true`: log what this rule would decide, then keep going as if it hadn't matched. |

| Decision | What happens |
| --- | --- |
| `allow` | The call runs. |
| `ask` | The agent is told the call needs approval, and the owner gets a request (an org `ask` goes to an admin). Once approved, the agent sends the call again and it runs once. |
| `deny` | The call is refused, with the rule's name. |

## Match keys

Every key in a `match` must hold (AND). A key whose field the call doesn't have never holds, whatever its operator. To say "any of these", use `one_of` or `any_of` on one key, or write several rules.

| Key | Type | What it reads | Example |
| --- | --- | --- | --- |
| `account` | text | The account's alias, as you connected it. | `account: gmail-work` |
| `provider` | text | `gmail`, `outlook`, `google-calendar`, `github`, `slack`, `linear`, `notion`, `stripe`, or `mcp:<alias>`, `http:<alias>`, `cli:<command>`. | `provider: github` |
| `agent` | text | The agent's name, from `heel agent add`. | `agent: triage-bot` |
| `action` | text | What the call does, across services (`email.send`). Set by built-in services, by `gh` and `kubectl`, and by `x-heel-action` in an OpenAPI file. Built-in mail reads have none; calendar reads are `calendar.read`. | `action: { one_of: [email.send, email.draft] }` |
| `kind` | `read` or `write` | Set only where heel knows: built-in services, `gh`, `kubectl`, and `x-heel-kind`. Your own MCP tools and other CLIs have no kind, so neither value matches them. | `kind: read` |
| `tool` | text | The tool name: a built-in tool, your MCP server's own tool name, `<METHOD> <path>` for HTTP, or the command path for a CLI (`gh pr merge`). | `tool: create_ticket` |
| `recipients` | address list | Who a call reaches: to, cc and bcc together, a filter's forward address, calendar attendees, a Stripe customer's new email. | `recipients: { all_domain_in: [company.com] }` |
| `repo` | text | `owner/name`, in lower case (GitHub and `gh`). | `repo: { one_of: [acme/web, acme/api] }` |
| `calendar` | text | The calendar a calendar call touches. | `calendar: team@company.com` |
| `checks` | `passing` | [State check](#state-checks): the pull request's required checks pass. | `action: github.merge, checks: passing` |
| `items` | `{ over, per }` | [Counts](#counts-and-limits): how many messages or records. | `action: email.remove, items: { over: 50 }` |
| `method` | text | HTTP method, upper case. | `method: GET` |
| `path` | text | HTTP path: the OpenAPI template when one matched (`/repos/{owner}/{repo}`), otherwise the path as sent. | `path: { matches: "/admin/.*" }` |
| `command` | text | CLI: the command name (`argv[0]`). | `command: kubectl` |
| `verb` | text | CLI (`gh` and `kubectl` only): the first word of the command (`pr`, `delete`). | `verb: delete` |
| `subcommand` | text | CLI (`gh` and `kubectl` only): the rest of the command (`merge`, `deploy-key add`). | `verb: pr, subcommand: merge` |
| `argv` | text list | CLI: the whole command line, with the command name at index 0. | `argv: { any_of: [--force] }` |
| `channel` | Slack channel id | The channel a Slack call touches. | `channel: C0123ABCD` |
| `external` | `true` or `false` | Slack: the channel reaches another organization (Slack Connect, DMs). | `external: true` |
| `team` | Linear team key | Values are upper-cased, so `team: eng` is `ENG`. A `matches` pattern ignores case. | `team: eng` |
| `project` | Linear project id | The project's UUID, not its URL slug. | `project: 3f2b1c4e-8a9d-4e7f-b6a1-2c3d4e5f6a7b` |
| `parent` | Notion page or database id | The page or database a page sits under, or `workspace`. | `parent: workspace` |
| `amount` | number | Stripe: in the currency's smallest unit (cents). | `amount: { max: 5000 }` |
| `currency` | currency code | Stripe: three lower-case letters. | `currency: usd` |
| `customer` | Stripe customer id | Stripe: the customer a call touches. | `customer: cus_ABC123def` |
| `args.<path>` | any value | The call's arguments, after heel's own rewrites. Dots walk into objects and through arrays. | `args.base: main` |
| `body.<path>` | any value | An HTTP request's JSON or form body. | `body.amount: { max: 100 }` |
| `query.<name>` | text, or a list when repeated | An HTTP query parameter. | `query.state: open` |
| `flags.<name>` | text, `true`, or a list | A `gh` or `kubectl` flag, by its long name. A bare flag is `true`. | `flags.namespace: prod` |

`channel`, `external`, `team`, `project`, `parent`, `amount`, `currency` and `customer` are set only by the built-in services that have them, and a value of the wrong shape (`channel: general`) is a load error, not a rule that silently never matches.

## Operators

A key takes a value, which is shorthand for `equals`, or a mapping of operators. Several operators on one key must all hold.

```yaml title="rules/owner.yaml"
rules:
  - name: shorthand
    match: { repo: acme/web }
    then: allow
  - name: operators
    match: { repo: { matches: "acme/.*", one_of: [acme/api, acme/docs] } }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: shorthand is equals
    call: { agent: a, account: github, repo: acme/web }
    expect: { decision: allow, rule: shorthand }
  - name: both operators hold
    call: { agent: a, account: github, repo: acme/api }
    expect: { decision: ask, rule: operators }
  - name: one operator fails
    call: { agent: a, account: github, repo: acme/infra }
    expect: { decision: deny, rule: default }
```

### What each operator means

Some fields hold one value (`repo`), others a list (`recipients`, `argv`, `args.messages.id`). Each operator says how it treats both:

| Operator | Operand | One value | A list | An empty list |
| --- | --- | --- | --- | --- |
| `equals` | a value, or a list | is exactly the value | a list operand: the same set, ignoring order and repeats. A single operand: the list is exactly that one value. | holds only for `equals: []` |
| `one_of` | a list | is in the list | every element is in the list | never holds |
| `any_of` | a list | is in the list | at least one element is in the list | never holds |
| `matches` | an RE2 pattern | the whole value matches | every element matches | never holds |
| `any_domain_in` | domains | the address's domain is listed | at least one element's domain is listed | never holds |
| `all_domain_in` | domains | the address's domain is listed | every element's domain is listed | never holds |
| `max` | a number | the value is a number, at most this | the list has at most this many elements | holds |
| `all_in_thread` | `true` | `recipients` only: a [state check](#state-checks) | | never holds |

Which operators each key takes:

| Keys | Operators |
| --- | --- |
| `account`, `provider`, `agent`, `action`, `tool`, `repo`, `calendar`, `method`, `path`, `command`, `verb`, `subcommand` | `equals`, `one_of`, `any_of`, `matches` |
| `kind` | `equals`, `one_of`, `any_of` |
| `recipients` | `equals`, `one_of`, `any_of`, `matches`, `any_domain_in`, `all_domain_in`, `max`, `all_in_thread` |
| `argv` | `equals`, `one_of`, `any_of`, `matches`, `max` |
| `channel`, `team`, `project`, `parent`, `currency`, `customer` | `equals`, `one_of`, `any_of`, `matches` |
| `external` | `equals` |
| `amount` | `equals`, `one_of`, `max` |
| `args.*`, `body.*`, `query.*`, `flags.*` | `equals`, `one_of`, `any_of`, `matches`, `any_domain_in`, `all_domain_in`, `max` |

### Details that matter

- **Case matters,** except where heel normalizes. Text is compared exactly, but heel lower-cases `repo` and upper-cases `method` and `team` on the call and in your rule's literal values alike, so `repo: Acme/Web`, `method: get` and `team: eng` match. Addresses and domains are lower-cased on both sides too. A `matches` pattern ignores case on every field heel stores in one case (`repo`, `method`, `team`, `currency`, `project`, `parent` and `recipients`), so `repo: { matches: "Acme/.*" }` matches `acme/web` and `team: { matches: "eng|ops" }` matches `ENG`. On every other field, `matches` is case-sensitive.
- **Types matter.** `args.number: 42` matches the number 42, not the text `"42"`. HTTP query values, form body values and CLI flag values are always text; for `query.*` and `flags.*` heel reads a number you write as its text, so `query.limit: 100` matches `?limit=100` (in a form body, write `"100"`). `max` never holds on one of them, but on a repeated parameter or flag (a list) it limits how many there are.
- **`matches` is the whole value.** Patterns are [RE2](https://github.com/google/re2/wiki/Syntax) and anchored at both ends: `matches: "web"` doesn't match `acme/web`, but `matches: ".*web"` does. Quote patterns in YAML.
- **Shorthand on a list is set equality.** `recipients: sam@company.com` holds only when Sam is the only recipient. `argv: publish` never holds, because `argv` also holds the command name. Use `any_of` or `one_of` instead.
- **Paths walk through arrays.** `args.messages.id` reads `id` from every element of `args.messages`. An element without `id` makes "every element" checks fail, so a batch with one odd entry doesn't slip through.
- **Missing means no match.** A key naming something the call doesn't have (`repo` on a Gmail call, `args.base` on a call without it) never holds, not even `max`.
- **Addresses are normalized.** `Sam <SAM@Company.com>` is read as `sam@company.com`; `+tags` are kept. International domains are compared in punycode. A call with an address heel can't parse is denied (`address_unparseable`).
- **Domains:** `company.com` matches exactly that domain. `*.company.com` matches its subdomains only, not `company.com` itself; list both to cover both.

```yaml title="rules/owner.yaml"
rules:
  - name: whole-company
    match: { recipients: { all_domain_in: [company.com, "*.company.com"] } }
    then: allow
  - name: one-recipient
    match: { recipients: sam@partner.io }
    then: ask
  - name: npm-publish
    match: { command: npm, argv: { any_of: [publish] } }
    then: deny
```

```yaml title="cases.yaml"
cases:
  - name: a subdomain and the domain itself
    call: { agent: a, account: gmail-work, recipients: [sam@company.com, "Lee <LEE@EU.Company.com>"] }
    expect: { decision: allow, rule: whole-company }
  - name: exactly one recipient
    call: { agent: a, account: gmail-work, recipients: [sam@partner.io] }
    expect: { decision: ask, rule: one-recipient }
  - name: shorthand does not match a longer list
    call: { agent: a, account: gmail-work, recipients: [sam@partner.io, kim@partner.io] }
    expect: { decision: deny, rule: default }
  - name: any_of finds one word in the command line
    call: { agent: a, account: npm, cli: { command: npm, argv: [npm, publish, --tag, next] } }
    expect: { decision: deny, rule: npm-publish }
```

## Counts and limits

`items` matches on how much a call does, not just what it is. It counts items (messages, issues), not calls: one `trash` of 500 messages is 500.

| Form | Holds when |
| --- | --- |
| `items: { over: N }` | This call alone has more than N items. |
| `items: { over: N, per: hour }` | This agent's items in the last hour (a sliding window), plus this call's, are more than N. |
| `items: { over: N, per: run }` | The same, within the agent's current run. A call with no run id never matches. |

- **What counts:** only calls heel let run (allowed, approved and re-sent, or let through in watch mode), from the same agent, that match this rule's other conditions. Denied calls and calls waiting for approval don't count.
- **Items per call:** the messages a mail call moves, labels or removes (a thread counts its messages), an issue plus its sub-issues for a Linear delete, and 1 for everything else.
- **Per agent:** a limit counts one agent at a time. Two agents on the same account each get their own count.
- **Run ids** come from the agent: `_meta["heel/runId"]` over MCP, the `Heel-Run-Id` header over HTTP, `HEEL_RUN_ID` for `heel run`, or `run_id` in code mode. An agent can start a new run whenever it likes, so always pair a `per: run` limit with a `per: hour` limit on the same action below it. `heel rules check` warns when you don't.
- Put limits above the rule that allows the call, so the limit is checked first.

```yaml title="rules/owner.yaml"
rules:
  - name: big-batch
    match: { action: email.remove, items: { over: 50 } }
    then: ask
  - name: run-limit
    match: { action: email.remove, items: { over: 200, per: run } }
    then: ask
  - name: hour-limit
    match: { action: email.remove, items: { over: 500, per: hour } }
    then: deny
  - name: removals
    match: { action: email.remove }
    then: allow
```

In a cases file, `counts` says how many items the agent already used, and `run` gives the call a run id:

```yaml title="cases.yaml"
cases:
  - name: a small cleanup runs
    call: { agent: a, account: gmail-work, action: email.remove, items: 10, run: r1 }
    counts: { run: 40, hour: 40 }
    expect: { decision: allow, rule: removals }
  - name: one batch of 51 asks
    call: { agent: a, account: gmail-work, action: email.remove, items: 51 }
    expect: { decision: ask, rule: big-batch }
  - name: the run's 201st message asks
    call: { agent: a, account: gmail-work, action: email.remove, items: 1, run: r1 }
    counts: { run: 200, hour: 200 }
    expect: { decision: ask, rule: run-limit }
  - name: a new run id doesn't reset the hour
    call: { agent: a, account: gmail-work, action: email.remove, items: 10, run: r2 }
    counts: { run: 0, hour: 495 }
    expect: { decision: deny, rule: hour-limit }
```

## State checks

A state check looks something up before deciding, with heel's own access. Each exists only for the services that have it, and the rule must name the action (and, if it names a provider, a provider that has the check). Anything else is a load error.

| Check | Write it as | Holds when | Needs |
| --- | --- | --- | --- |
| `all_in_thread` | `recipients: { all_in_thread: true }` | Every recipient was on a message this mailbox sent in the call's thread. A new message (no thread) never holds. | `action: email.send`; provider `gmail` or `outlook` |
| `checks` | `checks: passing` | The pull request's required checks pass on its current head. heel then merges that exact commit, so a push after the check makes GitHub refuse the merge. `gh pr merge --admin` or `--auto` never holds. | `action: github.merge` or `github.workflow.merge`; provider `github` or `cli:gh` |

- **Lookups run last,** only for a rule whose other conditions hold.
- **A failed check** means the rule doesn't match, and evaluation goes on to the next rule.
- **A lookup that can't run** (the service is down) denies the call (`state_check_unavailable`) instead of falling through.

```yaml title="rules/owner.yaml"
rules:
  - name: green-merges
    match: { action: github.merge, repo: acme/web, checks: passing }
    then: allow
  - name: other-merges
    match: { action: github.merge }
    then: ask
```

In a cases file, `state` gives each check's result: `pass`, `fail` or `unavailable`.

```yaml title="cases.yaml"
cases:
  - name: green PR merges
    call: { agent: a, account: github, action: github.merge, repo: acme/web }
    state: { checks: pass }
    expect: { decision: allow, rule: green-merges }
  - name: red PR asks
    call: { agent: a, account: github, action: github.merge, repo: acme/web }
    state: { checks: fail }
    expect: { decision: ask, rule: other-merges }
  - name: GitHub down denies
    call: { agent: a, account: github, action: github.merge, repo: acme/web }
    state: { checks: unavailable }
    expect: { decision: deny, reason: state_check_unavailable }
```

## Calls that outlive heel

Some calls leave something behind that keeps acting after you revoke heel: a Gmail filter or Outlook rule that forwards mail, a scheduled Slack message, a pushed or merged GitHub workflow (through the GitHub service or `gh pr merge`), a raw API call (`github_api` through the GitHub service, or `gh api` through `heel run`), and `gh` deploy keys, SSH keys, secrets and variables. For these:

- **A rule must name them** by `action` or `tool`, as plain text (shorthand, `equals`, `one_of` or `any_of`). With no such rule, the call is denied (`persistence_unnamed`).
- **A broad rule can deny them but never allow or ask.** `match: {}` with `then: allow`, or `action: { matches: "github\\..*" }`, skips them.
- **Naming the action is enough.** A forwarding filter is `email.send`, so a rule `action: email.send` with `then: allow` admits one whose forward address passes the rule's other conditions.
- **`gh api` is one of them**, read or write, since heel can't tell what a raw call does. A broad `gh` allow skips it; name it (`tool: gh api` or `action: github.api`) to ask for it or allow it.

```yaml title="rules/owner.yaml"
rules:
  - name: everything-on-github
    match: { provider: github }
    then: allow
  - name: workflow-changes
    match: { action: { one_of: [github.workflow.push, github.workflow.merge] } }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: an ordinary push is allowed by the broad rule
    call: { agent: a, account: github, provider: github, action: github.push, repo: acme/web }
    expect: { decision: allow, rule: everything-on-github }
  - name: a workflow push skips the broad rule and asks
    call: { agent: a, account: github, provider: github, action: github.workflow.push, repo: acme/web, persistence: true }
    expect: { decision: ask, rule: workflow-changes }
  - name: a raw API call nothing names is denied
    call: { agent: a, account: github, provider: github, action: github.api, persistence: true }
    expect: { decision: deny, reason: persistence_unnamed }
```

The [built-in services](#built-in-services) tables mark which tools are persistence.

## Grants, standing approvals and watch mode

These change what happens around your rules, not the rules file itself.

| | What it does | Limits |
| --- | --- | --- |
| **Standing approval** ([Approvals](approvals.md) calls it a grant from an approval) | When you approve an `ask`, you can also allow, for this agent and for up to 90 days, either this exact call (same account, tool and arguments) or everything that rule asks about. | Checked only when that rule matches and would ask, and only for your own rules, never an org `ask`. It is tied to the rule's `match` and `then`: edit the rule and it ends. |
| **Intent grant** | A narrow `allow` for one agent and one task, which you sign with your passkey. It is one `match`, in the same language as a rule, and must name an action or tool. | Consulted only when your rules end in an `ask` or nothing matched. Never overrides a `deny` or an org `ask`. |
| **`watch: true` on a rule** | heel logs what the rule would have decided, then carries on as if it hadn't matched. | The rule never decides. |
| **Watch mode** (`heel serve --watch`, or Watch on the Modes page for the org or one person; the default is Enforce) | Calls your rules would deny or ask about run anyway, and Activity shows what would have happened. | Org rules, hard denies, pause, hiding, the fail-closed denies, and unnamed calls that outlive heel still hold. |

`heel rules test` evaluates rules alone, in Enforce mode, with no grants or standing approvals. [Approvals, grants and pause](approvals.md) and [Using heel](using-heel.md) cover the rest.

```yaml title="rules/owner.yaml"
rules:
  - name: try-auto-merge
    watch: true
    match: { action: github.merge, repo: acme/docs }
    then: allow
  - name: merges
    match: { action: github.merge }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: the watched rule is logged, the next rule decides
    call: { agent: a, account: github, action: github.merge, repo: acme/docs }
    expect: { decision: ask, rule: merges, watched: [try-auto-merge] }
```

## Built-in services

Each built-in service maps its tools to actions, so one rule covers the same thing everywhere: `email.send` is Gmail's and Outlook's send, reply, reply-all, forward and send-draft. The tables list every tool, its kind, its action, and what else a rule can match on. Every call also has `account`, `provider`, `agent`, `tool` and `args.*`.

- **Kind `read` is set only here**, by the service's own definition, never by an argument or a tool name.
- **Built-in mail reads have no action.** Match them with `kind: read`, or `tool`. Calendar reads (Google and Outlook) are `calendar.read`.
- **`args.*` reads the arguments as heel will run them.** For most tools these are the tool's own input arguments, as the agent sees them listed; the tables name the ones heel adds or rewrites (such as `args.base` on a merge).
- **Your own MCP servers, HTTP APIs and other CLIs** have none of this: see the sections after these tables.
- **Gmail and GitHub also answer at `/http/<account>/...`:** a request to their own REST paths becomes the same tool call, with the same action and fields.

<!-- generated by pnpm gen:rules-reference: begin -->

### Gmail

Provider `gmail`.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `search` | read | none |   |
| `get_message` | read | none |   |
| `get_thread` | read | none |   |
| `list_labels` | read | none |   |
| `list_send_as` | read | none |   |
| `send` | write | `email.send` | `recipients` |
| `reply` | write | `email.send` | `recipients`, `all_in_thread` |
| `reply_all` | write | `email.send` | `recipients`, `all_in_thread` |
| `forward` | write | `email.send` | `recipients`, `all_in_thread` |
| `create_draft` | write | `email.draft` | `recipients` |
| `update_draft` | write | `email.draft` | `recipients` |
| `delete_draft` | write | `email.draft` |   |
| `send_draft` | write | `email.send` | `recipients`, `all_in_thread` |
| `archive` | write | `email.remove` | `items` (messages) |
| `trash` | write | `email.remove` | `items` (messages) |
| `trash_thread` | write | `email.remove` | `items` (messages in the thread) |
| `modify_labels` | write | `email.remove` when it adds TRASH or SPAM or removes INBOX, else `email.label` | `items` (messages) |
| `list_filters` | read | none |   |
| `create_filter` | write | `email.filter`; `email.send` when it forwards | when it forwards: `recipients` (the forward address), and persistence |

### Outlook

Provider `outlook`. Outlook's `calendar` is the calendar id, or the mailbox's address for `default`.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `search` | read | none |   |
| `get_message` | read | none |   |
| `get_thread` | read | none |   |
| `list_folders` | read | none |   |
| `list_rules` | read | none |   |
| `list_send_as` | read | none |   |
| `send` | write | `email.send` | `recipients` |
| `reply` | write | `email.send` | `recipients`, `all_in_thread` |
| `reply_all` | write | `email.send` | `recipients`, `all_in_thread` |
| `forward` | write | `email.send` | `recipients`, `all_in_thread` |
| `create_draft` | write | `email.draft` | `recipients` |
| `update_draft` | write | `email.draft` | `recipients` |
| `delete_draft` | write | `email.draft` |   |
| `send_draft` | write | `email.send` | `recipients`, `all_in_thread` |
| `trash` | write | `email.remove` | `items` (messages) |
| `archive` | write | `email.remove` | `items` (messages) |
| `move` | write | `email.remove` into Deleted Items, Junk, Archive, Recoverable Items, a folder inside them, or a hidden folder; else `email.label`. Moves into Sent Items, Drafts or Outbox are refused. | `items` (messages) |
| `delete` | write | `email.remove` | `items` (messages) |
| `set_categories` | write | `email.label` | `items` (messages) |
| `create_rule` | write | `email.filter`; `email.send` when it forwards | when it forwards: `recipients` (the forward address), and persistence |
| `list_calendars` | read | `calendar.read` |   |
| `list_events` | read | `calendar.read` | `calendar` |
| `get_event` | read | `calendar.read` |   |
| `create_event` | write | `calendar.event.create` | `recipients` (attendees), `calendar` |
| `update_event` | write | `calendar.event.update` | `recipients` (old and new attendees) |
| `delete_event` | write | `calendar.event.delete` | `recipients` (attendees) |

### Google Calendar

Provider `google-calendar`. `calendar` is the calendar id in lower case, or the account's address for `primary`.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `list_calendars` | read | `calendar.read` |   |
| `list_events` | read | `calendar.read` | `calendar` |
| `get_event` | read | `calendar.read` | `calendar` |
| `create_event` | write | `calendar.event.create` | `recipients` (attendees), `calendar` |
| `update_event` | write | `calendar.event.update` | `recipients` (old and new attendees), `calendar` |
| `delete_event` | write | `calendar.event.delete` | `recipients` (attendees), `calendar` |

### GitHub

Provider `github`. `repo` is `owner/name` in lower case. A request to `/http/<account>/...` for a REST path no tool covers becomes the unlisted tool `github_api`: action `github.api`, kind `write`, persistence, and no `repo`.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `list_pull_requests` | read | `github.read` | `repo` |
| `get_pull_request` | read | `github.read` | `repo` |
| `list_pull_request_files` | read | `github.read` | `repo` |
| `list_issues` | read | `github.read` | `repo` |
| `get_issue` | read | `github.read` | `repo` |
| `get_file_contents` | read | `github.read` | `repo` |
| `list_check_runs` | read | `github.read` | `repo` |
| `create_issue` | write | `github.issue.create` | `repo` |
| `update_issue` | write | `github.issue.update` | `repo` |
| `add_comment` | write | `github.comment` | `repo` |
| `create_pull_request` | write | `github.pr.create` | `repo` |
| `update_pull_request` | write | `github.pr.update` | `repo` |
| `merge_pull_request` | write | `github.merge`; `github.workflow.merge` when the PR changes `.github/workflows/` or `.github/actions/` | `repo`, `args.base` (base branch), `checks`; persistence for `github.workflow.merge` |
| `put_file` | write | `github.push`; `github.workflow.push` for `.github/workflows/` or `.github/actions/` | `repo`, `args.branch`, `args.path`; persistence for `github.workflow.push` |

### Slack

Provider `slack`. `external` is true for Slack Connect channels, DMs and group DMs.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `list_channels` | read | `slack.read` |   |
| `read_channel` | read | `slack.read` | `channel`, `external` |
| `read_thread` | read | `slack.read` | `channel`, `external` |
| `post_message` | write | `slack.post` | `channel`, `external` |
| `update_message` | write | `slack.update` | `channel`, `external` |
| `delete_message` | write | `slack.delete` | `channel`, `external` |
| `schedule_message` | write | `slack.schedule` | `channel`, `external`; persistence |

### Linear

Provider `linear`. `team` is the team key (`ENG`); `project` is the project's UUID.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `list_issues` | read | `linear.read` | `team` |
| `get_issue` | read | `linear.read` | `team`, `project` |
| `create_issue` | write | `linear.issue.create` | `team`, `project` |
| `update_issue` | write | `linear.issue.update` | `team`, `project` |
| `delete_issue` | write | `linear.issue.delete` | `team`, `project`, `items` (the issue and its sub-issues) |
| `add_comment` | write | `linear.comment` | `team`, `project` |

### Notion

Provider `notion`. `parent` is the page or database id the page sits directly under, or `workspace`.

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `search` | read | `notion.read` |   |
| `get_page` | read | `notion.read` | `parent` |
| `read_page` | read | `notion.read` | `parent` |
| `create_page` | write | `notion.page.create` | `parent` |
| `append_paragraphs` | write | `notion.page.update` | `parent` |
| `trash_page` | write | `notion.page.delete` | `parent` |

### Stripe

Provider `stripe`. `amount` is in the currency's smallest unit (cents for `usd`).

| Tool | Kind | Action | Rules also see |
| --- | --- | --- | --- |
| `list_payments` | read | `stripe.read` | `customer` |
| `get_customer` | read | `stripe.read` | `customer` |
| `refund` | write | `stripe.refund` | `amount`, `currency`, `customer` |
| `create_payment` | write | `stripe.payment.create` | `amount`, `currency`, `customer` |
| `update_customer` | write | `stripe.customer.update` | `customer`, `recipients` (a new email) |
| `set_subscription_cancellation` | write | `stripe.subscription.update` | `customer`, `currency` |

### gh

A CLI account for `gh` has provider `cli:gh`. A command that takes `-R` must be given it, and its value becomes `repo` (lower case). A `gh pr merge` that lands `.github/workflows/` or `.github/actions/` files is `github.workflow.merge` and persistence, like the GitHub service's merge.

| Action | Kind | Commands |
| --- | --- | --- |
| `github.read` | read | `gh pr view`, `gh pr list`, `gh pr status`, `gh pr diff`, `gh pr checks`, `gh issue view`, `gh issue list`, `gh issue status`, `gh repo view`, `gh repo list`, `gh repo read-dir`, `gh repo read-file`, `gh run view`, `gh run list`, `gh run watch`, `gh workflow view`, `gh workflow list`, `gh release view`, `gh release list`, `gh label list`, `gh search code`, `gh search commits`, `gh search issues`, `gh search prs`, `gh search repos`, `gh ruleset list`, `gh ruleset view`, `gh ruleset check`, `gh cache list`, `gh status` |
| `github.pr.create` | write | `gh pr create`, `gh pr revert` |
| `github.pr.update` | write | `gh pr edit`, `gh pr close`, `gh pr reopen`, `gh pr ready`, `gh pr lock`, `gh pr unlock`, `gh pr update-branch` |
| `github.comment` | write | `gh pr comment`, `gh issue comment` |
| `github.issue.create` | write | `gh issue create` |
| `github.issue.update` | write | `gh issue edit`, `gh issue close`, `gh issue reopen`, `gh issue lock`, `gh issue unlock`, `gh issue pin`, `gh issue unpin` |
| `github.merge` | write | `gh pr merge` |
| `github.api` | write | `gh api` |

Persistence, so only a rule naming the `tool` (`tool: gh secret set`), or for `gh api` its action `github.api`, admits them: `gh api`, `gh repo deploy-key add`, `gh ssh-key add`, `gh secret set`, `gh variable set`.

Always refused, because they run code from the checkout with the token set: `gh pr checkout`, `gh repo clone`, `gh repo sync`.

Any other `gh` command has no action and no kind: match it with `command`, `verb`, `subcommand`, `flags.*` or `argv`.

### kubectl

A CLI account for `kubectl` has provider `cli:kubectl`. Every command's action is `kubectl.<verb>` (`kubectl.get`, `kubectl.delete`), and flags are named by their long form, so `-n prod` is `flags.namespace: prod`.

Kind `read` for: `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl explain`, `kubectl api-resources`, `kubectl api-versions`, `kubectl cluster-info`, `kubectl cluster-info dump`, `kubectl top node`, `kubectl top pod`, `kubectl version`, `kubectl events`, `kubectl diff`, `kubectl wait`, `kubectl auth can-i`, `kubectl auth whoami`, `kubectl rollout history`, `kubectl rollout status`, `kubectl config view`, `kubectl config current-context`, `kubectl config get-clusters`, `kubectl config get-contexts`, `kubectl config get-users`. Every other command is `write`.

<!-- generated by pnpm gen:rules-reference: end -->

## Your own MCP servers

An MCP server you connect (`heel connect mcp`) is passed through as it is. heel doesn't know what its tools do, so:

- **`provider` is `mcp:<alias>`**, `account` is the alias, and `tool` is the server's own tool name (without the `<alias>__` prefix the agent sees).
- **There is no `action` and no `kind`.** `kind: read` never covers these tools; name them with `tool`.
- **`args.<path>` reads the tool's arguments** exactly as the agent sent them.
- **A tool that appears later** (the server adds one mid-run) is matched like any other: a broad rule such as `match: { account: jira }` covers it, so prefer naming tools.
- heel can allow or deny a call but can't hide items from what comes back.

```yaml title="rules/owner.yaml"
rules:
  - name: jira-reads
    match: { account: jira, tool: { matches: "(get|list|search)_.*" } }
    then: allow
  - name: jira-own-project
    match: { account: jira, tool: create_issue, args.project: OPS }
    then: allow
  - name: jira-other-writes
    match: { account: jira }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: reads by name
    call: { agent: a, account: jira, provider: "mcp:jira", tool: search_issues, args: { jql: "assignee = me" } }
    expect: { decision: allow, rule: jira-reads }
  - name: a ticket in our own project
    call: { agent: a, account: jira, provider: "mcp:jira", tool: create_issue, args: { project: OPS, summary: Disk full } }
    expect: { decision: allow, rule: jira-own-project }
  - name: a ticket anywhere else asks
    call: { agent: a, account: jira, provider: "mcp:jira", tool: create_issue, args: { project: SALES, summary: Hi } }
    expect: { decision: ask, rule: jira-other-writes }
```

## HTTP accounts

An HTTP account (`heel connect http`) is an API heel reaches at one base URL. Agents call it at `/http/<alias>/<path>`.

| Key | Holds |
| --- | --- |
| `provider` | `http:<alias>` |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, ... in upper case |
| `path` | The OpenAPI path template the request matched (`/v1/charges/{id}`), or the path as sent when none matched. With a template, a rule on the literal path never matches. |
| `tool` | `<METHOD> <path>`, with the template when one matched: `GET /v1/charges/{id}` |
| `query.<name>` | A query parameter, as text; a list when it is repeated |
| `body.<path>` | The JSON or form body. In any other content type, a rule that reads `body.*` denies the call (`body_unreadable`). |
| `action`, `kind` | Only from `x-heel-action` and `x-heel-kind` on the operation in the account's OpenAPI file. Without them the call has neither. |

```yaml title="rules/owner.yaml"
rules:
  - name: no-admin
    match: { account: billing-api, path: { matches: "/admin/.*" } }
    then: deny
  - name: api-reads
    match: { account: billing-api, method: GET }
    then: allow
  - name: small-credits
    match: { account: billing-api, method: POST, path: "/v1/credits", body.amount: { max: 100 } }
    then: allow
  - name: api-writes
    match: { account: billing-api }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: admin paths are denied even for GET
    call: { agent: a, account: billing-api, http: { method: GET, path: /admin/users } }
    expect: { decision: deny, rule: no-admin }
  - name: reads run
    call: { agent: a, account: billing-api, http: { method: GET, path: /v1/charges/ch_1, path_template: "/v1/charges/{id}" } }
    expect: { decision: allow, rule: api-reads }
  - name: a small credit runs
    call: { agent: a, account: billing-api, http: { method: POST, path: /v1/credits, body: { amount: 50 } } }
    expect: { decision: allow, rule: small-credits }
  - name: a large credit asks
    call: { agent: a, account: billing-api, http: { method: POST, path: /v1/credits, body: { amount: 5000 } } }
    expect: { decision: ask, rule: api-writes }
```

## CLI accounts

A CLI account (`heel connect cli`) runs one command for the agent through `heel run -- <command> ...`. heel never uses a shell: `sh -c "gh auth token"` is the command `sh`, not `gh`.

| Key | Holds |
| --- | --- |
| `provider` | `cli:<command>` |
| `command` | The command name (`gh`, `kubectl`, `npm`) |
| `argv` | The whole command line as a list, with the command name first |
| `tool` | The command path: `gh pr merge`, `kubectl delete`, or just `npm` for other CLIs |
| `verb`, `subcommand`, `flags.<name>` | `gh` and `kubectl` only, parsed the way the tool itself parses them. `gh -R acme/web pr merge 12` has `verb: pr`, `subcommand: merge`, `flags.repo: acme/web`. Flags use their long names. |
| `action`, `kind`, `repo` | `gh` and `kubectl` only: see [gh](#gh) and [kubectl](#kubectl). |

For `gh`, a pull request or issue URL argument also sets `repo`. For any other command, rules see only `command`, `argv` and `tool`, so match on `argv` with `any_of`, `one_of`, `matches` or `max`. heel refuses, before any rule, a `gh` or `kubectl` command line it can't parse, one that would print a credential, and one that points the tool at another server or identity.

```yaml title="rules/owner.yaml"
rules:
  - name: kubectl-reads
    match: { command: kubectl, kind: read }
    then: allow
  - name: no-prod-deletes
    match: { command: kubectl, verb: delete, flags.namespace: prod }
    then: deny
  - name: kubectl-writes
    match: { command: kubectl }
    then: ask
  - name: gh-api-asks
    match: { tool: gh api }
    then: ask
  - name: gh-reads
    match: { command: gh, kind: read }
    then: allow
  - name: npm-installs
    match:
      command: npm
      argv: { one_of: [npm, install, ci, --ignore-scripts], any_of: [--ignore-scripts] }
    then: allow
```

```yaml title="cases.yaml"
cases:
  - name: get pods
    call: { agent: a, account: k8s, action: kubectl.get, kind: read, cli: { command: kubectl, verb: get, flags: { namespace: prod }, argv: [kubectl, get, pods, -n, prod] } }
    expect: { decision: allow, rule: kubectl-reads }
  - name: delete in prod
    call: { agent: a, account: k8s, action: kubectl.delete, kind: write, cli: { command: kubectl, verb: delete, flags: { namespace: prod }, argv: [kubectl, -n, prod, delete, pod, web-1] } }
    expect: { decision: deny, rule: no-prod-deletes }
  - name: delete in staging asks
    call: { agent: a, account: k8s, action: kubectl.delete, kind: write, cli: { command: kubectl, verb: delete, flags: { namespace: staging }, argv: [kubectl, -n, staging, delete, pod, web-1] } }
    expect: { decision: ask, rule: kubectl-writes }
  - name: gh api asks, whatever it calls
    call: { agent: a, account: gh, provider: "cli:gh", tool: gh api, action: github.api, kind: write, persistence: true, cli: { command: gh, verb: api, argv: [gh, api, /user] } }
    expect: { decision: ask, rule: gh-api-asks }
  - name: gh pr view is a read
    call: { agent: a, account: gh, provider: "cli:gh", tool: gh pr view, action: github.read, kind: read, repo: acme/web, cli: { command: gh, verb: pr, subcommand: view, flags: { repo: acme/web }, argv: [gh, pr, view, "7", -R, acme/web] } }
    expect: { decision: allow, rule: gh-reads }
  - name: npm ci with scripts off
    call: { agent: a, account: npm, cli: { command: npm, argv: [npm, ci, --ignore-scripts] } }
    expect: { decision: allow, rule: npm-installs }
  - name: npm ci with scripts on is denied
    call: { agent: a, account: npm, cli: { command: npm, argv: [npm, ci] } }
    expect: { decision: deny, rule: default }
```

In the last rule, `one_of` lets through only command lines whose every word is in its list, and `any_of` requires `--ignore-scripts` among them. So `npm ci --ignore-scripts` runs, and plain `npm ci` (which would run install scripts) is denied.

## Hiding

`hide` is the other top-level key. Its entries decide what an agent never reads from this person's accounts (the org file's entries cover every account). [Rules and hiding](rules.md#hiding-what-the-agent-reads) explains how hidden messages behave; this is the syntax.

| Key | Type | Operators |
| --- | --- | --- |
| `from` | one address | `equals`, `one_of`, `any_of`, `matches`, `any_domain_in`, `all_domain_in` |
| `to` | address list (to, cc and bcc) | the same, plus `max` |
| `subject` | text | `equals`, `one_of`, `any_of`, `matches` |
| `labels` | text list | `equals`, `one_of`, `any_of`, `matches`, `max` |
| `looks_like` | `password_reset`, `login_code`, or a list of them | |

Keys in one entry must all hold; a message that matches any entry is hidden. An entry needs at least one key.

```yaml title="rules/owner.yaml"
hide:
  - email: { from: { any_domain_in: [family.example] } }
  - email: { looks_like: [password_reset, login_code] }
  - email: { from: { any_of: [hr@company.com] }, subject: { matches: "(?i).*salary.*" } }
```

```text
$ heel rules check
ok    rules/owner.yaml (user owner): 0 rules, 3 hide entries
```

## Testing rules

### heel rules check

Loads `org-rules.yaml` and every `rules/<user>.yaml` exactly as heel would, and prints one line per file. It exits 0 when the rules load (warnings included) and 65 when they don't, with every problem listed by file, line and column:

```yaml title="rules/owner.yaml"
rules:
  - match: { acount: gmail-work }
    then: allow
  - match: { recipients: { all_in_thread: true } }
    then: allow
```

```text
$ heel rules check
heel: rules are invalid (2 problems):
  ~/.heel/rules/owner.yaml:2:22: rules.0.match.acount: unknown match key "acount"; use account, provider, agent, action, kind, recipients, repo, calendar, checks, items, tool, method, path, command, verb, subcommand, argv, channel, external, team, project, parent, amount, currency, customer, args.<path>, body.<path>, query.<name> or flags.<name>
  ~/.heel/rules/owner.yaml:4:26: rules.1.match.recipients: all_in_thread is a state check heel has only for action email.send; name that action in this rule (I-23)
```

It also warns, without failing, about names that match nothing, so the rule would never fire:

- **An action that doesn't exist,** when it starts with a built-in prefix (`email.`, `calendar.`, `github.`, `slack.`, `linear.`, `notion.`, `stripe.`). An HTTP account's own `x-heel-action` names aren't flagged.
- **An account that isn't connected.** This is checked only while heel is running, against its accounts. Otherwise a rule that names an account gets a `note` that account names weren't checked.

```yaml title="rules/owner.yaml"
rules:
  - match: { action: email.sends }
    then: ask
  - match: { account: gh-wrok, action: github.merge }
    then: ask
```

```text
$ heel rules check
ok    rules/owner.yaml (user owner): 2 rules, 0 hide entries
warn  rules/owner.yaml:2: action "email.sends" doesn't exist, so this rule never matches. email actions: email.draft, email.filter, email.label, email.remove, email.send
note  heel isn't running, so account names weren't checked
```

With heel running, the second rule would get its own warning: `no account named "gh-wrok", so this rule never matches until one is connected. Accounts: gh`.

`heel rules draft "<words>"` asks a configured model for a draft rules file and prints it with a diff; it never saves it.

`heel rules schema` prints the JSON Schema for editors (also at [`schema/heel-rules.schema.json`](../schema/heel-rules.schema.json)), so an editor with YAML support can complete keys and flag mistakes as you type.

### heel rules test

`heel rules test <cases.yaml> [--user <user>]` runs each case against the rules on disk. Nothing is called and no service is read: the case says what the call is, and what state checks and counts would find.

- **Whose rules:** the case's `user`, else `--user`, else the only user with a rules file. With several, name one.
- **Output:** `ok`, `FAIL` (with what was expected and what happened) or `ERROR` (the case can't run as written, such as a call that reaches a state check the case gives no result for). Then a summary.
- **Exit code:** 0 when every case passes, 1 when any fails or can't run, 65 when the rules or the cases file don't load.

### The cases file

```text
cases:
  - name:      text, required
    user:      whose rules (optional)
    call:      the call, required (below)
    counts:    { run: N, hour: N }   items this agent already used (default 0)
    state:     { checks: pass, all_in_thread: fail }   pass, fail or unavailable
    expect:
      decision: allow, ask or deny (required)
      rule:     which rule decided (optional)
      reason:   a deny reason (optional)
      watched:  the watch: true rules that matched, in order (optional)
```

`expect.rule` is a rule's `name`, its 1-based position in the user's file (`3`), `org:<n>` for the org file, or `default` for the default deny. `expect.reason` is one of the [deny reasons](#how-a-call-is-decided).

The `call` is what the rules see, written as heel would derive it. Nothing is derived for you:

- **Copy the fields a real call has** from the [service tables](#built-in-services): a rule on `provider` needs `provider` in the case, and `kind` and `action` belong only on calls that really have them (an unmapped `gh` command has neither).
- **`tool` isn't built from `cli` or `http`.** Give it yourself: `tool: gh secret set`, or `tool: "DELETE /contacts/{id}"`.
- **`repo` and `method` are normalized** as on a real call (lower-case repo, upper-case method). Other values are used as written.
- **`counts` applies to every counting rule** the call reaches, whatever its other conditions.

| Key | Type | Notes |
| --- | --- | --- |
| `agent` | text | Required. |
| `account` | text | Required. |
| `provider`, `tool`, `action`, `repo`, `calendar` | text | |
| `kind` | `read` or `write` | |
| `recipients` | list of addresses | |
| `fields` | mapping | `channel`, `external`, `team`, `project`, `parent`, `amount`, `currency`, `customer` |
| `items` | number | Default 1. |
| `run` | text | The run id; leave it out for a call without one. |
| `args` | any | What `args.*` reads. |
| `persistence` | `true` or `false` | The call outlives heel. |
| `http` | mapping | `method`, `path` (required); `path_template`, `query`, `body`. |
| `cli` | mapping | `command`, `argv` (required); `verb`, `subcommand`, `flags`. |

### A worked example

An org file, one person's rules, and cases that cover each rule, including a failing one:

```yaml title="org-rules.yaml"
rules:
  - name: no-rivals
    match: { recipients: { any_domain_in: [rival.com] } }
    then: deny
```

```yaml title="rules/owner.yaml"
rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: hourly-sends
    match: { action: email.send, items: { over: 20, per: hour } }
    then: deny
  - name: team-mail
    match:
      action: email.send
      recipients: { all_in_thread: true, all_domain_in: [company.com] }
    then: allow
  - name: other-mail
    match: { action: email.send }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: the org rule beats everything
    call: { agent: a, account: gmail-work, provider: gmail, action: email.send, recipients: [ceo@rival.com] }
    expect: { decision: deny, rule: "org:1" }
  - name: a reply to coworkers in the thread
    call: { agent: a, account: gmail-work, provider: gmail, action: email.send, recipients: [sam@company.com] }
    state: { all_in_thread: pass }
    expect: { decision: allow, rule: team-mail }
  - name: the 21st send this hour
    call: { agent: a, account: gmail-work, provider: gmail, action: email.send, recipients: [sam@company.com] }
    counts: { hour: 20 }
    expect: { decision: deny, rule: hourly-sends }
  - name: a new thread asks
    call: { agent: a, account: gmail-work, provider: gmail, action: email.send, recipients: [sam@company.com] }
    state: { all_in_thread: fail }
    expect: { decision: allow }
  - name: forgot the state
    call: { agent: a, account: gmail-work, provider: gmail, action: email.send, recipients: [sam@company.com] }
    expect: { decision: allow }
```

```text
$ heel rules test cases.yaml
ok    the org rule beats everything: deny by org:1 "no-rivals" (org-rules.yaml:2)
ok    a reply to coworkers in the thread: allow by rule 3 "team-mail" (rules/owner.yaml:8)
ok    the 21st send this hour: deny by rule 2 "hourly-sends" (rules/owner.yaml:5)
FAIL  a new thread asks
        expected: allow
        got:      ask by rule 4 "other-mail" (rules/owner.yaml:13)
ERROR forgot the state: the call reaches rule 3 "team-mail" (rules/owner.yaml:8), which needs state.all_in_thread; give pass, fail or unavailable

3 passed, 1 failed, 1 could not run
```

The fourth case's rules are right and its expectation is wrong: change it to `decision: ask`. The fifth needs `state: { all_in_thread: pass }` or `fail`.

## Recipes

Each recipe is a whole rules file you can copy, followed by cases that show it doing what it says. Combine recipes by putting their rules in one file, specific rules first.

### Allow reads, ask for everything else

```yaml title="rules/owner.yaml"
rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: everything-else
    match: {}
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: a read runs
    call: { agent: a, account: gmail-work, tool: search, kind: read }
    expect: { decision: allow, rule: reads }
  - name: a send asks
    call: { agent: a, account: gmail-work, action: email.send, kind: write, recipients: [sam@company.com] }
    expect: { decision: ask, rule: everything-else }
  - name: an unknown MCP tool asks too, since it has no kind
    call: { agent: a, account: jira, provider: "mcp:jira", tool: get_issue }
    expect: { decision: ask, rule: everything-else }
```

`match: {}` with `ask` still can't reach [calls that outlive heel](#calls-that-outlive-heel): those stay denied until a rule names them.

### Mail inside the company runs, mail outside asks

```yaml title="rules/owner.yaml"
rules:
  - name: internal-mail
    match: { action: email.send, recipients: { all_domain_in: [company.com] } }
    then: allow
  - name: external-mail
    match: { action: email.send }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: all coworkers
    call: { agent: a, account: gmail-work, action: email.send, recipients: [sam@company.com, kim@company.com] }
    expect: { decision: allow, rule: internal-mail }
  - name: one outsider makes it ask
    call: { agent: a, account: gmail-work, action: email.send, recipients: [sam@company.com, buyer@customer.com] }
    expect: { decision: ask, rule: external-mail }
```

### Never email a competitor, from any account

Put this in `org-rules.yaml` so no one's own rules can undo it. `email.send` also covers filters that forward, and `recipients` also covers calendar invites, so leave `action` out:

```yaml title="org-rules.yaml"
rules:
  - name: no-rivals
    match: { recipients: { any_domain_in: [rival.com, "*.rival.com"] } }
    then: deny
```

```yaml title="rules/owner.yaml"
rules:
  - name: sends
    match: { action: email.send }
    then: allow
```

```yaml title="cases.yaml"
cases:
  - name: mail to a rival
    call: { agent: a, account: gmail-work, action: email.send, recipients: [sam@company.com, ceo@rival.com] }
    expect: { decision: deny, rule: "org:1" }
  - name: an invite to a rival's subdomain
    call: { agent: a, account: outlook, action: calendar.event.create, recipients: [pm@eu.rival.com] }
    expect: { decision: deny, rule: "org:1" }
  - name: everyone else is up to your own rules
    call: { agent: a, account: gmail-work, action: email.send, recipients: [buyer@customer.com] }
    expect: { decision: allow, rule: sends }
```

### At most 20 emails an hour, per agent

```yaml title="rules/owner.yaml"
rules:
  - name: send-limit
    match: { action: email.send, items: { over: 20, per: hour } }
    then: deny
  - name: sends
    match: { action: email.send }
    then: allow
```

```yaml title="cases.yaml"
cases:
  - name: the 20th send
    call: { agent: a, account: gmail-work, action: email.send, recipients: [sam@company.com] }
    counts: { hour: 19 }
    expect: { decision: allow, rule: sends }
  - name: the 21st send
    call: { agent: a, account: gmail-work, action: email.send, recipients: [sam@company.com] }
    counts: { hour: 20 }
    expect: { decision: deny, rule: send-limit }
```

Use `then: ask` instead of `deny` to approve the extra mail by hand.

### Never delete anything

One rule for every service's delete. Archive and trash are `email.remove` too, so this also stops cleanup:

```yaml title="rules/owner.yaml"
rules:
  - name: no-deletes
    match:
      action:
        one_of:
          - email.remove
          - calendar.event.delete
          - slack.delete
          - linear.issue.delete
          - notion.page.delete
    then: deny
  - name: everything-else
    match: {}
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: trashing mail
    call: { agent: a, account: gmail-work, action: email.remove, items: 3 }
    expect: { decision: deny, rule: no-deletes }
  - name: deleting a Linear issue
    call: { agent: a, account: linear, action: linear.issue.delete, fields: { team: ENG } }
    expect: { decision: deny, rule: no-deletes }
  - name: labelling mail is not a delete
    call: { agent: a, account: gmail-work, action: email.label, items: 3 }
    expect: { decision: ask, rule: everything-else }
```

For `kubectl delete`, match `action: kubectl.delete`.

### Merges to main ask, other green merges run

The GitHub service passes the pull request's base branch as `args.base`. `gh pr merge` through `heel run` doesn't carry the base branch, so those merges fall to the last rule and ask.

```yaml title="rules/owner.yaml"
rules:
  - name: merges-to-main
    match: { action: github.merge, args.base: main }
    then: ask
  - name: green-merges
    match: { action: github.merge, provider: github, checks: passing }
    then: allow
  - name: other-merges
    match: { action: github.merge }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: into main
    call: { agent: a, account: github, provider: github, action: github.merge, repo: acme/web, args: { repo: acme/web, number: 7, base: main } }
    expect: { decision: ask, rule: merges-to-main }
  - name: a green PR into a release branch
    call: { agent: a, account: github, provider: github, action: github.merge, repo: acme/web, args: { repo: acme/web, number: 8, base: release-2 } }
    state: { checks: pass }
    expect: { decision: allow, rule: green-merges }
  - name: a red PR into a release branch
    call: { agent: a, account: github, provider: github, action: github.merge, repo: acme/web, args: { repo: acme/web, number: 9, base: release-2 } }
    state: { checks: fail }
    expect: { decision: ask, rule: other-merges }
  - name: gh pr merge has no base branch
    call: { agent: a, account: gh, provider: "cli:gh", action: github.merge, repo: acme/web, cli: { command: gh, verb: pr, subcommand: merge, flags: { repo: acme/web }, argv: [gh, pr, merge, "9", -R, acme/web] } }
    expect: { decision: ask, rule: other-merges }
```

A merge that changes `.github/workflows/` is `github.workflow.merge`, not `github.merge`, so none of these rules reach it: it stays denied until a rule names it.

### A custom MCP tool always asks

```yaml title="rules/owner.yaml"
rules:
  - name: deploys-ask
    match: { account: ops, tool: deploy }
    then: ask
  - name: ops-tools
    match: { account: ops }
    then: allow
```

```yaml title="cases.yaml"
cases:
  - name: deploy asks
    call: { agent: a, account: ops, provider: "mcp:ops", tool: deploy, args: { service: web } }
    expect: { decision: ask, rule: deploys-ask }
  - name: other tools run
    call: { agent: a, account: ops, provider: "mcp:ops", tool: status }
    expect: { decision: allow, rule: ops-tools }
```

### Slack: post in our channels, never in shared ones

```yaml title="rules/owner.yaml"
rules:
  - name: no-shared-channels
    match: { action: { one_of: [slack.post, slack.update, slack.schedule] }, external: true }
    then: deny
  - name: eng-channel
    match: { action: slack.post, channel: C0123ABCD }
    then: allow
  - name: other-posts
    match: { action: slack.post }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: a Slack Connect channel
    call: { agent: a, account: slack, action: slack.post, fields: { channel: C0999SHARED, external: true } }
    expect: { decision: deny, rule: no-shared-channels }
  - name: the eng channel
    call: { agent: a, account: slack, action: slack.post, fields: { channel: C0123ABCD, external: false } }
    expect: { decision: allow, rule: eng-channel }
  - name: another internal channel asks
    call: { agent: a, account: slack, action: slack.post, fields: { channel: C0456EFGH, external: false } }
    expect: { decision: ask, rule: other-posts }
```

### Stripe: small refunds run, large ones ask

```yaml title="rules/owner.yaml"
rules:
  - name: small-refunds
    match: { action: stripe.refund, currency: usd, amount: { max: 5000 } }
    then: allow
  - name: other-refunds
    match: { action: stripe.refund }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: a 20 dollar refund
    call: { agent: a, account: stripe, action: stripe.refund, fields: { amount: 2000, currency: usd, customer: cus_ABC123def } }
    expect: { decision: allow, rule: small-refunds }
  - name: a 500 dollar refund
    call: { agent: a, account: stripe, action: stripe.refund, fields: { amount: 50000, currency: usd } }
    expect: { decision: ask, rule: other-refunds }
  - name: another currency asks
    call: { agent: a, account: stripe, action: stripe.refund, fields: { amount: 2000, currency: eur } }
    expect: { decision: ask, rule: other-refunds }
```

### One agent only reads

`agent` lets one person's rules treat agents differently. Put the agent's rules first:

```yaml title="rules/owner.yaml"
rules:
  - name: triage-reads
    match: { agent: triage-bot, kind: read }
    then: allow
  - name: triage-nothing-else
    match: { agent: triage-bot }
    then: deny
  - name: others-send
    match: { action: email.send }
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: triage-bot reads
    call: { agent: triage-bot, account: gmail-work, tool: get_thread, kind: read }
    expect: { decision: allow, rule: triage-reads }
  - name: triage-bot can't send
    call: { agent: triage-bot, account: gmail-work, action: email.send, recipients: [sam@company.com] }
    expect: { decision: deny, rule: triage-nothing-else }
  - name: other agents still ask to send
    call: { agent: writer, account: gmail-work, action: email.send, recipients: [sam@company.com] }
    expect: { decision: ask, rule: others-send }
```

### Big cleanups ask, small ones run

```yaml title="rules/owner.yaml"
rules:
  - name: big-cleanup
    match: { action: email.remove, items: { over: 25, per: run } }
    then: ask
  - name: hourly-cleanup
    match: { action: email.remove, items: { over: 100, per: hour } }
    then: ask
  - name: cleanup
    match: { action: email.remove }
    then: allow
```

```yaml title="cases.yaml"
cases:
  - name: archiving 10 messages
    call: { agent: a, account: gmail-work, action: email.remove, items: 10, run: r1 }
    counts: { run: 0, hour: 0 }
    expect: { decision: allow, rule: cleanup }
  - name: one batch of 30
    call: { agent: a, account: gmail-work, action: email.remove, items: 30, run: r1 }
    counts: { run: 0, hour: 0 }
    expect: { decision: ask, rule: big-cleanup }
  - name: no run id, but the hour is full
    call: { agent: a, account: gmail-work, action: email.remove, items: 10 }
    counts: { hour: 95 }
    expect: { decision: ask, rule: hourly-cleanup }
```

### Try a rule before it decides

`watch: true` logs what a new rule would do while the rules below it keep deciding. When Activity shows it does what you want, delete the `watch` line.

```yaml title="rules/owner.yaml"
rules:
  - name: new-auto-label
    watch: true
    match: { action: email.label }
    then: allow
  - name: everything-else
    match: {}
    then: ask
```

```yaml title="cases.yaml"
cases:
  - name: still asks, and the new rule is logged
    call: { agent: a, account: gmail-work, action: email.label, items: 4 }
    expect: { decision: ask, rule: everything-else, watched: [new-auto-label] }
```

## Load errors and warnings

`heel rules check` reports these with the file, line and column. While a file has an error, heel keeps deciding with that file's last good rules:

- **A broken owner file** (`rules/alice.yaml`) holds back only Alice's edit. Every other person's edits, and edits to `org-rules.yaml`, still apply. If the broken file is new, it counts as missing until it loads.
- **A broken `org-rules.yaml`** holds back every edit, since org rules bound everyone. heel keeps the whole last good set until it is fixed.

heel logs each problem, and names the owners whose rules were held back.

| Message | Fix |
| --- | --- |
| `unknown match key "..."` | A typo, or a key from another tool. Use one of the [match keys](#match-keys). |
| `org rules can only deny or ask (I-12)` | `allow` belongs in a person's own file. |
| `Invalid option: expected one of "allow"\|"deny"\|"ask"` | `then` takes only those three. |
| `... needs at least one operator` | An empty mapping, such as `repo: {}`. |
| `invalid RE2 pattern` | Fix the pattern; RE2 has no backreferences or lookaround. |
| `not a domain` / `not an email address` | A domain or address operand doesn't parse. |
| `expected a Slack channel id like C0123ABCD` (and similar) | Service fields take ids, not names. |
| `all_in_thread is a state check heel has only for action email.send` | Add `action: email.send` (and, if you name a provider, `gmail` or `outlook`). |
| `checks is a state check heel has only for action github.merge, github.workflow.merge` | Add the action. |
| `rule name "..." is already used in this file` | Names must be unique in a file. |

Warnings don't stop the rules from loading:

| Warning | Meaning |
| --- | --- |
| `a per: run limit doesn't apply to calls without a run id` | Add a `per: hour` rule for the same action below it. |
| `ignored: rules files end in .yaml` | Rename `rules/<user>.yml` to `.yaml`. |
| `action "..." doesn't exist, so this rule never matches` | A misspelled built-in action; the warning lists that service's actions. |
| `no account named "...", so this rule never matches until one is connected` | A misspelled alias, or an account not connected yet. Only checked while heel is running. |
| `note  heel isn't running, so account names weren't checked` | Start heel and run the check again to check account names. |

Shape errors (a wrong type, a misspelled `then`) are reported first; fix them and run `heel rules check` again to see the rest. Warnings are only shown once there are no errors.
