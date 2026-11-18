# Rules and hiding

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

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

## Hiding what the agent reads

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
| Known gaps | A hidden message quoted inside a reply is only hidden if the reply matches too. The placeholder's count tells the agent that something was hidden, and how much. |

Approvals for `ask` rules are in [approvals.md](approvals.md). [`examples/rules/owner.yaml`](../examples/rules/owner.yaml) holds this page's example rules and hide entries, unchanged.
