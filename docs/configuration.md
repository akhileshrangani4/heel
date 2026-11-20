# Configuration

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

heel keeps everything in one folder, `HEEL_HOME`: its config, master key, database, rules and admin socket.

Without `HEEL_HOME`, every `heel` command uses `/var/lib/heel` if it exists (a server install running as its own user, with the admin socket at `/run/heel/admin.sock`), and `~/.heel` otherwise, which is where `heel init` puts it. So on your own machine `heel serve` and a `heel connect` in another terminal find each other with nothing to set. Use another folder and you need `HEEL_HOME` in every shell.

## heel.yaml

heel reads `$HEEL_HOME/heel.yaml`, or the file named by `HEEL_CONFIG` or `--config`. Every key is optional, and relative paths resolve against `HEEL_HOME`. The ones you're most likely to set:

| Key | Default | What it's for |
| --- | --- | --- |
| `public_url` | `http://localhost:` + the `listen.human` port (`7301`) | The approval page's address. Its host becomes the passkey domain, so it must be `https://` anywhere but localhost. Links in notifications use it. Left unset, it follows `listen.human`, so moving the approval page to another port moves its links too. A localhost `public_url` on a different port from `listen.human` gets a `public_url_port` warning at startup, since links and passkey sign-in would go to the wrong port. |
| `listen.agent`, `listen.human` | `127.0.0.1:7300`, `127.0.0.1:7301` | Where each plane listens. Use `0.0.0.0:<port>` in a container. |
| `admin_socket` | `$HEEL_HOME/admin.sock` | The admin socket's path. |
| `vault.key_file` | `master.key` | The master key file. `HEEL_MASTER_KEY` takes precedence. |
| `database` | `heel.db` | The SQLite database. |
| `providers.google`, `providers.microsoft` | none | Your OAuth clients, needed to sign in Gmail, Calendar and Outlook accounts. Each takes a `client_id`. The secret comes from `HEEL_GOOGLE_CLIENT_SECRET` (`HEEL_MICROSOFT_CLIENT_SECRET`) or the `client_secret_file`, `google-client-secret` (`microsoft-client-secret`) by default. Their redirect URIs are `public_url` + `/oauth/google/callback` and `/oauth/microsoft/callback`. Step by step for Google: [Set up Google sign-in for heel](google-sign-in.md). |
| `agent_public_url` | none | Where cloud agents (Claude, ChatGPT and Grok connectors) reach the agent plane. Setting it turns on OAuth for them. |
| `oidc` | none | Sign-in through your identity provider, for teams. |
| `notify` | web push | Where approval requests are sent: web push, email, Slack. |
| `adapters.approval` | none | Approval adapters that add hints to the approval page; `jev` sends pending calls to TypeSafe. See [Hints](approvals.md#hints). |
| `sandboxes.per_agent`, `sandboxes.total` | `4`; one per GiB of memory less one, from 2 to 16 | How many code-mode scripts and `heel run` commands may run at once, for one agent and for all of them. Each runs in its own sandbox, whose processes may each use up to 1 GiB, so without a limit one agent could take the host's memory. Over either limit, heel answers `busy` at once and runs nothing; the agent sends it again later. A running local MCP server counts towards `total` too, without ever being refused, so with two local servers running, two fewer scripts or commands fit. |
| `log.level` | `info` | `debug`, `info`, `warn` or `error`. |

[`examples/heel.yaml`](../examples/heel.yaml) is a commented starting point.

## Rules files

Rules live in `$HEEL_HOME/rules/<user>.yaml`, one file per user. A single-user install has `rules/owner.yaml`. Organization rules go in `$HEEL_HOME/org-rules.yaml`. heel reloads them when they change.

- `heel rules check` validates them.
- `heel rules test` runs cases against them: see [Testing rules](rules-reference.md#testing-rules).
- [`examples/rules/owner.yaml`](../examples/rules/owner.yaml) holds the examples from [rules.md](rules.md).
- With no rules files, every call is denied. heel logs a `no_rules` warning at startup when that's the case (see `heel logs`).

## What heel prints when it starts

`heel start` runs heel in the background and prints where to go once it answers:

```text
heel is running in the background (pid 4821).
  Approve requests:   open http://localhost:7301
  Agents connect to:  http://127.0.0.1:7300/mcp
  Live logs:          heel logs -f
  Stop:               heel stop
```

`heel serve` runs it in the terminal instead: its JSON log lines, then the same addresses and "Stop with Ctrl-C".

If the approval page or the agent port couldn't start, its line says `off` and why (for example a `public_url` that isn't `https://`, or no master key).
