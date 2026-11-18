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
  <a href="https://www.npmjs.com/package/useheel"><img alt="npm version" src="https://img.shields.io/npm/v/useheel?color=F2A33A"></a>
</p>

heel sits between an agent and everything it touches (MCP servers, HTTP APIs and CLIs). It holds the credentials and checks every call against rules on the call's actual arguments: who an email goes to, which account it comes from, which repo, how many messages this run has deleted. It also hides what an agent shouldn't read. Calls that need a person go to the owner's phone, outside the agent's session. One switch pauses any agent.

[![heel in 26 seconds](assets/heel.gif)](assets/heel.mp4)

## Install

```sh
npm install -g useheel                      # Node 26.13 or later; installs the heel command
docker pull ghcr.io/akhileshrangani4/heel    # or run the OCI image
```

## Quick start

```sh
export HEEL_HOME=~/.heel                    # heel's config, keys and database
heel vault init                             # creates the master key: back it up
heel serve                                  # agents on :7300, approvals on :7301
```

In a second terminal, with the same `HEEL_HOME`:

```sh
heel user enroll owner                      # open the link and register a passkey
gh auth token | heel connect github --as github --credential-stdin
heel connect gmail --as gmail-work          # then sign in from the Connections page
heel agent add my-agent                     # prints the agent's token (once) and MCP URL
```

