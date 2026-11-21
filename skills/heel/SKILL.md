---
name: heel
description: Reach a person's accounts (GitHub, Gmail, Google Calendar, Outlook, Slack, Linear, Notion, Stripe, MCP servers, HTTP APIs, CLIs) through heel, a self-hosted permission gateway that holds the credentials and asks the person before risky calls. Use when the user asks to set up heel, to put their services or API keys behind heel, or to give an agent safe access to their accounts; and whenever you work through heel's MCP server, HTTP proxy or `heel run` (a call needs approval, was denied or is paused, or you need an account that isn't connected).
---

# heel

heel sits between you and your user's accounts. It holds the keys; you hold only a heel token. Every call you make is decided by your user's rules: it runs, it waits for your user to approve with a passkey, or it never runs.

## Set heel up

If the user asks you to set up heel, fetch https://useheel.dev/setup.md and follow it. It installs heel, has the user make a passkey, adds you as an agent, then asks heel to connect their services and proposes rules for them. Check each step first: after a restart, some are already done.

## Rules when working through heel

- **Never handle a credential.** Don't read, print or copy a key or token's value, and never ask the user to paste one to you. If you need an account, call `heel_request_connection`; the user connects it on heel's page.
- **Never route around heel.** Don't fall back to a raw key, a CLI login or another MCP server for an account heel holds.
- **Give a reason.** Pass `heel_reason` (one sentence: why this call) on calls that may need approval. It shows on the approval page. Over HTTP use the `Heel-Reason` header; with `heel run`, `--reason`.
- **Change rules only by proposing.** Use `heel_propose_rules`, with a short why on each rule. You can't edit heel's rules or approve anything; only the user's passkey can.

## What a call's outcome means

| Outcome | Over HTTP / `heel run` | Do this |
| --- | --- | --- |
| Allowed | 2xx / exit 0 | Carry on. |
| Needs approval | 202 / exit 75 | Tell the user what's waiting. Keep working on other things. Check with `heel_status`, then send the **identical** call again once it's approved. |
| Denied | 403 / exit 77 | Nothing ran. Don't retry it or try a workaround. Take another route the rules allow, or tell the user. |
| Paused | 423 / exit 69 | Nothing ran. Stop and wait for the user. |

In code mode (`run_code`), an ask stops the whole script and returns the approval id with what already ran. After approval, send the rest as a new script.

## Find what you have

`heel_accounts` lists the accounts you can use and your requests still waiting for the user. heel's own `setup` MCP prompt walks through putting more of the user's services behind heel.

Docs: https://useheel.dev/docs (start at https://useheel.dev/llms.txt).
