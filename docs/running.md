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
| `providers.google`, `providers.microsoft` | none | Your OAuth clients, needed to sign in Gmail, Calendar and Outlook accounts. Each takes a `client_id`. The secret comes from `HEEL_GOOGLE_CLIENT_SECRET` (`HEEL_MICROSOFT_CLIENT_SECRET`) or the `client_secret_file`, `google-client-secret` (`microsoft-client-secret`) by default. Their redirect URIs are `public_url` + `/oauth/google/callback` and `/oauth/microsoft/callback`. Step by step for Google: [Set up Google sign-in for heel](google-sign-in.md). |
| `agent_public_url` | none | Where cloud agents (Claude, ChatGPT and Grok connectors) reach the agent plane. Setting it turns on OAuth for them. |
| `oidc` | none | Sign-in through your identity provider, for teams. |
| `notify` | web push | Where approval requests are sent: web push, email, Slack. |
| `adapters.approval` | none | Approval adapters that add hints to the approval page; `jev` sends pending calls to TypeSafe. See [Hints](approvals.md#hints). |
| `sandboxes.per_agent`, `sandboxes.total` | `4`; one per GiB of memory less one, from 2 to 16 | How many code-mode scripts and `heel run` commands may run at once, for one agent and for all of them. Each runs in its own sandbox, whose processes may each use up to 1 GiB, so without a limit one agent could take the host's memory. Over either limit, heel answers `busy` at once and runs nothing; the agent sends it again later. |
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

heel migrates its database when it starts. Back up `HEEL_HOME` (or the volume) and the master key before upgrading. After an upgrade, read `heel serve`'s startup warnings: a local MCP server or CLI that still gets its credential in its environment is refused until you move it ([how](#upgrading-accounts-that-still-put-the-credential-in-the-environment)).

## The sandbox

`heel run` and code mode run commands under bubblewrap, which needs unprivileged user namespaces.

- **On a Linux host:** install `bubblewrap` and `util-linux`.
- **In Docker:** the default seccomp profile blocks user namespaces, so heel starts with both turned off. To turn them on, run with a seccomp profile that allows `unshare` and `clone` with `CLONE_NEWUSER`, on a host kernel that allows unprivileged user namespaces.

### Credentials stay outside the sandbox

A sandboxed program reaches the network only through heel's egress proxy. For `gh`, and for any local MCP server or CLI connected with `--credential-host`, heel keeps the credential on its side of that proxy:

- The program gets a random placeholder where it expects the credential: `GH_TOKEN`, the account's `--credential-env` variable, or, for npm, the registry's `_authToken` in the npm config heel writes.
- For the credential hosts, the proxy opens TLS itself, with a certificate authority made for that one sandbox and host, valid only for that exact host (not its subdomains). The sandbox trusts it through `/heel/run/ca.pem` (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and the like).
- The proxy puts the credential in the `Authorization` header (or the one header you named), and only where the program sent the placeholder. A request with any other credential there is refused.
- For `gh`, the credential hosts are `api.github.com` and `github.com`, plus `uploads.github.com` if you allowed it in the account's egress (`gh release upload` needs it). Those are the GitHub hosts gh sends its token to. Any other host you allow gets the placeholder at most.

So code that runs in the sandbox, a gh extension or an npm script or the MCP server itself, can't read the credential and send it somewhere else. It can still use it against those hosts while the sandbox runs, the same as the program could.

#### Connecting a CLI or a local MCP server

Name the hosts it authenticates to with `--credential-host` (each one must also be an `--egress` host), and how it sends the credential with `--credential-auth`: `bearer` (the default), `basic`, or `header:<Name>` for an API key header.

```sh
# A CLI that reads ACME_TOKEN and sends it as a bearer token to api.acme.example
printf %s "$ACME_TOKEN" | heel connect cli acme --as acme --bin /usr/local/bin/acme \
  --egress api.acme.example --credential-env ACME_TOKEN \
  --credential-host api.acme.example --credential-stdin

# A local MCP server that sends NOTES_TOKEN in an X-Api-Key header
printf %s "$NOTES_TOKEN" | heel connect mcp --as notes --command /usr/bin/node --arg /opt/notes/server.js \
  --egress api.notes.example --credential-env NOTES_TOKEN \
  --credential-host api.notes.example --credential-auth header:X-Api-Key --credential-stdin
```

**npm** reads its token from a config file, not the environment, so heel writes one for it. For each credential host, `/heel/run/npmrc` holds `//<host>/:_authToken=<placeholder>`, and `NPM_CONFIG_USERCONFIG` points npm at it. It also sets `cafile=/heel/run/ca.pem`. npm then sends `Authorization: Bearer <placeholder>`, and the proxy swaps in the token. `--credential-env` is optional for npm; give it (say, `NPM_TOKEN`) if a project's own `.npmrc` reads `${NPM_TOKEN}`, and that variable gets the placeholder too.

```sh
printf %s "$NPM_TOKEN" | heel connect cli npm --as npm --bin "$(realpath "$(command -v npm)")" \
  --egress registry.npmjs.org --credential-host registry.npmjs.org --credential-stdin
```

- **npm and Node must live under `/usr`.** The sandbox sees `/usr` and the `--bin` file, nothing else of the host. `--bin` for npm is its `npm-cli.js`, which loads the rest of npm's package and runs `node` from the sandbox's `PATH` (`/usr/local/bin:/usr/bin:/bin`). A distribution package or the NodeSource install (`/usr/lib/node_modules/npm`, `/usr/bin/node`) works; npm under nvm, volta or Homebrew doesn't.
- **Registries with a path** (`https://npm.example.com/api/npm/`): heel's entry covers every path on the host, which is enough for installs. `npm publish` and `npm whoami` only look for a token under the registry's exact path. For those, put `//npm.example.com/api/npm/:_authToken=${NPM_TOKEN}` in the project's `.npmrc` and connect with `--credential-env NPM_TOKEN`.
- **A project `.npmrc` or a flag** can still change what npm sends. None of it can reach the token: at most npm sends a different value, which the proxy refuses (`credential_mismatch`), or goes to a host without the placeholder.
- **npm only sends bearer tokens**, so `--credential-auth` must be `bearer` (or left out).

#### When the program has to hold the credential

Some programs can't work this way, say a server that sends its key in the URL, or a CLI with no network that reads its token locally. To give such a program the real credential in its environment, say so with `--credential-delivery env` instead of `--credential-host`:

```sh
printf %s "$KEY" | heel connect cli tool --as tool --bin /usr/local/bin/tool \
  --credential-env TOOL_KEY --credential-delivery env --credential-stdin
```

Anything that program runs can read the credential. `heel serve` warns about each such account at every start, and `heel account list` shows it as `"credentialDelivery": "env"`. Connect only a credential scoped to what the agent may do.

#### Upgrading: accounts that still put the credential in the environment

Earlier versions of heel gave a local MCP server or CLI connected without `--credential-host` its credential in its environment. heel no longer does that unless you ask. Those accounts still load after an upgrade, but every call on them is refused until you pick one of the two fixes below.

- **What the agent gets.** `heel run` exits 77 with:
  ```
  heel: {"status":"denied","reason":"credential_delivery","rule":null,"message":"account \"acme\" would put its credential in its CLI's environment, where anything the program runs can read it, so heel refuses its calls. heel's operator can fix it: name the hosts it authenticates to, and heel adds the credential on the wire: heel account set acme --credential-host <host> --credential-auth bearer|basic|header:<Name>. To keep the credential in the environment anyway: heel account set acme --credential-delivery env"}
  ```
  A local MCP server in this state is never started, so it lists no tools, and in code mode it has no module: the agent sees the account as empty. A call that names one of its tools anyway gets "heel denied … (credential delivery)." followed by the same message.
- **What you see.** `heel serve` logs a `credential_delivery_refused` warning for each one at startup, and `heel account list` shows it as `"credentialDelivery": "refused"`. `gh` accounts aren't affected; they moved to the proxy on their own in an earlier release.

To fix one, name its credential hosts. This is the better choice:

```sh
printf %s "$NEW_NOTES_TOKEN" | heel account set notes --credential-host api.notes.example --credential-stdin
```

Or keep the old behaviour, knowingly:

```sh
heel account set notes --credential-delivery env
```

`heel account set` works for local MCP servers and for CLIs other than `gh`, and takes effect at once: a running server stops and starts again on its next call with the new settings. Left out, `--credential-auth` keeps the account's current auth (`bearer` if it had none). Until now the program held the credential, so anything it ran could have copied it: rotate it with the provider and pipe the new one in with `--credential-stdin`, as above. Without `--credential-stdin` the stored credential stays, and heel reminds you to rotate it. A pause also stops the proxy adding the credential, including to a local server's requests between calls.
