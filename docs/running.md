# Running heel

heel v0.1 runs as one process with two HTTP planes and an admin socket (spec: Architecture, "Listeners").

## With the OCI image

```sh
docker build -t heel .
docker run -d --name heel \
  -p 127.0.0.1:7300:7300 -p 127.0.0.1:7301:7301 \
  -v heel-data:/var/lib/heel \
  -e HEEL_MASTER_KEY="$(head -c 32 /dev/urandom | base64)" \
  heel
```

- The image starts with `examples/heel.yaml` (`/etc/heel/heel.yaml`). Mount your own over it, or set `HEEL_CONFIG`.
- **Keep the master key.** It encrypts every stored credential; without it they can't be read. Prefer a key file mounted read-only (`vault.key_file`) over the environment.
- Port 7300 is the agent plane (MCP at `/mcp`, the HTTP proxy at `/http/<account>/…`, `heel run` at `/run`). Port 7301 is the approval page. Outside localhost, the approval page must be served on `https://` (`public_url`), since its host becomes the passkey RP ID.
- Run admin commands inside the container: `docker exec heel node /opt/heel/bin/heel.js agent add inbox-bot`.

### The sandbox in a container

`heel run` and code mode run commands under bubblewrap, which needs unprivileged user namespaces. Docker's default seccomp profile blocks them, so heel starts with both refused and logs why (everything else works). To enable them, run with a seccomp profile that allows `unshare` and `clone` with `CLONE_NEWUSER`, on a host kernel that allows unprivileged user namespaces.

## From a checkout

Node 26.13 or later and pnpm:

```sh
pnpm install
node bin/heel.js vault init
node bin/heel.js serve
```

## Rules

`examples/rules/owner.yaml` is the README's example rules file, unchanged. Copy it to `$HEEL_HOME/rules/<user>.yaml` and edit it; `heel rules check` validates it and `heel rules test` runs cases against it.
