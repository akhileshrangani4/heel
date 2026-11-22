---
name: heel
description: Reach a person's accounts (GitHub, Gmail, Google Calendar, Outlook, Slack, Linear, Notion, Stripe, MCP servers, HTTP APIs, CLIs) through heel, a self-hosted permission gateway that holds the credentials and asks the person before risky calls. Use when the user asks to set up heel, to put their services or API keys behind heel, or to give an agent safe access to their accounts; and whenever you work through heel's MCP server, HTTP proxy or `heel run` (a call needs approval, was denied or is paused, or you need an account that isn't connected).
---

# heel

heel sits between you and your user's accounts. It holds the keys; you hold only a heel token. Every call you make is decided by your user's rules: it runs, it waits for your user to approve with a passkey, or it never runs.

## Set heel up

If the user asks you to set up heel, run `curl -fsSL https://useheel.dev/setup.md` and follow what it says. Read it whole: a web-fetch tool that summarizes pages can drop or flip a step. It installs heel, has the user make a passkey, adds you as an agent, then asks heel to connect their services and proposes rules for them. Check each step first: after a restart, some are already done.

If you can't fetch it, the outline is: Node 26.13 or later (if older, tell the user how to upgrade; don't install it yourself), `npm install -g useheel`, then ask the user whether they'll approve from this computer or from their phone over Tailscale and run `heel init --yes --approve-from this-computer` (or `tailscale`), `heel start`, then `heel user enroll owner` and give the user the link to make their passkey and turn on notifications, then `heel agent add <name> --client claude-code`, which adds heel to Claude Code itself (for Codex, `--client codex` and run the commands it prints).

## Rules when working through heel

- **Never handle a credential.** Don't read, print or copy a key or token's value, and never ask the user to paste one to you. If the user pastes one anyway, don't use it, and tell them to revoke it: it now sits in the chat. To get an account, call `heel_request_connection` with `service`, `alias` (how rules will name it, like `notion-work`) and `why`; the user approves it and signs in or pastes the key on heel's page.
- **Never route around heel.** Don't fall back to a raw key, a CLI login or another MCP server for an account heel holds.
- **Give a reason.** On account calls that may need approval, add the optional `heel_reason` argument (one sentence: why this call). It shows on the approval page. It's an extra, never a stand-in for a tool's own arguments. Over HTTP use the `Heel-Reason` header; with `heel run`, `--reason`.
- **Change rules only by proposing.** Use `heel_propose_rules`, with a short why on each rule. When the same kind of call keeps asking, check `heel_history` first: it shows how the user decided your past requests and any rule heel suggests from them; ask for one with `heel_propose_rules({ suggestion: "<id>" })`. When `heel run` refuses a directory (`workdir_not_allowed`), propose it the same way, as `workdirs: [{ path, why }]`. You can't edit heel's rules or approve anything; only the user's passkey can.

## What a call's outcome means

| Outcome | Over HTTP / `heel run` | Do this |
| --- | --- | --- |
| Allowed | 2xx / exit 0 | Carry on. |
| Needs approval | 202 / exit 75 | Over MCP the call waits for the user's decision and answers with the result, so just tell the user what's waiting and where to approve it. If it still comes back pending (no one decided in time), or over HTTP and `heel run`, check with `heel_status` and send the **identical** call again once it's approved. |
| Denied | 403 / exit 77 | Tell the user nothing ran. Don't retry it or try a workaround. Take another route the rules allow, or say how they can allow it (approve or change a rule, or a rule you propose). |
| Paused | 423 / exit 69 | Tell the user nothing ran. Stop and wait for them to resume it in heel. Don't move the call to another account to get past the pause, even if they suggest it: the pause is the user's own stop. |
| Key rejected (the service turned down heel's key for that account) | 502 with `upstreamStatus` 401 and a `message` saying so | Tell the user nothing ran and that the account's key needs replacing on heel's Connections page. Don't retry, and don't reach for a raw key. |

In code mode (`run_code`), reads of heel's built-in accounts have `_async` twins (`github.get_issue_async(...)`): `await asyncio.gather(...)` over them runs the reads at once. A twin that needs approval raises `PermissionError`; make the plain call to ask. `run_code({ code, background: true })` runs a long script in the background (up to 10 minutes of compute, one at a time) and answers with a script id; follow it with `heel_status({ script_id })`. If a call in it needs approval, heel carries it on by itself once approved; don't resume it. A script that hits an ask waits at that call for the decision and carries on by itself. Only if no one decides in time does it come back parked, with the approval id and a `resume` id and what already ran. Once `heel_status` says it's decided, call `run_code` with `resume` (no code) and the script carries on from there; a denial raises `PermissionError` at that call. If there's no `resume` id, the script ended there: send the rest as a new script.

## Find what you have

`heel_accounts` lists the accounts you can use and your requests still waiting for the user. heel's own `setup` MCP prompt walks through putting more of the user's services behind heel.

Docs: https://useheel.dev/docs (start at https://useheel.dev/llms.txt).
