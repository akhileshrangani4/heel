# Run heel on a server

How to install, run and upgrade heel, and how to run one heel on a server for every computer you use.

heel is one process. Agents reach it on port 7300 (MCP, the HTTP proxy, `heel run`); you reach the approval page on port 7301. You need Node 26.13 or later, or Docker. `heel run` and local MCP servers also need Linux with bubblewrap ([security](security.md)); elsewhere heel turns them off and everything else works.

## Choose where heel runs

heel only controls an agent that has to go through it. An agent that can read heel's folder can read the master key and edit the rules, so run heel where your agents can't reach its files.

| Where | Agents on the same machine | Good for |
| --- | --- | --- |
| **Another machine** (a VPS, a Mac mini). Recommended | See only the ports you share | Daily use: [one heel for every machine](#one-heel-for-every-machine) |
| **Its own OS user, or Docker** | Can't read its files without `sudo` or `docker` | Daily use on one machine |
| **Your own user** (`~/.heel`) | Can read and change everything | Trying heel out |

heel warns at startup when its files are in your home folder or a port is open beyond this machine.

## With npm

1. Install heel:
   ```sh
   npm install -g useheel
   ```
2. Set it up in `~/.heel` (master key, `heel.yaml`, starter rules; existing files are kept):
   ```sh
   heel init
   ```
3. Start it in the background:
   ```sh
   heel start
   ```

Back up `master.key` off the machine: without it, stored credentials can't be read. `heel logs -f` follows the log, `heel stop` stops heel, and `heel serve` runs it in the terminal instead. heel doesn't start again after a reboot on its own; run `heel start`.

## With Docker

1. Create the master key in heel's volume:
   ```sh
   docker run --rm -v heel-data:/var/lib/heel ghcr.io/akhileshrangani4/heel vault init
   ```
2. Start heel:
   ```sh
   docker run -d --name heel \
     -p 127.0.0.1:7300:7300 -p 127.0.0.1:7301:7301 \
     -v heel-data:/var/lib/heel \
     ghcr.io/akhileshrangani4/heel
   ```
3. Back up the key:
   ```sh
   docker cp heel:/var/lib/heel/master.key ./heel-master.key && chmod 600 heel-master.key
   ```
4. Run `heel` commands inside the container:
   ```sh
   docker exec heel heel user enroll owner
   ```

- **Keep `127.0.0.1:` in `-p`.** A bare `-p 7300:7300` opens heel to your network.
- **Never pass the key with `-e HEEL_MASTER_KEY=…`.** It shows in `ps` and `docker inspect`.
- **For `heel run` and code mode,** add `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` (and `apparmor=unconfined` with AppArmor). `docker logs heel` names anything missing.
- **Anyone with Docker access can read the key.** Don't give agents Docker access.
- **Config:** mount your `heel.yaml` over `/etc/heel/heel.yaml`; rules go in `/var/lib/heel/rules/<user>.yaml`.

## One heel for every machine

Run one heel on an always-on machine and point the agents on every computer at it. Accounts are connected once, rules live in one place, and approvals come to one phone.

1. **Start heel on the server** [with npm](#with-npm) or [with Docker](#with-docker), keeping both ports on `127.0.0.1`.
2. **Give both planes HTTPS addresses.** This does it for you:
   ```sh
   heel init --approve-from tailscale
   ```
   (or `--approve-from cloudflare --hostname heel.example.com`). By hand, put HTTPS in front of 7301 and 7300 and set both in `heel.yaml`, then restart:
   ```yaml
   public_url: https://heel-box.your-tailnet.ts.net              # the approval page
   agent_public_url: https://heel-box.your-tailnet.ts.net:8443   # where agents connect
   ```
   Set `public_url` before you create a passkey; a passkey is tied to its address. [Approve from your phone](approvals.md#approve-from-your-phone) has the options.
3. **Create your passkey and connect accounts on the server:**
   ```sh
   heel user enroll owner
   ```
   Open the link on your phone.
4. **Add heel to the agent on each computer.** It signs in with your passkey, so no token is copied:
   ```sh
   claude mcp add --transport http --scope user heel https://heel-box.your-tailnet.ts.net:8443/mcp
   ```
   Then in Claude Code run `/mcp`, pick heel and choose Authenticate. On heel's page choose **Connect with a passkey**. Only approve a sign-in you just started.

Each app on each computer becomes its own agent, named after the app (a second one gets `-2`), so you can pause or revoke one alone. For an app that can't sign in, use a token: **Agents**, **+ Add agent**, or `heel agent add laptop-cursor` ([connect your agent](agents.md)).

**Or let an agent do it:** the [quickstart](quickstart.md) prompt asks where heel should run and can set it up on a server over SSH, with your OK.

What to know:

- **`heel run` needs the agent's directory on the server,** since commands run on heel's copy of it. From other machines, use the GitHub service over MCP.
- **The `heel` CLI works on the server only.** From other machines, use the web app.
- **Local MCP servers run on the server,** with its files and tools.
- **If the server is down, every call fails.** Keep it on a machine that stays up.

## Upgrading

1. Back up `HEEL_HOME` and the master key.
2. Check for a newer heel:
   ```sh
   heel update --check
   ```
3. Update the way you installed it:
   ```sh
   heel update
   ```

With npm it installs the newest `useheel` and restarts a heel you started with `heel start`. With Docker it prints the steps (`docker pull`, then start a new container on the same volume). A git checkout is told to `git pull && pnpm install`. heel migrates its database on start and never updates itself in the background.
