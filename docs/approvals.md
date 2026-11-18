# Approvals, grants and pause

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

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

## Hints

An approval adapter can add hints to a pending request, to help the approver notice what matters, like "asks someone for money" or "unlike this agent's recent calls". It can't approve or deny anything. Hints run after the request is already pending, they're stored next to it, and they only appear on the approval page, under the call, labeled with the adapter that gave them. The approver still reads the full arguments and decides.

The built-in approval adapter is **Jev**, [TypeSafe](https://typesafe.ai)'s fast decision model. For each pending request, heel asks Jev a few yes-or-no questions. Each question and its wording is in [`src/core/hints.ts`](../src/core/hints.ts):

| Question | Hint when Jev is sure (above 0.7) |
| --- | --- |
| Do the arguments contain a password, API key, token or private key? | **check:** Contains what looks like a password, key or token. |
| Do they contain a card, government ID or bank account number? | **check:** Contains a card, ID or bank account number. |
| Do they ask someone for money, a payment or account access? | **check:** Asks someone for money, a payment or account access. |
| Is this the same kind of action as the agent's recent calls? | **note:** Unlike this agent's recent calls (below 0.3). |

Code turns the answers into hints:
- **Sure of a risk:** a warning.
- **Unsure of a risk (between 0.3 and 0.7):** nothing, since no hint is better than a guess.
- **Every risk clearly absent and the call like recent work:** "Looks routine for this agent".
- **The agent's first call:** heel says so itself, without asking Jev.
- **Jev fails, times out or answers something unexpected:** the page says hints are unavailable. It never shows a guess.
- **Jev hasn't answered yet** (it takes a second or two): the page says hints are on the way.

To turn hints on, add an approval adapter to `heel.yaml`:

```yaml
adapters:
  approval:
    - jev: { model: jev-latest }   # key: HEEL_TYPESAFE_API_KEY, or $HEEL_HOME/typesafe-api-key
```

**What leaves heel:** only for a call that's waiting for a person, heel sends TypeSafe one request with:
- the agent's name, and the account, provider, tool and action of the call;
- the call's arguments, as the agent sent them, such as an email's recipients and body. That includes anything sensitive the agent put there, which is what the first two questions look for. Arguments past 24,000 characters are cut, and the page then says only the first part was checked;
- the account, tool, action and outcome (allowed, denied, asked) of the agent's last 15 calls, but not their arguments.

heel's own credentials and the connected accounts' credentials are never sent. A request that's already decided or expired when hints run isn't sent at all.
