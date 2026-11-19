# Run CLIs with heel run

[README](../README.md) · [Using heel](using-heel.md) · [Rules](rules.md) · [Running](running.md)

`heel run` lets an agent use a command-line tool such as `gh` or `npm` without holding its credential. The agent types `heel run -- gh pr list -R acme/web`. heel checks the command against your rules and, if they allow it, runs it itself, in a sandbox on heel's host, then sends back the output and the exit code. Nothing runs on the agent's side.

That last part is what trips people up: **the command runs on heel's machine, in heel's copy of the directory.** So heel needs to know which directories each agent may work in (its *workdirs*), the agent needs to know where heel is (`HEEL_URL`), and the directory has to be the same directory on both sides.

**You'll need:**

- heel running on **Linux with bubblewrap**, or in Docker with the options in [heel in Docker, agent on the host](#heel-in-docker-agent-on-the-host). On a Mac, run heel in Docker: the sandbox needs Linux.
- The `heel` command where the agent runs (`npm install -g useheel`). `heel run` doesn't read `HEEL_HOME`.
- The agent's heel token, from `heel agent add`.

## Set it up

Run these as heel's operator, with the same `HEEL_HOME` as `heel serve` (or with `docker exec heel heel …` for Docker).

### 1. Connect the CLI

```sh
gh auth token | heel connect cli gh --as gh --bin /usr/bin/gh --credential-stdin
```

`--bin` is the CLI's path **on heel's host**, and only that file and `/usr` are visible in the sandbox. For any other CLI, and for npm, see the CLI forms in [Using heel](using-heel.md#2-connect-your-agent).

### 2. Allow it in your rules

A command no rule matches is denied. In `$HEEL_HOME/rules/owner.yaml`:

```yaml
rules:
  - match: { command: gh, kind: read }
    then: allow
  - match: { command: gh }
    then: ask
```

gh commands that act on a repo need `-R <owner>/<repo>`, so the rules can see which repo it is.

### 3. Give the agent a workdir

A **workdir** is a directory the agent's commands may run in. `heel run` sends the directory it was started from, and heel runs the command only when that directory is a workdir or inside one. Each command's sandbox can see and change that workdir, and nothing else of the host but `/usr` and the CLI. A new agent has none, so every `heel run` is refused until you add one.

```sh
heel agent workdir my-agent /home/me/code
```

```
"my-agent" may run commands in:
  /home/me/code
```

| To | Run |
| --- | --- |
| See an agent's workdirs | `heel agent workdir my-agent` |
| Set them | `heel agent workdir my-agent /home/me/code /home/me/notes` |
| Remove them all | `heel agent workdir my-agent --clear` |

- **Setting replaces the list.** To add a directory, name the ones you already have too.
- **Listing changes nothing.** With no workdirs, it prints:
  ```
  "my-agent" has no workdirs, so heel run refuses its commands.
  Add one with: heel agent workdir my-agent <dir>
  ```
- **Each one is checked on heel's host**, when you set it. It must be an absolute path to a directory that exists there. heel stores it with symlinks resolved, so the list can show a different spelling (on a Mac, `/tmp/x` becomes `/private/tmp/x`).
- **Some directories can't be workdirs:** `/`, `/home`, `/tmp` and `/var` themselves, anything inside `/usr`, `/etc`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/proc`, `/sys`, `/dev`, `/boot`, `/root` or `/run`, anything that overlaps heel's own home, and anything that overlaps a workdir of another person's agent.

When heel refuses one, nothing changes:

```
heel: not a usable work root: /home/me/code/nope (it doesn't exist) (invalid)
heel: not a usable work root: code (an absolute, normalized path) (invalid)
heel: not a usable work root: /tmp (a system directory) (invalid)
heel: not a usable work root: /home/me/.heel (it overlaps heel's own files) (invalid)
```

## Point the agent at heel

`heel run` reads three environment variables. Set them where the agent runs, before you start it:

```sh
export HEEL_TOKEN=heel_…                  # the agent's token, from heel agent add
export HEEL_URL=http://127.0.0.1:7300     # heel's agent plane
```

| Variable | What it is |
| --- | --- |
| `HEEL_TOKEN` | Required. The agent's heel token, the same one in its MCP settings. |
| `HEEL_URL` | Required, with no default. The address of heel's agent plane, as the agent reaches it: scheme, host and port, with no `/mcp` on the end. `heel run` posts to `$HEEL_URL/run`. |
| `HEEL_RUN_ID` | Optional. An id for one session of the agent's work. Rules that count items `per: run` add up the calls that share it. |

Which `HEEL_URL` to use:

| Where the agent runs | `HEEL_URL` |
| --- | --- |
| Same machine as heel, default port | `http://127.0.0.1:7300` (or `http://localhost:7300`) |
| Same machine, heel on another port (`listen.agent: 127.0.0.1:17300`, or `-p 127.0.0.1:17300:7300` in Docker) | `http://127.0.0.1:17300` |
| A container sharing heel's network (`--network container:heel`) | `http://127.0.0.1:7300` |
| A container on a Docker network with heel, which reaches it as `heel` | `http://heel:7300`, with `listen.agent: heel:7300` in heel.yaml (below) |
| Another machine, through your HTTPS front | The `agent_public_url` you set, such as `https://agents.example.com` |

**heel only answers to names it serves.** To stop DNS rebinding, the agent plane refuses a request addressed to any host but `localhost`, `127.0.0.1`, `[::1]`, the host in `listen.agent`, and the host of `agent_public_url`. A `HEEL_URL` that reaches heel by another name, say `http://heel:7300` or `http://host.docker.internal:7300`, gets:

```
heel: {"status":"denied","reason":"unknown_host","rule":null}
```

Fix it by listening on that name, in heel.yaml:

```yaml
listen:
  agent: "heel:7300"     # the name the agent uses; heel binds to the address it resolves to
```

Then check it from the agent's side, in its workdir:

```sh
cd /home/me/code/web
heel run -- gh pr list -R acme/web
```

gh's output comes back on stdout and stderr, and `heel run` exits with gh's exit code. Add `--json` to get heel's whole answer as one line instead, such as `{"status":"ran","exitCode":0,"stdout":"…","stderr":""}`.

## The directory has to be the same on both sides

`heel run` sends the path of the directory it was started from, exactly as the agent sees it. heel then looks that path up **on its own filesystem**: it resolves it there (symlinks and all) and runs the command only if the result is inside one of the agent's workdirs. The command then runs in heel's sandbox, on heel's files at that path.

So it works when both sides see the same directory at the same path:

| Setup | Works? |
| --- | --- |
| heel and the agent on one Linux machine | Yes. The agent's directory is heel's. heel's OS user needs to be able to read it, and to write it for commands that write. |
| heel in Docker, the agent on the host, the project bind-mounted **at the same path** (`-v /home/me/code:/home/me/code`) | Yes. |
| heel in Docker, the agent on the host, nothing mounted | No: `workdir_not_allowed`. You can't even set the workdir, since the path doesn't exist in the container. |
| Mounted at a different path (`-v /home/me/code:/work`) | No: the agent sends `/home/me/code/web`, which heel can't find. |
| The agent in a container, heel on the host or in another container | Only with the project mounted at the same path in both. |
| heel on another machine | Only if that machine has the same directory at the same path (a network share, say). Otherwise run the agent there too. |

If a directory at that path exists on heel's side but isn't the same one (a separate checkout, an empty folder), the command runs anyway, on heel's copy: the agent won't see what it changed, and gh reads the wrong checkout.

### heel in Docker, agent on the host

This is the usual setup on a Mac. Mount each directory the agent works in at **the identical path**, and let the container create the sandbox:

```sh
docker run -d --name heel \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  -p 127.0.0.1:7300:7300 -p 127.0.0.1:7301:7301 \
  -v heel-data:/var/lib/heel \
  -v "$HOME/code:$HOME/code" \
  -e HEEL_MASTER_KEY="$(cat heel-master.key)" \
  ghcr.io/akhileshrangani4/heel

docker exec heel heel agent add my-agent
docker exec heel heel agent workdir my-agent "$HOME/code"
```

On the host, where the agent runs:

```sh
export HEEL_TOKEN=heel_…
export HEEL_URL=http://127.0.0.1:7300
cd ~/code/web && heel run -- gh pr list -R acme/web
```

- **Why the two `--security-opt`s.** Docker's defaults block what bubblewrap needs: its seccomp profile blocks user namespaces, and its masked `/proc` paths stop the sandbox mounting its own `/proc`. Without them, `heel serve` logs `sandbox unavailable: … bwrap: Can't mount proc on /newroot/proc: Operation not permitted` and every `heel run` exits 70. They loosen the container's own isolation, not the sandbox's: heel still runs each command under bubblewrap with its own seccomp filter. We checked these two on Docker Desktop. A Linux host that runs AppArmor may also need `--security-opt apparmor=unconfined`; `heel serve`'s log names what failed.
- **The CLI has to be in the container.** `--bin` names a Linux binary inside the container, and the image doesn't include gh. Mount a Linux build of it, or build your own image from heel's with it installed.
- **Commands write as the container's `heel` user.** On Docker Desktop for Mac, files they create on a bind mount show up as yours.

### The agent in a container too

Mount the project at the same path in both containers, and pick a `HEEL_URL` the agent can reach under a name heel serves:

```sh
docker network create heel-net
# heel, with heel.yaml saying listen.agent: "heel:7300"
docker run -d --name heel --network heel-net --network-alias heel … -v /srv/code:/srv/code …
# the agent
docker run --network heel-net -v /srv/code:/srv/code -w /srv/code/web \
  -e HEEL_TOKEN=heel_… -e HEEL_URL=http://heel:7300 my-agent-image
```

Or run the agent with `--network container:heel` and `HEEL_URL=http://127.0.0.1:7300`, which needs no change to heel.yaml.

## What the agent gets back

When the command ran, `heel run` prints its output and exits with its exit code. When it didn't, it prints one `heel:` line to stderr, and the exit code says why:

| Exit | Means | What to do |
| --- | --- | --- |
| the command's own | It ran. | |
| 75 | Needs your approval (`pending`), or too much is running (`busy`). | Approve it, then run it again. |
| 77 | Denied, or the approval expired. | See the reasons below. |
| 69 | Paused. | Wait for the owner to resume it. |
| 70 | heel couldn't run it: no sandbox, a limit hit, or heel unreachable. | See the reasons below. |
| 64 | A usage error, in the command line or the request. | Fix the command. |

The `heel:` lines you're most likely to see while setting up:

| Line | Cause | Fix |
| --- | --- | --- |
| `heel: HEEL_URL isn't a URL` (exit 64) | `HEEL_URL` unset, or not a URL. | Set it, with the scheme: `http://127.0.0.1:7300`. |
| `heel: HEEL_TOKEN isn't set` (exit 64) | `HEEL_TOKEN` unset. | Set it to the agent's token. |
| `{"status":"denied","reason":"workdir_not_allowed",…}` | The directory isn't inside a workdir, or heel can't find that path on its side. | `heel agent workdir my-agent` to check; [same directory on both sides](#the-directory-has-to-be-the-same-on-both-sides). |
| `{"status":"denied","reason":"unknown_endpoint",…}` | No CLI account for that command (`heel connect cli …`), or `HEEL_URL` ends in a path such as `/mcp`. | Connect it, or drop the path from `HEEL_URL`. |
| `{"status":"denied","reason":"unknown_host",…}` | `HEEL_URL` uses a name heel doesn't serve. | [Listen on that name](#point-the-agent-at-heel), or use `127.0.0.1`. |
| `{"status":"denied","reason":"no_rule_matched",…}` | No rule matches the command. | Add a rule. |
| `{"status":"error","reason":"sandbox_unavailable"}` (exit 70) | heel's host can't run the sandbox (macOS, or Docker without the options above). | `heel serve`'s log says why. See [The sandbox](running.md#the-sandbox). |
| `{"status":"error","detail":"couldn't reach heel: fetch failed"}` (exit 70) | Nothing answers at `HEEL_URL`. | Check that heel is running, and the port. |
| `{"status":"error","detail":"couldn't reach heel: Unexpected end of JSON input"}` (exit 70) | heel answered, but refused `HEEL_TOKEN`: a typo, or a token since rotated or revoked. | Set the token `heel agent add` or `heel agent rotate` printed. |
