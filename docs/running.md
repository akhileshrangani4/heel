# Running heel

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

heel is one process. It serves the **agent plane** on port 7300 (MCP at `/mcp`, the HTTP proxy at `/http/<account>/…`, `heel run` at `/run`) and the **human plane** on port 7301 (sign-in, passkeys, the approval page). Operators use the `heel` CLI, which reaches the running server over a local admin socket.

## Requirements

- **Node 26.13 or later**, for the npm package. The OCI image includes it.
- **Linux with bubblewrap**, only for `heel run` and code mode. On other hosts heel starts with both turned off and logs why; everything else works. See [The sandbox](#the-sandbox).

## With npm

```sh
npm install -g useheel
export HEEL_HOME=~/.heel     # put this in your shell profile
heel vault init              # creates $HEEL_HOME/master.key: back it up
heel serve
```

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

## From a checkout

Node 26.13 or later and pnpm. A checkout runs the TypeScript source directly:

```sh
pnpm install
export HEEL_HOME=~/.heel-dev
node bin/heel.js vault init
node bin/heel.js serve
```
