# CLI

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

The `heel` command sets heel up and runs it. Except for `heel run`, it works on the machine heel runs on, through a local admin socket. `heel help` lists every command; `heel <command> --help` shows one.

## Everyday commands

| Task | Command |
| --- | --- |
| Set up heel's home, key, config and starter rules | `heel init` |
| Start heel in the background | `heel start` (`--watch` to let calls through and only log) |
| Watch its log live | `heel logs -f` (`-n 200` for more history, `--json` for raw lines) |
| Stop or restart it | `heel stop`, `heel restart` |
| Run it in this terminal instead | `heel serve` (Ctrl-C stops it) |
| See what's going on | `heel status` |
| Watch it live | `heel tui` |
| Create your passkey | `heel user enroll owner` |
| Connect an account | `heel connect <service> --as <alias>` ([all of them](connect.md)) |
| Add an agent | `heel agent add <name>` |
| New token for an agent | `heel agent rotate <name>` |
| Stop calls at once | `heel pause --all`, `--agent <name>` or `--account <alias>` |
| Check your rules | `heel rules check` |
| Test your rules | `heel rules test cases.yaml` ([how](rules-reference.md#testing-rules)) |
| Run a CLI through heel (agent side) | `heel run -- gh pr list -R acme/web` ([how](heel-run.md)) |

Resuming after a pause needs your passkey, so it happens on the **Pause** page, not in the CLI.

## heel status

```text
heel 0.2.0 is running.
  Agents:    1
  Accounts:  2
  Paused:    nothing
  Waiting:   1 request
    my-agent wants to call DELETE /tickets/42 on tickets
      http://localhost:7301/approvals/apr_…
  Proposals: 1 waiting for you to add or reject
    my-agent proposes a new rule for owner's rules
      http://localhost:7301/proposals/rpr_…
```

Rules your agents propose are listed under **Requests** in `heel tui` too. Enter opens a proposal's page, where you add it with your passkey.

## heel tui

A live full-screen view, refreshed every two seconds.

| Key | Does |
| --- | --- |
| `1`–`4` | Requests, Activity, Agents, Accounts |
| `↑` `↓` | Select |
| `Enter` | Open the selected request in your browser (approving still needs your passkey there) |
| `p` | Pause the selected agent, after you confirm with `y` |
| `q` | Quit |

Set `NO_COLOR` for no colour.

## Lists

`heel agent list`, `heel account list`, `heel pause list` and `heel approvals list` print a table:

```text
NAME      OWNER  STATUS  TOKEN EXPIRES (UTC)  ADDED (UTC)
my-agent  owner  active  2027-02-17 20:45     2026-11-19 20:45
```

Add `--json` for every field, ids included, for scripts.

## Exit codes

| Exit | Means |
| --- | --- |
| 0 | Done. |
| 1 | heel refused it (for example, no account by that name), or a `heel rules test` case failed. The `heel:` line says which. |
| 64 | The command line is wrong. |
| 65 | The rules files, or a cases file, are invalid. |
| 69 | heel isn't running. |
| 78 | `heel.yaml`, or a file it names, is missing or invalid. |

`heel run` has its own: 75 needs approval, 77 denied, 69 paused, 70 heel couldn't run it. See [heel run](heel-run.md#troubleshooting).
