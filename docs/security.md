# Security

What heel protects (your credentials, and every call an agent makes), what it assumes, and how its sandbox and service definitions work.

```
            MCP ─┐                 ┌─▶ any MCP server
agent ──── HTTP ─┼──▶ heel ───────┼─▶ any HTTP API
            CLI ─┘     │           └─▶ any CLI (gh, gcloud, stripe, kubectl, ...)
                       ├─ allow
                       ├─ deny
                       └─ ask: a person approves with a passkey
```

heel is one process with two planes: the agent plane (port 7300), where agents call MCP, the HTTP proxy and `heel run`, and the human plane (port 7301), where people sign in and approve. Operators use the `heel` CLI over a local admin socket.

## Trust boundary

| heel assumes | Because |
| --- | --- |
| **heel holds every credential** | Each agent gets only its own heel token. That's how heel tells agents apart, pauses one and logs what each did. |
| **The agent can't reach heel's host** | Run heel as a separate server, container or user. An agent that can read heel's files can go around it. |
| **No other path to the same account** | A token you also gave the agent directly, or a client's own Gmail connector left connected, goes around heel. |
| **Down means denied** | If heel is down, every call fails until it's back. |

What the agent never gets: a credential, the reason a rule matched, or a way to approve anything. Only a person's passkey decides an approval, a rule change or a new connection.

## Credentials stay outside the sandbox

`heel run` and local MCP servers run in heel's sandbox, on Linux, and reach the network only through heel's egress proxy. For `gh`, and for any CLI or local MCP server connected with `--credential-host`, heel keeps the credential on its side of that proxy:

- The program gets a random placeholder where it expects the credential (`GH_TOKEN`, the account's `--credential-env` variable, or npm's `_authToken`).
- For the credential hosts, the proxy opens TLS itself, with a certificate authority made for that one sandbox and host, and puts the real credential in the header only where the program sent the placeholder.
- So a gh extension, an npm script or the server itself can't read the credential and send it elsewhere. It can still use it against those hosts while the sandbox runs.

Name the hosts a program authenticates to with `--credential-host` (each also an `--egress` host) and how it sends the credential with `--credential-auth` (`bearer`, `basic` or `header:<Name>`):

```sh
printf %s "$ACME_TOKEN" | heel connect cli acme --as acme --bin /usr/local/bin/acme \
  --egress api.acme.example --credential-env ACME_TOKEN \
  --credential-host api.acme.example --credential-stdin
```

- **npm:** heel writes an npm config with the placeholder and its CA, so npm and Node must live under `/usr` (a distribution package or NodeSource, not nvm, volta or Homebrew).
- **A program that must hold the credential** (a key in a URL, say) can have it with `--credential-delivery env` instead of `--credential-host`. Anything that program runs can read it; heel warns at every start, and `heel account list` shows `env`.
- **Accounts from older versions** that put the credential in the environment are refused until you add `--credential-host` (better) or `--credential-delivery env` with `heel account set`. `heel account list` shows them as `refused`.

## How code mode runs

The agent's script runs in [Monty](https://github.com/pydantic/monty), a Python interpreter built for code a model wrote. It has no files, network, environment or clock, and can only call the functions heel gives it. Each call leaves the script, goes through your rules like any other call, and only an allowed result goes back in. The script never holds a credential.

- **On Linux with bubblewrap,** each script runs in its own `heel codemode-worker`, with no network and only heel's install mounted read-only.
- **Everywhere else** (macOS, Windows, a container without the options below), scripts run on a `heel codemode-host` helper, one per agent, a few at a time (one per 2 GB of memory, 2 to 8). It runs Monty compiled to WebAssembly under Node's permission model: no files beyond heel's install, no network, no programs. On macOS it also runs inside Seatbelt. Every script gets a fresh worker, with capped values, output and time.

**Requirements for the Linux sandbox:** install `bubblewrap` and `util-linux`. In Docker, start heel with `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` on a kernel that allows unprivileged user namespaces. Those loosen the container's own isolation, not the sandbox's. Without them, `heel run` and local MCP servers are unavailable, and code mode uses the helper.

## Definitions

heel ships definitions for Gmail, Outlook, Google Calendar, GitHub, Slack, Linear, Notion and Stripe: code that says, for each tool, what a call means. That's what lets rules say what you mean.

| Part | What it does | What it gives your rules |
| --- | --- | --- |
| `args` | A strict schema; anything else is refused before rules run. | Rules match what will actually be sent. |
| `readOnly` | Whether the tool can change anything. | `kind: read` or `kind: write`. |
| `prepare` | Runs before any rule; can read from the service and names the call. | An `action` shared across services (`email.send`) and fields like `recipients` or `repo`. A failed read denies the call. |
| `persistence` | Marks calls that outlive heel (forwarding rules, webhooks, deploy keys). | Only a rule that names the call can allow it. |
| `run` | Sends the call with the credential heel holds. | The agent never sees the credential. |
| `show` | Shapes what comes back. | Hidden mail never reaches the agent. |

A raw MCP server behind heel still gets approvals, pause, audit and counts, but rules can only match its `tool` and `args` as the agent sent them: no `kind: read`, no checks against the service, no hiding, and the approver reads JSON instead of a sentence. For your own HTTP API, `x-heel-action` and `x-heel-kind` in an OpenAPI file get you most of a definition without code ([Connect accounts](connect.md)).

A built-in is a folder under [`src/definitions/`](../src/definitions/) with a `definition.ts`, a small API client and tests. Notion's is about 400 lines and a good one to copy. [CONTRIBUTING](../CONTRIBUTING.md) has how to build and test heel.

## For teams

- **Admins set the ceiling.** Organization rules are checked first and can only deny or ask, so no personal rule or approval loosens them.
- **Owners approve.** Each account names its approver, so requests go to the person who owns it.
- **Everything is logged:** agent, run, arguments, the deciding rule or approval, and who approved. Admins can export it.
- **Your identity provider** handles sign-in and groups.
