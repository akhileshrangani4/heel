# Sandbox and credentials

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

`heel run`, code mode and local MCP servers run in heel's sandbox, on Linux. This page is how it works and how to connect programs to it. To use `heel run`, start with [Run CLIs with heel run](heel-run.md).

## Requirements

`heel run` and code mode run commands under bubblewrap, which needs unprivileged user namespaces.

- **On a Linux host:** install `bubblewrap` and `util-linux`.
- **In Docker:** the default seccomp profile blocks user namespaces, and the default masked `/proc` paths stop bubblewrap mounting its own `/proc`, so heel starts with both turned off. To turn them on, run with `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` (or a seccomp profile that allows `unshare` and `clone` with `CLONE_NEWUSER`), on a host kernel that allows unprivileged user namespaces.
- **Where commands run:** on heel's host, in a directory the agent's workdirs allow, so the agent's directory must exist at the same path on heel's side. With heel in Docker, bind-mount it at the identical path. [Run CLIs with heel run](heel-run.md) has the steps.

## Credentials stay outside the sandbox

A sandboxed program reaches the network only through heel's egress proxy. For `gh`, and for any local MCP server or CLI connected with `--credential-host`, heel keeps the credential on its side of that proxy:

- The program gets a random placeholder where it expects the credential: `GH_TOKEN`, the account's `--credential-env` variable, or, for npm, the registry's `_authToken` in the npm config heel writes.
- For the credential hosts, the proxy opens TLS itself, with a certificate authority made for that one sandbox and host, valid only for that exact host (not its subdomains). The sandbox trusts it through `/heel/run/ca.pem` (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and the like).
- The proxy puts the credential in the `Authorization` header (or the one header you named), and only where the program sent the placeholder. A request with any other credential there is refused.
- For `gh`, the credential hosts are `api.github.com` and `github.com`, plus `uploads.github.com` if you allowed it in the account's egress (`gh release upload` needs it). Those are the GitHub hosts gh sends its token to. Any other host you allow gets the placeholder at most.

So code that runs in the sandbox, a gh extension or an npm script or the MCP server itself, can't read the credential and send it somewhere else. It can still use it against those hosts while the sandbox runs, the same as the program could.

### Connecting a CLI or a local MCP server

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

### When the program has to hold the credential

Some programs can't work this way, say a server that sends its key in the URL, or a CLI with no network that reads its token locally. To give such a program the real credential in its environment, say so with `--credential-delivery env` instead of `--credential-host`:

```sh
printf %s "$KEY" | heel connect cli tool --as tool --bin /usr/local/bin/tool \
  --credential-env TOOL_KEY --credential-delivery env --credential-stdin
```

Anything that program runs can read the credential. heel warns about each such account at every start (see `heel logs`), and `heel account list` shows `env` in its CREDENTIAL column (`"credentialDelivery": "env"` with `--json`). Connect only a credential scoped to what the agent may do.

### Upgrading: accounts that still put the credential in the environment

Earlier versions of heel gave a local MCP server or CLI connected without `--credential-host` its credential in its environment. heel no longer does that unless you ask. Those accounts still load after an upgrade, but every call on them is refused until you pick one of the two fixes below.

- **What the agent gets.** `heel run` exits 77 with:
  ```
  heel: {"status":"denied","reason":"credential_delivery","rule":null,"message":"account \"acme\" would put its credential in its CLI's environment, where anything the program runs can read it, so heel refuses its calls. heel's operator can fix it: name the hosts it authenticates to, and heel adds the credential on the wire: heel account set acme --credential-host <host> --credential-auth bearer|basic|header:<Name>. To keep the credential in the environment anyway: heel account set acme --credential-delivery env"}
  ```
  A local MCP server in this state is never started, so it lists no tools, and in code mode it has no module: the agent sees the account as empty. A call that names one of its tools anyway gets "heel denied … (credential delivery)." followed by the same message.
- **What you see.** heel logs a `credential_delivery_refused` warning for each one at startup (see `heel logs`), and `heel account list` shows `refused` in its CREDENTIAL column (`"credentialDelivery": "refused"` with `--json`). `gh` accounts aren't affected; they moved to the proxy on their own in an earlier release.

To fix one, name its credential hosts. This is the better choice:

```sh
printf %s "$NEW_NOTES_TOKEN" | heel account set notes --credential-host api.notes.example --credential-stdin
```

Or keep the old behaviour, knowingly:

```sh
heel account set notes --credential-delivery env
```

`heel account set` works for local MCP servers and for CLIs other than `gh`, and takes effect at once: a running server stops and starts again on its next call with the new settings. Left out, `--credential-auth` keeps the account's current auth (`bearer` if it had none). Until now the program held the credential, so anything it ran could have copied it: rotate it with the provider and pipe the new one in with `--credential-stdin`, as above. Without `--credential-stdin` the stored credential stays, and heel reminds you to rotate it. A pause also stops the proxy adding the credential, including to a local server's requests between calls.
