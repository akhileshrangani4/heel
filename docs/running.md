# Running heel

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

heel is one process. It serves the **agent plane** on port 7300 (MCP at `/mcp`, the HTTP proxy at `/http/<account>/…`, `heel run` at `/run`) and the **human plane** on port 7301 (sign-in, passkeys, the approval page). Operators use the `heel` CLI, which reaches the running server over a local admin socket.

## Requirements

- **Node 26.13 or later**, for the npm package. The OCI image includes it.
- **Linux with bubblewrap**, only for `heel run` and code mode. On other hosts heel starts with both turned off and logs why; everything else works. See [The sandbox](#the-sandbox).

## Keep agents out of heel's files

heel can only control an agent that has to go through it. An agent that can read heel's files doesn't: with `HEEL_HOME` it can read the master key (and so every stored credential), edit the rules, and run `heel` commands on the admin socket. File permissions don't help when the agent runs as the same OS user as heel, because to the system it *is* heel's owner.

Run heel where your agents can't reach it:

| Setup | Agents on this machine | Use it for |
| --- | --- | --- |
| heel on another machine (a VPS, a Mac mini) | Can't reach it; they only see the ports you share | Daily use |
| heel as its own OS user, or in Docker | Can't read its files, if they don't run as that user and can't use `sudo` or `docker` | Daily use on one machine |
| heel as your own user in `~/.heel` | Can read and change everything | Trying heel out |

`heel serve` warns at startup when heel's files sit in the running user's own home, and when either port listens beyond this machine.

heel adds speed bumps for the same-user case (a recovery link from `heel user enroll` waits a day, where you can cancel it), but they only raise the bar: an agent running as heel's user can change heel's database too.

A sandboxed agent (`heel run`, code mode) never sees `HEEL_HOME`; this is about agents with their own shell, like Claude Code or Codex on your laptop.

## With npm

```sh
npm install -g useheel
export HEEL_HOME=~/.heel     # put this in your shell profile
heel vault init              # creates $HEEL_HOME/master.key: back it up
heel serve
```

This runs heel as your own user, which is right for trying it out but not for keeping local agents out: see [Keep agents out of heel's files](#keep-agents-out-of-heels-files).

`HEEL_HOME` holds heel's config (`heel.yaml`), master key, database, rules and admin socket. Every `heel` command finds the running server through it, so set it in every shell, not just the one running `heel serve`.

Without `HEEL_HOME`, heel uses `/var/lib/heel` and puts the admin socket at `/run/heel/admin.sock`. That's the layout for a server install running as its own user. Any other `HEEL_HOME` keeps the admin socket inside it, so a personal install needs no root-owned directory.

Then follow the [quick start](../README.md#quick-start): enroll your passkey, connect an account, add an agent and write rules.

## With Docker

Create the master key once and keep it. It encrypts every stored credential, and without it they can't be read:

```sh
head -c 32 /dev/urandom | base64 > heel-master.key
chmod 600 heel-master.key

docker run -d --name heel \
  -p 127.0.0.1:7300:7300 -p 127.0.0.1:7301:7301 \
  -v heel-data:/var/lib/heel \
  -e HEEL_MASTER_KEY="$(cat heel-master.key)" \
  ghcr.io/akhileshrangani4/heel
```

Run `heel` commands inside the container:

```sh
docker exec heel heel user enroll owner
docker exec heel heel agent add my-agent
docker exec -i heel heel connect github --as github --credential-stdin < github-token.txt
```

- **Who can reach it:** anyone who can run `docker` on the host can run `heel` commands in the container and read its volume. Don't give agents Docker access.
- **Data:** the `heel-data` volume holds the database, rules and admin socket (`/var/lib/heel`). Put rules in `/var/lib/heel/rules/<user>.yaml`.
- **Config:** the image starts with [`examples/heel.yaml`](../examples/heel.yaml) at `/etc/heel/heel.yaml`. Mount your own over it, or set `HEEL_CONFIG`.
- **Master key:** a key file mounted read-only (`vault.key_file`) is better than the environment, which `docker inspect` shows.
- **Versions:** every release is tagged `ghcr.io/akhileshrangani4/heel:<version>`, and the newest is also tagged `latest`. To build the image yourself, run `docker build -t heel .` from a checkout.

## Configuration

heel reads `$HEEL_HOME/heel.yaml`, or the file named by `HEEL_CONFIG` or `--config`. Every key is optional, and relative paths resolve against `HEEL_HOME`. The ones you're most likely to set:

| Key | Default | What it's for |
| --- | --- | --- |
| `public_url` | `http://localhost:7301` | The approval page's address. Its host becomes the passkey domain, so it must be `https://` anywhere but localhost. Links in notifications use it. |
| `listen.agent`, `listen.human` | `127.0.0.1:7300`, `127.0.0.1:7301` | Where each plane listens. Use `0.0.0.0:<port>` in a container. |
| `admin_socket` | see [With npm](#with-npm) | The admin socket's path. |
| `vault.key_file` | `master.key` | The master key file. `HEEL_MASTER_KEY` takes precedence. |
| `database` | `heel.db` | The SQLite database. |
| `providers.google`, `providers.microsoft` | none | Your OAuth clients, needed to sign in Gmail, Calendar and Outlook accounts. Their redirect URIs are `public_url` + `/oauth/google/callback` and `/oauth/microsoft/callback`. |
| `agent_public_url` | none | Where cloud agents (Claude, ChatGPT and Grok connectors) reach the agent plane. Setting it turns on OAuth for them. |
| `oidc` | none | Sign-in through your identity provider, for teams. |
| `notify` | web push | Where approval requests are sent: web push, email, Slack. |
| `adapters.approval` | none | Approval adapters that add hints to the approval page; `jev` sends pending calls to TypeSafe. See [Hints](approvals.md#hints). |
| `log.level` | `info` | `debug`, `info`, `warn` or `error`. |

[`examples/heel.yaml`](../examples/heel.yaml) is a commented starting point.

## Rules

Rules live in `$HEEL_HOME/rules/<user>.yaml`, one file per user. A single-user install has `rules/owner.yaml`. Organization rules go in `$HEEL_HOME/org-rules.yaml`. heel reloads them when they change.

- `heel rules check` validates them.
- `heel rules test` runs cases against them.
- [`examples/rules/owner.yaml`](../examples/rules/owner.yaml) holds the examples from [rules.md](rules.md).

## Upgrading

```sh
npm install -g useheel@latest                 # npm
docker pull ghcr.io/akhileshrangani4/heel     # Docker: then recreate the container with the same volume and key
```

heel migrates its database when it starts. Back up `HEEL_HOME` (or the volume) and the master key before upgrading.

## The sandbox

`heel run` and code mode run commands under bubblewrap, which needs unprivileged user namespaces.

- **On a Linux host:** install `bubblewrap` and `util-linux`.
- **In Docker:** the default seccomp profile blocks user namespaces, so heel starts with both turned off. To turn them on, run with a seccomp profile that allows `unshare` and `clone` with `CLONE_NEWUSER`, on a host kernel that allows unprivileged user namespaces.

### Credentials stay outside the sandbox

A sandboxed program reaches the network only through heel's egress proxy. For `gh`, and for a local MCP server connected with `--credential-host`, heel keeps the credential on its side of that proxy:

- The program gets a random placeholder where it expects the credential (`GH_TOKEN`, or the server's `--credential-env` variable).
- For the credential hosts, the proxy opens TLS itself, with a certificate authority made for that one sandbox and host, valid only for that exact host (not its subdomains). The sandbox trusts it through `/heel/run/ca.pem` (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and the like).
- The proxy puts the credential in the `Authorization` header (or the one header you named), and only where the program sent the placeholder. A request with any other credential there is refused.

So code that runs in the sandbox, a gh extension or an npm script or the MCP server itself, can't read the credential and send it somewhere else. It can still use it against those hosts while the sandbox runs, the same as the program could.

**Accounts connected before this** keep working the old way, with the credential in the program's environment. `heel serve` warns about each at startup, and `heel account list` shows them as `"credentialDelivery": "env"`. `gh` accounts switch on their own. For a local MCP server, name its credential hosts:

```sh
printf %s "$NEW_NOTES_TOKEN" | heel account set notes --credential-host api.notes.example --credential-stdin
```

heel stops the running server at once; it starts again, without the credential, on its next call. Until now the server held the credential, so anything it ran could have copied it: rotate it with the provider and pipe the new one in (`--credential-stdin`, as above). Without `--credential-stdin` the stored credential stays, and heel reminds you to rotate it. A pause also stops the proxy adding the credential, including to a local server's requests between calls. Other CLIs (`heel connect cli <command> --credential-env`) still get the credential in their environment; a later release moves them too.
