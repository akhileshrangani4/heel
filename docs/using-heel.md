# Using heel

[README](../README.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

This is what working with heel looks like day to day: what you set up once, what your agent sees, and what you see when it needs you. [Running heel](running.md) covers installing and configuring it.

## 1. Set it up once

```sh
npm install -g useheel
export HEEL_HOME=~/.heel
heel vault init
heel serve
```

In a second terminal:

1. **Register your passkey.** `heel user enroll owner` prints a one-time link; opening it registers a passkey on that device.
   - **More devices:** once you have a passkey, add a phone or another computer from the approval page with **Add another device**: confirm with your passkey and open the link it gives you on the new device. `heel user enroll` for someone who already has a passkey makes a recovery link instead. It works only after a day, and until then the approval page shows it with a button to cancel it, so an agent that runs `heel` on the host can't quietly add a passkey of its own. That raises the bar; it doesn't make a same-user setup safe, since an agent running as heel's user can also change heel's database. Only running heel where agents can't reach its files does: see [Keep agents out of heel's files](running.md#keep-agents-out-of-heels-files).
   - **On `localhost`,** that's this computer: you approve here, with Touch ID, say.
   - **To approve from your phone,** give the approval page an HTTPS address first, and set it as `public_url` before you enroll, because a passkey is tied to the address. Tailscale (`tailscale serve --bg 7301`), a Cloudflare tunnel or a server with TLS all work. Only port 7301 needs to be reachable. Then open the enrollment link on your phone, add the page to your home screen, and allow notifications. [Approve from your phone](../README.md#approve-from-your-phone) has the steps.
2. **Connect the accounts your agent should use.** Each one gets an alias, and the agent only ever sees the alias.
   ```sh
   gh auth token | heel connect github --as github --credential-stdin
   heel connect gmail --as gmail-work          # then sign in from the Connections page
   heel connect mcp --as notion --url https://mcp.notion.com/mcp --oauth
   ```
   Gmail and Google Calendar sign in through your own Google OAuth client, set as `providers.google` in `heel.yaml`. Create it first: [Set up Google sign-in for heel](google-sign-in.md) takes about 5 minutes, once.
   Any MCP server, any HTTP API with an OpenAPI file, and any CLI can go behind heel. `heel --help` lists the forms.
3. **Write your rules** in `$HEEL_HOME/rules/owner.yaml` ([Rules](rules.md)). If you're unsure where to start, run `heel serve --watch` for a while. Every call runs, and the Activity page shows what each rule would have done.
4. **Add the agent.** `heel agent add my-agent` prints its heel token, once, and the MCP URL. That token is the only credential the agent gets. If it will use CLIs through `heel run`, also give it a workdir: `heel agent workdir my-agent /home/me/code` ([Run CLIs with heel run](heel-run.md)).

## 2. Connect your agent

Point the agent at heel instead of at the services. Then remove the agent's own connections to those accounts, or it can go around heel.

**Claude Code:**

```sh
claude mcp add --transport http heel "http://127.0.0.1:7300/mcp?tools=direct" \
  --header "Authorization: Bearer heel_…"
```

**Cursor, or any client with an `mcp.json`:**

```json
{
  "mcpServers": {
    "heel": {
      "url": "http://127.0.0.1:7300/mcp?tools=direct",
      "headers": { "Authorization": "Bearer heel_…" }
    }
  }
}
```

The agent now has one MCP server with every connected account's tools, named by alias (`gmail-work__send`, `github__merge`). Or give it one account at a time at `/mcp/<alias>`.

- **On Linux,** `/mcp` without `?tools=direct` is code mode: one `run_code` tool, where the agent writes a short Python script against typed modules (`gmail_work.search(...)`).
- **Claude, ChatGPT or Grok connectors** sign in with OAuth. Set `agent_public_url` ([Running](running.md#configuration)) and add heel as a custom connector.
- **CLIs:** the agent runs them as `heel run -- gh pr merge 123 -R acme/web`, with `HEEL_TOKEN` (its heel token) and `HEEL_URL` (heel's agent plane, such as `http://127.0.0.1:7300`) set. heel runs the command on its own host, in a directory you've made one of the agent's workdirs (`heel agent workdir my-agent /home/me/code`), so that directory must be the same one, at the same path, on heel's side and the agent's. [Run CLIs with heel run](heel-run.md) has the setup, Docker included. gh never holds your token: it runs with a placeholder, and heel puts the token in its requests to GitHub on the way out. gh's `--jq`/`-q` is still always denied, because jq can read gh's environment. Use `--json` (or `--template`) and filter the output with a local `jq` instead. A pull request or issue URL must be spelled `https://github.com/<owner>/<repo>/pull/<n>` (or `/issues/<n>`) and name the same repo as `-R`. heel denies other spellings (`www.`, ports, other hosts) and URL arguments to other gh commands, because gh would act on a repo the rules never checked. For the same reason, a command that takes `-R` needs it (or such a URL), and heel denies one that names a second repo or an owner along with `-R`: `gh label clone`'s source, `gh issue transfer`'s destination, `gh issue develop --branch-repo`, and `--org`/`--user`/`--repos` on `gh secret`, `gh variable` and `gh ruleset`.
- **HTTP APIs:** the agent calls `/http/<alias>/<path>` with its heel token.
- **Local MCP servers** run in heel's sandbox. Name the hosts the server authenticates to, and it never holds the credential either: its variable gets a placeholder, and heel adds the credential to requests to those hosts.
  ```sh
  heel connect mcp --as notes --command /usr/bin/node --arg /opt/notes/server.js \
    --egress api.notes.example --credential-env NOTES_TOKEN \
    --credential-host api.notes.example --credential-auth bearer --credential-stdin
  ```
  `--credential-auth` is `bearer` (the default), `basic` or `header:<Name>`. A server that sends its key in the URL can't use this. If it has to hold the credential itself, say so with `--credential-delivery env` in place of `--credential-host`: it then gets the real credential in `NOTES_TOKEN`, and heel warns about the account at every start. With neither, heel refuses to connect it. See [Credentials stay outside the sandbox](running.md#credentials-stay-outside-the-sandbox).
- **Other CLIs** work the same way. Name the hosts the CLI authenticates to, and it gets a placeholder:
  ```sh
  printf %s "$ACME_TOKEN" | heel connect cli acme --as acme --bin /usr/local/bin/acme \
    --egress api.acme.example --credential-env ACME_TOKEN \
    --credential-host api.acme.example --credential-stdin
  ```
  **npm** needs only its registry. heel writes npm's config for it, with a placeholder as the registry's `_authToken`:
  ```sh
  printf %s "$NPM_TOKEN" | heel connect cli npm --as npm --bin "$(realpath "$(command -v npm)")" \
    --egress registry.npmjs.org --credential-host registry.npmjs.org --credential-stdin
  ```
  A CLI or local server whose credential would sit in its environment is refused, with the fix in the error. The agent sees `heel: {"status":"denied","reason":"credential_delivery","rule":null,"message":"account \"acme\" would put its credential in its CLI's environment, ..."}`, and the message names the `heel account set` commands below.

## 3. What your agent sees

Every call gets one of these answers, right away:

| Outcome | What the agent gets | What it should do |
| --- | --- | --- |
| **Allowed** | The normal result. Hidden messages are dropped, with "heel hid 2 items from this result." | Carry on. |
| **Denied** | An error: "heel denied send on gmail-personal (rule)." Nothing ran. | Take a different route, or tell you. |
| **Needs approval** | "Approval needed: reply_all on gmail-work. Check with heel_status, then re-send the same call once it's approved." Nothing ran yet. | Keep working, check `heel_status`, and re-send once you've approved. |
| **Paused** | "send on gmail-work is paused. Nothing ran." | Stop and wait for you. |

- **Over HTTP,** these are status codes: 403 denied, 202 needs approval, 423 paused.
- **For `heel run`,** they're exit codes: 77 denied, 75 needs approval, 69 paused.
- **In code mode,** a denial is an exception the script can catch, while "needs approval" and "paused" stop the script and return what already ran.
- **When too much is running at once,** a script or command doesn't start: `run_code` returns status `busy`, and `heel run` exits 75 with `"status":"busy"` on its `heel:` line. Send it again once one of yours has finished.

The agent never sees why a rule matched, and it can't answer an approval. Approving only happens with your passkey on heel's page.

## 4. When it needs you

1. **You get a notification** on your phone (web push), or by email or Slack, if heel has an HTTPS address ([setting one up](../README.md#approve-from-your-phone)). It says which agent wants to do what, and links to heel. Replying to it approves nothing. Without notifications, waiting requests are listed on the approval page.
2. **You open the request.** The page shows the account, the tool, the rule that asked, the counts, and the **full arguments**: every recipient and the whole body, exactly what will run. If you've turned on the optional [hints](approvals.md#hints), they appear under the call ("asks someone for money", "looks routine for this agent"). Without them, everything else here works the same.
3. **You decide, with your passkey:**
   - **Approve once:** this exact call runs the next time the agent sends it, once.
   - **Approve as standing:** also allow this exact call, or everything this rule asks about, for a while (an hour up to 90 days), so you aren't asked again. Standing approvals are listed on the Standing approvals page, where you can revoke them.
   - **Deny:** the agent gets "denied" when it re-sends.
4. **The agent re-sends and the call runs**, checked against your rules again. A request nobody answers expires after 24 hours.

## 5. When something looks wrong

Tap **Pause** on the approval page, or run `heel pause --agent my-agent`. You can pause one agent, one account, or everything. Every call in scope stops at once, even one you already approved. Resuming needs your passkey, and nothing called during the pause is replayed.

## 6. Over time

- **Activity** shows every call, with its decision and the rule that made it, as they happen. It also suggests rules from what got asked or denied often.
- **Grants** and **standing approvals** list what you've allowed beyond your rules, and let you revoke any of it.
- **Modes** (admins, on the Modes page) decide whether heel's decisions take effect. There are two:
  - **Enforce** (the default): heel applies the rules. Calls are allowed, sent to you for approval, or denied.
  - **Watch**: calls your rules would deny or send for approval run anyway, and Activity marks each one "would deny" or "would ask" with "(watch)". Use it to try rules on real traffic, then switch back to Enforce.

  There are three ways to watch, from widest to narrowest: `heel serve --watch` (everyone without a mode of their own), the Modes page (the org default, or one person), and `watch: true` on a single rule ([Rules](rules.md)). Some things hold in every mode: pause, org rules, hidden mail, and calls heel can't check safely. A person's own mode can only be stricter than the org default, so a person set to Watch stays in Enforce while the org default is Enforce. Switching to Watch needs a passkey; switching to Enforce doesn't. (The database and API store Watch as `shadow`; older installs may show `record`, which behaves the same.)
- **Rules:** edit the file and heel reloads it. Run `heel rules check` and `heel rules test` before you rely on a change. Editing a rule ends the grants made from it, so widening a rule asks again.