- **Approving:** on `localhost`, you approve on this computer, with a passkey (Touch ID, say). To approve from your phone, give heel an HTTPS address first: see [Approve from your phone](#approve-from-your-phone).
- **Every account gets an alias** (`gmail-work`, `github`), and the agent only sees the alias. Any MCP server, any HTTP API with an OpenAPI file, and any CLI can go behind heel. `heel --help` lists the forms.
- **The agent's heel token is its only credential.**

## Connect your agent

Point the agent at heel instead of at the services, and remove its own connections to those accounts so it can't go around heel.

**Claude Code:**

```sh
claude mcp add --transport http heel "http://127.0.0.1:7300/mcp?tools=direct" \
  --header "Authorization: Bearer heel_…"
```

**Cursor, or any client with an `mcp.json`:**

```json
{
  "mcpServers": {
    "heel": {
      "url": "http://127.0.0.1:7300/mcp?tools=direct",
      "headers": { "Authorization": "Bearer heel_…" }
    }
  }
}
```

The agent gets one MCP server with every connected account's tools, named by alias (`gmail-work__send`, `github__merge`).
- **One account at a time:** use `/mcp/<alias>`.
- **On Linux,** `/mcp` without `?tools=direct` is code mode: one `run_code` tool, where the agent writes a short script against typed modules, in a sandbox with no network or credentials.
- **CLIs** run as `heel run -- gh pr merge 123`.
- **HTTP APIs** are called at `/http/<alias>/<path>`.

## Write rules

Rules live in `$HEEL_HOME/rules/owner.yaml`. The first rule that matches decides, and a call no rule matches is denied.

```yaml
rules:
  # reads: anything a built-in definition marks as read-only
  - match: { kind: read }
    then: allow

  # the personal account never emails clients
  - match:
      action: email.send
      account: gmail-personal
      recipients: { any_domain_in: [clientco.com] }
    then: deny

  # coworkers already in the thread: no need to ask
  - match:
      action: email.send
      recipients: { all_in_thread: true, all_domain_in: [company.com], max: 5 }
    then: allow

  # every other send, including reply-all to a customer
  - match: { action: email.send }
    then: ask

  # removals count messages, not calls; the hourly limit is one the agent can't reset
  - match: { action: email.remove, items: { over: 20, per: run } }
    then: ask
  - match: { action: email.remove, items: { over: 100, per: hour } }
    then: ask

  - match: { action: github.merge, repo: { one_of: [acme/web] }, checks: passing }
    then: allow
```

- **Actions** group tools across services: `email.send` covers send, reply, reply-all and forward on Gmail and Outlook.
- **Plain checks** work on any argument: `equals`, `one_of`, `matches`, `any_domain_in`, `all_domain_in`, `max`.
- **State checks** look something up first. `all_in_thread` passes when every recipient was on a message you sent in that thread. `checks: passing` reads the pull request's CI and pins the merge to that commit.
- **Counts** add up items (messages, files) per run or per hour, not calls, so one 1,000-message batch counts as 1,000.
- **Org rules** in `org-rules.yaml` are checked first and can only deny or ask.
- **Checking a change:** `heel rules check` validates the file, and `heel rules test` runs cases against it. heel reloads the file when it changes.
- **Trying rules first:** run `heel serve --watch` to let calls through while logging what each rule would have done.

## What your agent sees

Every call gets one of four answers, right away:

| Outcome | What the agent gets |
| --- | --- |
| **Allowed** | The normal result. Hidden messages are dropped, with "heel hid 2 items from this result." |
| **Denied** | "heel denied send on gmail-personal (rule)." Nothing ran. |
| **Needs approval** | "Approval needed: reply_all on gmail-work. Check with heel_status, then re-send the same call once it's approved." Nothing ran yet. |
| **Paused** | "send on gmail-work is paused. Nothing ran." |

- **Over HTTP,** these are 403, 202 and 423.
- **For `heel run`,** they're exit codes 77, 75 and 69.

The agent can't approve anything itself.

## When it needs you

1. **You get a notification** on your phone (once heel has an HTTPS address: see below), or by email or Slack. It links to heel, and replying to it approves nothing. Waiting requests are also listed on the approval page.
2. **The request page shows exactly what will run:** the account, the rule that asked, the counts, and the full arguments (every recipient and the whole body). With [hints](docs/approvals.md#hints) turned on, it also shows advice from Jev, TypeSafe's decision model, like "asks someone for money". The advice can't approve or deny anything.
3. **You decide with your passkey:**
   - **Approve once:** the call runs the next time the agent sends it.
   - **Approve as standing:** also allow this exact call, or everything the rule asks about, for up to 90 days.
   - **Deny.**
4. **The agent re-sends,** and the call runs once, after the rules check it again. A request nobody answers expires after 24 hours.

To stop an agent, tap **Pause** on the approval page or run `heel pause --agent my-agent`. You can pause one agent, one account or everything. Every call in scope stops, even one already approved, and resuming needs your passkey.

## Approve from your phone

Your phone has to reach heel's approval page over HTTPS, and heel has to know that address before you enroll, because a passkey is tied to the address it was made on. Only the approval page (port 7301) needs to be reachable. Keep the agent port (7300) private.

1. **Give the approval page an HTTPS address.** Any HTTPS front works:
   - **Tailscale,** private to your own devices: `tailscale serve --bg 7301` gives it `https://<machine>.<tailnet>.ts.net`.
   - **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:7301` gives a public `trycloudflare.com` address to try it out (a new one each run). A named tunnel on your own domain keeps it fixed.
   - **A server:** run the OCI image behind Caddy or nginx with TLS.
2. **Tell heel the address, then restart it.** In `$HEEL_HOME/heel.yaml`:
   ```yaml
   public_url: https://heel.example.com
   ```
3. **Enroll from your phone.** `heel user enroll owner` now prints a link at that address. Open it on your phone and register a passkey.
4. **Turn on notifications.** Add the approval page to your home screen (an iPhone only shows web notifications for a page added this way), then allow notifications. Email and Slack can notify too: see `notify` in [Running heel](docs/running.md#configuration).

If you change `public_url` later, enroll again.

## Hide what it reads

```yaml
hide:
  - email: { from: { any_of: [sarah@example.com] } }       # mail from family
  - email: { looks_like: [password_reset, login_code] }    # resets and codes
```

Hidden messages drop out of searches, lists and threads, and fetching, forwarding, replying to or deleting one is denied. `looks_like` uses patterns and a classifier inside heel. When it's unsure, the message is hidden.

## What heel won't do

- **A model never decides a live call.** Rules, grants and people do. Whoever shapes a call (say, an injected instruction in an email) could shape a model judging it too.
- **Checking calls doesn't stop every prompt injection.** When each call in an attack is allowed, nothing gets blocked. heel narrows where data can go and what an agent can destroy.
- **heel must hold every credential.** A token you also gave the agent directly goes around it.
- **Down means denied.** If heel is down, every call fails until it's back.

## Docs

The docs are at **[useheel.dev](https://useheel.dev)**, and in [`docs/`](docs).

| | |
| --- | --- |
| [Using heel](docs/using-heel.md) | The full walkthrough: cloud connectors, code mode, grants, Activity and modes |
| [Rules and hiding](docs/rules.md) | Every check, counts, state checks, `hide` |
| [Approvals, grants and pause](docs/approvals.md) | Grants, standing approvals, hints |
| [Running heel](docs/running.md) | npm, Docker, configuration, upgrading, the sandbox |
| [How it works](docs/how-it-works.md) | Surfaces, the trust boundary, teams, built-in definitions |
| [Why heel](docs/why.md) | The problem, intent-based access control, and where heel comes from |
| [Incidents](docs/incidents.md) | Four real incidents, replayed against heel |
| [How it compares](docs/comparison.md) | Other gateways and approval tools |
| [Releasing](docs/releasing.md) | How versions are cut and published |

## License

Apache 2.0. See [LICENSE](LICENSE).
