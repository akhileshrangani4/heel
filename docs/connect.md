# Connect accounts

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

Connect each account once, on the machine heel runs on. heel keeps the credential encrypted, and your agent only ever sees the account's alias (`--as github`). Run these with `heel serve` running.

**Or from the web app.** On **Connections**, **Add connection** lets you pick the service, then takes a name and the key (or, for Gmail, Calendar, Outlook and MCP servers, you sign in right after), and asks for your passkey. The key goes only to heel's vault, checked with the service first: one the service turns down isn't stored. Each account's **⋯** menu replaces its key (passkey) or removes it.

![The Connections page: gmail-work and github, both ready](images/wide-connections.png)

## Built-in services

heel knows these services' tools, so rules can name what a call does (`action: github.merge`, `recipients: ...`) and approvals show it in plain words.

| Service | Connect it with | Credential |
| --- | --- | --- |
| **GitHub** | `gh auth token \| heel connect github --as github --credential-stdin` | A token: `gh auth token`, or a fine-grained token |
| **Slack** | `heel connect slack --as slack --credential-stdin` | A bot token (`xoxb-…`) from your Slack app |
| **Linear** | `heel connect linear --as linear --credential-stdin` | A personal API key (`lin_api_…`) |
| **Notion** | `heel connect notion --as notion --credential-stdin` | An internal integration secret |
| **Stripe** | `heel connect stripe --as stripe --credential-stdin` | A restricted key (`rk_…`) with only what the agent needs |
| **Gmail** | `heel connect gmail --as gmail-work` | Sign in with Google from the Connections page, no setup |
| **Google Calendar** | `heel connect google-calendar --as calendar` | Sign in with Google from the Connections page, no setup |
| **Outlook** (mail and calendar) | `heel connect outlook --as outlook` | Sign in from the Connections page |

`--credential-stdin` reads the credential from standard input, so it never lands in your shell history: pipe it in, or paste it and press Ctrl-D.

heel checks a GitHub, Slack, Linear, Notion or Stripe key before it stores it, with one read the service's own API answers for any key (GitHub `/user`, Slack `auth.test`, Linear `viewer`, Notion `/v1/users/me`, Stripe `/v1/balance`). A key the service turns down (wrong, expired or revoked) isn't connected, and heel says so. If heel can't settle it (no network, an outage, a restricted key that can't make that read), it connects the key and tells you it couldn't check. The same happens when you paste a key on an agent's connection request.

**Gmail and Google Calendar** sign in with heel's own Google sign-in: after `heel connect`, open **Connections** and select **Sign in** ([details](google-sign-in.md), including heel on another machine). **Outlook** signs in through your own Microsoft app, set in `heel.yaml` as `providers.microsoft`.

## Any MCP server

**A remote server** (a URL):

```sh
heel connect mcp --as notes --url https://mcp.example.com/mcp --oauth
```

With `--oauth`, sign in from the Connections page. For a server that takes a token instead, use `--credential-stdin`.

**A local server** (a command heel starts) runs in heel's sandbox, on Linux. Name the hosts it talks to, and it gets a placeholder instead of the credential:

```sh
heel connect mcp --as notes --command /usr/bin/node --arg /opt/notes/server.js \
  --egress api.notes.example --credential-env NOTES_TOKEN \
  --credential-host api.notes.example --credential-stdin
```

heel adds the real credential to its requests to `--credential-host` on the way out.

For a server heel doesn't know, rules match on the server's own tool and argument names.

## Any HTTP API

Give heel the API's base URL and its OpenAPI file:

```sh
heel connect http --as tickets --base-url https://api.tickets.example \
  --openapi ./tickets-openapi.yaml --auth bearer --credential-stdin
```

Your agent calls it at `http://127.0.0.1:7300/http/tickets/<path>` with its heel token. `--auth` is `bearer`, `basic`, `header:<Name>` or `query:<name>`.

## Any CLI

`gh`, `kubectl` and other CLIs run through `heel run`, in heel's sandbox, without the agent holding the credential. See [Run CLIs with heel run](heel-run.md).

## Your agent can ask for a connection

When your agent needs an account you haven't connected, it can ask for one with heel's `heel_request_connection` tool instead of asking you to run `heel connect`:

```json
{ "service": "gmail", "alias": "gmail-work", "why": "so I can triage your work mail" }
```

It can ask for **Gmail**, **Google Calendar** or **Outlook** (you sign in), **GitHub**, **Slack**, **Linear**, **Notion** or **Stripe** (you paste a key on heel's page), or a **remote MCP server** on a public host by its `https://` URL (`"service": "mcp", "url": "https://…"`). heel reaches a server an agent asked for, every redirect it answers with, and every sign-in address it names, only on public https hosts, so an agent can't use heel to reach your network. In every case you finish it on heel's page, so the agent never handles a password, token or key. Anything that runs a program or takes an OpenAPI file, you still connect yourself.

- **Nothing happens until you approve.** heel tells you a request is waiting the same way it tells you about a call, and it shows under **Connection requests** on the Approvals page and in `heel status`. No account exists, and an MCP server's URL isn't contacted, until you connect it.
- **The page says what your rules would let the agent do.** heel runs your rules on a read and on anything else for the new account. A rule that names no account, like the starter rules' `kind: read`, covers it the moment it's connected. Change your rules first if that's more than you want.
- **Connect it** asks for your passkey. For a service that signs in, heel then offers **Sign in to Gmail** (or the server's own sign-in). For one that uses a key, paste it in the field above the button first: it goes to heel's vault with your passkey's answer, and nowhere else (not the request, not a log, not the agent). An MCP server that doesn't sign in is connected at once.
- **The agent learns nothing about your accounts.** It gets the same answer whether or not you already have an account by that name. If the name is taken, the page says so to you, and you reject the request.
- **Asking again for the same name replaces the earlier request.** At most 5 wait per agent, each expires after 7 days, and a paused agent can't ask.

## Change or remove an account

- **New key:** after you rotate a key with the provider, give heel the new one. Every setting stays.
  ```sh
  printf %s "$NEW_TOKEN" | heel account set github --credential-stdin
  ```
  Accounts that sign in (Gmail, Calendar, Outlook, MCP with OAuth) sign in again from the Connections page.
- **Remove:** `heel account remove github` deletes the account and its stored credential. Its waiting requests expire, and approvals and grants that name it are revoked. Activity keeps its history. Revoke the credential with the provider too.
- **List:** `heel account list`.

Remove the agent's own access to each account you connect (its GitHub MCP server, its `gh` login, its API keys), or it can go around heel.
