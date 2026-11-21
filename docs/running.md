# Running heel

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

heel is one process. Agents reach it on port 7300 (MCP, the HTTP proxy and `heel run`); you reach the approval page on port 7301. The `heel` command talks to it through a local socket.

You need Node 26.13 or later, or Docker. `heel run` and local MCP servers also need Linux with bubblewrap ([Sandbox and credentials](sandbox.md)); on other hosts heel turns them off and everything else works. Code mode runs everywhere.

## Choose where heel runs

heel only controls an agent that has to go through it. An agent that can read heel's folder can read the master key, edit the rules and run `heel` commands, so run heel where your agents can't reach its files:

| Where | Agents on the same machine | Good for |
| --- | --- | --- |
| **Another machine** (a VPS, a Mac mini) | Can't reach it; they only see the ports you share | Daily use: [one heel for every machine](#one-heel-for-every-machine) |
| **Its own OS user, or Docker** | Can't read its files, if they can't use `sudo` or `docker` | Daily use on one machine |
| **Your own user** (`~/.heel`) | Can read and change everything | Trying heel out |

heel warns at startup (in `heel logs`, or in the terminal for `heel serve`) when its files are in your own home folder, and when a port is open beyond this machine.

## With npm

```sh
npm install -g useheel
heel init          # sets heel up in ~/.heel
heel start         # in the background; heel logs -f to watch it
```

`heel init` creates the master key, `heel.yaml` and starter rules, and changes nothing that's already there. Back up `master.key` off this machine: without it, the credentials heel stores can't be read. Then follow the [Quickstart](quickstart.md) from step 3.

### In the background or in a terminal

`heel start` runs heel in the background and returns once it answers; its log goes to `$HEEL_HOME/logs/heel.log` (rotated at 10 MB). Read it with `heel logs`, follow it with `heel logs -f`. `heel stop` stops heel however it was started, and `heel restart` starts it again in the background. `heel serve` runs it in the terminal instead, with the log on screen. A background heel doesn't start again after a reboot; run `heel start` again.

## With Docker

Create the master key once, inside heel's volume, then start heel:

```sh
docker run --rm -v heel-data:/var/lib/heel ghcr.io/akhileshrangani4/heel vault init

docker run -d --name heel \
  -p 127.0.0.1:7300:7300 -p 127.0.0.1:7301:7301 \
  -v heel-data:/var/lib/heel \
  ghcr.io/akhileshrangani4/heel
```

Back up the key, and run `heel` commands inside the container:

```sh
docker cp heel:/var/lib/heel/master.key ./heel-master.key && chmod 600 heel-master.key
docker exec heel heel user enroll owner
docker exec -i heel heel connect github --as github --credential-stdin < github-token.txt
```

- **Keep `127.0.0.1:` in `-p`.** A bare `-p 7300:7300` opens heel to your whole network.
- **Don't pass the key with `-e HEEL_MASTER_KEY=…`.** Anyone on the host can see it in `ps` and `docker inspect`.
- **For `heel run` and code mode,** add `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` (and `apparmor=unconfined` on hosts with AppArmor). `docker logs heel` names anything still missing. Mount the agent's directories at the same path: see [heel in Docker, agent on the host](heel-run.md#heel-in-docker-agent-on-the-host).
- **Anyone with Docker access** can read the volume, and so the key. Don't give agents Docker access.
- **Config:** mount your own `heel.yaml` over `/etc/heel/heel.yaml`. Rules go in `/var/lib/heel/rules/<user>.yaml`.

## One heel for every machine

You can run one heel on an always-on machine (a VPS, a Mac mini, a home server) and point the agents on every computer you use at it. Your accounts are connected once, your rules live in one place, and every approval comes to the same phone. It is also the safest setup, since no agent runs where heel's files are (see [Keep agents out of heel's files](#choose-where-heel-runs)).

**1. Start heel on the server.** Install it [with npm](#with-npm) or [with Docker](#with-docker) and run `heel init`, then `heel start`. Keep both planes on `127.0.0.1`: the next step puts HTTPS in front of them.

**2. Give both planes an HTTPS address.** With Tailscale, only your own devices can reach them:

```sh
tailscale serve --bg --https=443 7301     # the approval page
tailscale serve --bg --https=8443 7300    # the agent plane
```

Then set both addresses in heel.yaml and restart heel:

```yaml
public_url: https://heel-box.your-tailnet.ts.net              # the approval page
agent_public_url: https://heel-box.your-tailnet.ts.net:8443   # where agents connect
```

`public_url` must be set before you enroll a passkey, since a passkey is tied to the address. A Cloudflare tunnel or a reverse proxy with TLS works the same way; [Approve from your phone](approvals.md#approve-from-your-phone) has the options.

**3. Enroll and connect accounts on the server.** `heel user enroll <you>` and `heel connect …` run on the server, over its admin socket. Open the enrollment link on your phone and allow notifications.

**4. Add one agent per machine and tool.** A separate token for each lets you see which machine made a call, and pause or rotate one without touching the others:

```sh
heel agent add laptop-claude --owner <you>
heel agent add desktop-codex --owner <you>
```

**5. Point each agent at the server.** In the agent's MCP settings on each computer, use `agent_public_url` and that agent's token:

```json
{
  "mcpServers": {
    "heel": {
      "url": "https://heel-box.your-tailnet.ts.net:8443/mcp",
      "headers": { "Authorization": "Bearer heel_…" }
    }
  }
}
```

Each call is decided by your rules on the server and asks your phone when a rule says `ask`, wherever the agent runs.

What to know:

- **`heel run` needs the same directory on the server.** It runs commands in heel's sandbox, on heel's own copy of the agent's working directory, so an agent on your laptop can't `heel run` in a laptop checkout (see [the directory has to be the same on both sides](heel-run.md#the-directory-has-to-be-the-same-on-both-sides)). Use the GitHub service over MCP from other machines instead, or run that agent on the server.
- **The `heel` CLI works on the server only.** `heel status`, `heel tui`, `heel pause` and the rest talk to the admin socket. Over SSH they work as usual; from other machines, use the approval page.
- **Local MCP servers run on the server.** A `heel connect mcp --command …` server starts where heel runs, so its files and tools are the server's.
- **If the server is down, every call fails.** Nothing on the laptops can reach your accounts without it, which is the point. Keep it on a machine that stays up.

A second option is planned: `heel login` on each machine, with your connections in an end-to-end encrypted vault that every machine's heel can open, so no single server has to stay up ([roadmap](https://useheel.dev/roadmap)).

## Upgrading

```sh
heel update            # move to the newest heel, the way you installed it
heel update --check    # only say whether there is a newer one
```

Back up `HEEL_HOME` and the master key first. Then:

- **Installed with npm:** `heel update` runs `npm install --global useheel@<newest>` with the npm next to the Node heel runs on.
- **Docker:** a container can't replace itself, so `heel update` prints the steps: `docker pull ghcr.io/akhileshrangani4/heel:<newest>`, then start the container again from the new image with the same volume.
- **A git checkout:** it tells you to `git pull && pnpm install`.

A heel you started with `heel start` is restarted on the new version for you. One running in a terminal (`heel serve`) keeps the old version until you stop it and start it again. heel migrates its database when it starts; read the startup warnings. heel never updates itself in the background.

## More

- **[Configuration](configuration.md):** every `heel.yaml` key, where rules live, and what heel prints when it starts.
- **[Sandbox and credentials](sandbox.md):** how `heel run`, code mode and local MCP servers run, and how they get credentials without holding them.
