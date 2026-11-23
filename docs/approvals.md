# Approvals

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

When a rule says `ask`, the call waits for you. You see exactly what it will do, in plain words, and decide with your passkey. Nothing runs until you approve.

## What you see

Waiting requests are listed on the **Approvals** page, newest first, and you get a notification if you've turned them on. Each one leads with a sentence saying what the agent wants to do:

![Two requests waiting: a pull request merge and an email](images/approvals.png)

Open one to see everything that will run: for an email, every recipient, the subject and the whole body. Recipients outside your domains are marked. The agent's own reason, if it gave one, is shown as its words, not heel's:

![An email waiting for approval: To bob@vendor.com, subject Q3 invoice](images/approval-email.png)

When the call comes from a code-mode script, the page also shows the script under **From a script**: the calls it already made, and its code, as the agent wrote it. It's there so you can see what else the script means to do; heel still checks every later call in it on its own. If you approve, the agent resumes the script and it carries on from that call. **Stop the script** (no passkey needed) discards it instead, so it never carries on, whatever you decide about the call. If it's a background script, the page says so: approving starts it again at once, without the agent asking, and denying ends it. Running background scripts are listed on **Agents**, where you can stop them, and in `heel status`.

## Decide

- **Approve once:** this exact call runs the next time the agent sends it, once.
- **Approve for longer:** also allow this exact call, or everything the rule asks about, for this agent, for an hour up to 30 days. You aren't asked again while it lasts. Editing the rule ends it.
- **Deny:** the agent gets "denied" when it sends the call again.

Every decision asks for your passkey. The agent is told the call is waiting, checks back with `heel_status`, and sends it again once you've approved. A request nobody answers expires after 24 hours.

Approvals for longer are listed under **Agents → Standing approvals**, where you can revoke any of them.

**Grants** work the same way, ahead of time: on **Agents → Grants** you sign, with your passkey, a narrow allow for one agent and one task (say, label mail from one sender for the next hour). A grant only applies where nothing else matched or your rules would ask, never past a `deny`.

## Approve from your phone

Your phone has to reach heel's approval page over HTTPS, and heel has to know that address before you create your passkey, because a passkey only works on the address it was made on (that's how passkeys work in every browser: it's what stops a look-alike site from using yours).

**With Tailscale, heel does it for you.** With Tailscale signed in on heel's machine and HTTPS certificates on in your tailnet, run `heel init --approve-from tailscale` (or pick it when `heel init` asks). heel serves the approval page at `https://<machine>.<tailnet>.ts.net` and the agent plane on port 8443, to the devices your tailnet lets in (on a shared tailnet, check its access rules; an agent call still needs that agent's token), and writes both addresses into heel.yaml. It won't take a port Tailscale already serves something else on, won't change an address that's already set, and won't move a heel that already has a passkey unless you add `--new-address`, since a passkey made for the old address stops working. Then `heel start`, `heel user enroll owner`, and open the link on your phone: after you create the passkey, the page that follows turns on notifications for that device.

**With a Cloudflare tunnel on your own domain, heel does it too.** With `cloudflared` installed and `cloudflared tunnel login` done once (it opens a browser to pick your domain), run `heel init --approve-from cloudflare --hostname heel.example.com`. heel creates a named tunnel, points `heel.example.com` at the approval page and `heel-agents.example.com` at the agent plane (`--agent-hostname` to choose another), writes the addresses into heel.yaml, and from then on `heel start` runs the tunnel alongside heel and restarts it if it stops. A named tunnel keeps its address, so your passkey keeps working; a quick `trycloudflare.com` tunnel gets a new address each time, so heel doesn't use one. Use a name one level under your domain (`heel.example.com`, not `heel.dev.example.com`, which Cloudflare's free certificate doesn't cover), and both names must be on the domain `cloudflared` is signed in to. Unlike Tailscale, this puts both planes on the public internet: every agent call still needs a token and every decision a passkey, but anyone can reach the pages, so heel warns at start. Consider [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the approval page's hostname (not the agent plane's, which agents reach with their token), and a rate-limit rule.

**Or by hand:**

1. **Give the approval page an HTTPS address.**
   - **Tailscale** (private to your devices): `tailscale serve --bg 7301` gives it `https://<machine>.<tailnet>.ts.net`.
   - **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:7301` for a quick try, or a named tunnel on your own domain.
   - **A server** behind Caddy or nginx with TLS.
2. **Tell heel the address** in `heel.yaml`, then restart heel:
   ```yaml
   public_url: https://heel.example.com
   ```
3. **Create your passkey on your phone.** `heel user enroll owner` now prints a link at that address. Open it on your phone.
4. **Turn on notifications.** Add the page to your home screen (an iPhone only notifies for pages added this way), then turn on **Notifications on this device** under **Settings → Devices**. Email and Slack can notify too: see `notify` in [Configuration](configuration.md).

If you change `public_url` later, create your passkey again.

## Stop everything

Open **Settings → Pause** and pause what you need, or run `heel pause --agent my-agent` (or `--account`, or `--all`). Every call in scope stops at once, even one you already approved. Resuming needs your passkey, and nothing called during the pause is replayed.

![The Pause page](images/pause.png)

## Rule changes

An agent can also propose rules for your file. They wait under **Rule changes** on the Approvals page, and nothing changes until you add them with your passkey. See [Your agent can propose rules](rules.md#your-agent-can-propose-rules).

When you keep approving the same kind of request, heel suggests a rule for it under **Suggested rules** at the top of the page. **Review and add** opens it as a rule change; nothing changes until you add it with your passkey. See [heel suggests rules from what you decide](rules.md#heel-suggests-rules-from-what-you-decide).

![A proposed rule: vendor-mail, with the agent's why and where it goes](images/proposal.png)

## Hints

Optional advice under a waiting request, such as "asks someone for money". Hints never decide anything. See [Hints](hints.md).
