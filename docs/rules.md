# Rules and hiding

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

Rules decide what your agent's calls do: run, ask you, or never run. They're a YAML file you can read, review and test, at `~/.heel/rules/owner.yaml`. `heel init` starts you with two: reads run, and everything else asks you.

This page is the tour. The [rules reference](rules-reference.md) has every key, operator and action, with recipes to copy.

## How heel decides

The first rule that matches decides, and a call no rule matches is denied. Rules are checked in this order:

1. **Organization rules.** These can only deny or ask, so nothing below can loosen them.
2. **Your rules,** top to bottom.
3. **Standing approvals and intent grants,** only when your rules end in an `ask` (or, for an intent grant, when nothing matched). They can turn that into `allow`, but never get past a `deny` or an org `ask`.

## A rules file

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

## What a rule can check

| Part of a rule | What it does |
| --- | --- |
| **Actions** | Built-in definitions map tools from different servers to one action. `email.send` covers send, reply, reply-all and forward on Gmail and Outlook, with `recipients` meaning to, cc and bcc together. For a server heel doesn't know, rules use its own tool and argument names. |
| **Plain checks** | Work on anything: `equals`, `one_of`, `matches`, `any_domain_in`, `all_domain_in`, `max`. |
| **State checks** | Look something up first, with heel's own read access, and only exist for services heel knows. `all_in_thread`: every recipient was on a message you sent in that thread. `checks: passing`: reads the pull request's status and passes the checked commit to GitHub's merge, so the merge fails if new commits landed. |
| **Counts** | Count `items` (messages, files, records), not calls, so one `batch_delete` of 1,000 messages counts as 1,000, including the call being checked. `per: run` uses the run id the agent sends, so pair it with a `per: hour` limit, which the agent can't reset. |

**Not sure where to start?** Run in [Watch mode](#try-rules-before-enforcing-them) for a few days, then turn what Activity shows into rules. Or let your agent [propose them](#your-agent-can-propose-rules).

## Try rules before enforcing them

**Watch mode** lets calls through that your rules would deny or send for approval, and marks each one in **Activity** as "would deny" or "would ask". Use it to try rules on real traffic, then switch back.

- **Everyone:** `heel start --watch` (or `heel restart --watch` if heel is running).
- **One person, or the org default:** the **Modes** page (admins). Switching to Watch needs a passkey; switching back to Enforce doesn't.
- **One rule:** add `watch: true` to it.

Pause, org rules, hidden mail and calls heel can't check safely hold in every mode. **Activity** also suggests rules from what Watch mode saw, as text to paste.

## Editing rules

Edit the file and heel reloads it on its own. Before you rely on a change, run `heel rules check` (it reports every problem and names that match nothing) and `heel rules test` with your cases ([how](rules-reference.md#testing-rules)). Editing a rule ends the standing approvals made from it, so a widened rule asks again.

**Describe a rule in words** with `heel rules draft "merges to main ask"`: a model you configure drafts the YAML and a diff for you to read and save. It never sees a live call, and never saves anything itself.

## Your agent can propose rules

When a call your agent needs keeps asking, or is denied, it can propose rules instead of asking you to edit the file. It can also propose [hide entries](#hiding-what-the-agent-reads), for mail you want kept from agents, and [workdirs](heel-run.md#3-give-the-agent-a-workdir), the directories its own `heel run` may work in. Every MCP endpoint lists heel's own `heel_propose_rules` tool:

```json
{
  "reason": "Reviewing the open PRs you asked about",
  "rules": [
    {
      "rule": { "name": "read-github", "match": { "provider": "github", "kind": "read" }, "then": "allow" },
      "why": "so I can read PRs without asking you each time"
    }
  ],
  "hide": [
    {
      "entry": { "email": { "looks_like": ["password_reset", "login_code"] } },
      "why": "so no agent reads your login codes"
    }
  ]
}
```

Any list can be left out, but a proposal needs at least one rule, hide entry or workdir.

![A proposed rule: vendor-mail, with the agent's why and where it goes](images/proposal.png)

- **Nothing changes until you add them.** heel tells you a proposal is waiting the same way it tells you about a request (push, email or Slack, whichever you set up), and it shows in `heel status` and `heel tui`. The notification says only which agent and how many rules or hide entries; read them on the page. The proposal shows up under **Rule changes** on the Approvals page. Its page says what each rule does in plain words ("claude-code may open a GitHub issue on github without asking you."), written by heel from the rule itself, never from the agent's why. Under it come the agent's why, the rule as YAML, which of your rules they come before, and the whole file after the change. A condition heel has no words for is spelled out as it is ("when args.force is true"), never left out. **Add these rules** asks for your passkey; **Reject** doesn't.
- **Rules go first in your file,** above your own rules, each with a `# Proposed by <agent>: <why>` comment. The first rule that matches decides, so a proposed `allow` decides a call that one of your rules would have asked about. The page says so.
- **Hide entries go at the end of your `hide:` list,** with the same comment. A hide entry only takes email away from agents, never gives them anything, and the page says that too.
- **heel writes the file, never the agent.** The agent sends rule objects, not YAML, and only ever for its own owner's file. It never sees your file: a proposal is checked on its own, and only its own problems go back to the agent. heel can't add a `watch: true` rule or org rules this way.
- **The passkey signs the exact file.** If the file changes between opening the page and touching your passkey, heel writes nothing and asks you to reload. It won't add to a file that has an error; fix that first.
- **One proposal per agent waits at a time.** A newer one replaces the older (heel's own suggestions don't replace an agent's proposal, or each other), and a proposal expires after 7 days. A paused agent can't propose.
- **Proposals are the history.** Each one keeps which agent proposed it, who added or rejected it, and when.

## heel suggests rules from what you decide

When you keep approving the same kind of request, heel suggests a rule that would stop the asking. After 5 approvals on at least 2 different days in the last 30, a card appears under **Suggested rules** at the top of the Approvals page and on Activity: what the rule would do, in plain words, and what it rests on ("You approved 6 times on 3 days since Nov 12, all to work.com"). Denials work the same way and suggest a deny rule.

- **Nothing changes until you add it.** **Review and add** opens the suggestion as a rule change, like an agent's proposal: you read the file after the change and add it with your passkey. **Don't suggest this again** hides it for good.
- **It's never wider than what you approved.** The rule names the agent the requests came from, the account and the action, and what they had in common that a rule can check: the repo, the calendar, or the recipients' domains. Requests with none of those (a refund of any amount, say) aren't suggested as an allow at all. A rule that would also cover a request you denied in the last 30 days isn't suggested.
- **It doesn't skip your guards.** Proposed rules go first in your file, so heel won't suggest one where the rule that asked has a count or a state check (`items`, `checks: passing`), or where that rule has since changed.
- **Only what you decided counts.** An agent asking over and over earns nothing until you approve, and decisions in one sitting count as one day. Requests org rules asked about aren't counted.
- **In the file,** the rule's comment says `# Suggested by heel for <agent>: ...`, not that the agent proposed it.

Change the numbers, or turn suggestions off, in `heel.yaml` ([`learning`](configuration.md)).

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
| `looks_like` | The one place a model judges a live call, and it can only hide: it never lets a call through. Patterns catch common reset links and codes, and a classifier inside heel catches the rest. When it's unsure or can't run, the message is hidden. |
| Where it works | Only where heel knows the response shape: built-in definitions and OpenAPI-described APIs. For an unknown MCP server or CLI, heel can allow or deny the call but can't remove items. |
| Known gaps | A hidden message quoted inside a reply is only hidden if the reply matches too. The placeholder's count tells the agent that something was hidden, and how much. |

Every match key, operator and built-in action is in the [rules reference](rules-reference.md). Approvals for `ask` rules are in [approvals.md](approvals.md). [`examples/rules/owner.yaml`](../examples/rules/owner.yaml) holds this page's example rules and hide entries, unchanged.
