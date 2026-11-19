> **Exported from the Obvious project `prj_rqc5uhH3`.** Source: *heel v0.1 — build spec* (Blueprint `art_pghXabd9`), last updated 2026-11-13T20:34:07.407Z. Export date: 2026-11-17.
>
> Converted from the Blueprint's HTML. Callouts and notes are blockquotes carrying their label; diagrams keep their title, description and text labels; the in-page contents rail is omitted because GitHub renders its own outline.

heel · build spec · v0.1 · full README scope

# heel v0.1: what we build, how it behaves, and how we prove it

*A self-hosted gateway that holds every agent credential, decides each call with default-deny rules, and asks a person (passkey sign-in) for anything risky. This spec covers the whole README: MCP, code mode, HTTP, CLIs, hiding, approvals, pause, watch mode, teams, and incident replays.*

## Decision to approve

*Build heel as one TypeScript service, delivered through a release branch. Every agent call goes through one pure decision pipeline, and heel ships its own tools for the eight built-in providers instead of wrapping other people's MCP servers.*

**The problem.** Agents with standing credentials have deleted inboxes, mass-emailed clients, merged red PRs and printed tokens. The README describes the fix: an agent never holds a credential, every call passes rules that default to deny, and anything risky waits for a person who signs in with a passkey. The repo has only the README, a licence and demo assets. No code exists yet _[REQ §0]_.

**The direction** (you confirmed each point on Nov 13):

- **Stack:** TypeScript on Node 26 LTS, shipped as an OCI image, with SQLite through Drizzle and the official MCP SDK v2 packages _[STK §0]_.
- **Code mode:** agents write a Python subset that runs in Monty workers wrapped in bubblewrap. When a call needs approval, or the agent is paused, the script stops at that call because heel never resumes it _[STK §2.1]_.
- **Built-in providers:** heel's own tools call the provider APIs directly with the stored credentials: Gmail, Outlook mail and calendar, Google Calendar, GitHub, Slack, Linear, Notion and Stripe. Any other MCP server passes through, matched on its raw tool and argument names. **This departs from the README**, which says built-in definitions map tools on existing servers. The reason: recipients, item counts and hidden-message checks all need heel's own API reads anyway _[MCP §0 facts 3–5]_.
- **CLI runner:** heel runs on the same Linux host as the agent, as a separate user, inside bubblewrap with an outbound allowlist _[STK §3.2]_.
- **Teams:** sign-in through OIDC only, one SQLite file per install, and org and owner ids in the data model from the start.
- **Run ids:** sent in MCP `_meta`, in an HTTP header, and in an environment variable for `heel run`.

**What this spec settles**, where the README is silent:

- rule matching semantics;
- what makes two calls "the same call" for approvals;
- when counts are taken;
- how standing approvals survive rule edits;
- what watch mode may not relax;
- the placeholder shape for hidden items;
- exit codes and HTTP statuses;
- how `looks_like` is verified.

Each decision is marked **Decision** where it is made. The full list is in [Locked decisions](#delivery-locked-decisions-and-risks).

> **What you approve**:
>
> Approve the behavior in Part 2, the surfaces in Part 3, and the deliverables, acceptance criteria and tests in [Deliverables](#deliverables-and-acceptance-criteria).
>
> Delivery is a `release/heel-v0.1` branch. Staged PRs merge into it, and it merges to `main` once, after the incident replays pass. Planning starts from this document and does not reopen it.

> **Load-bearing assumption**:
>
> **The claim.** Default-deny rules plus passkey approvals prevent the four README incidents without making agents useless.
>
> **What confirms it:** the incident replays block each incident (D14), while the "useful" scenario in each replay still runs.
>
> **What breaks it:** any of these happen in real use:
>
> - so many approval requests that people approve without reading;
> - agents that ignore "pending" results and keep retrying;
> - a `looks_like` false-positive rate that hides ordinary mail.
>
> **Check before committing:** run watch mode on a real inbox and a real repo for a week, and count the would-be asks per day.
>
> **What the README does not cover:** its threat model has no answer for an approver who approves every request, or for a compromised heel host. Both are out of scope here.

## What I read

The repo has no code yet, so the evidence is the README plus three research documents written for this spec. Citations in this document use the keys below. A section reference points to a numbered section in that source.

| Key | Source | What it changed in this spec |
| --- | --- | --- |
| **README** | `akhileshrangani4/heel``README.md` on `main` | The product contract: what every surface, rule check, approval, hiding and teams feature must do. The repo also has `LICENSE` (Apache-2.0) and demo assets, and nothing else. |
| **REQ** | heel research: requirements map, `art_RNJqRJci` | 25 capabilities (C-01…C-25) and the testable invariants I-01…I-74 used as acceptance criteria below (§2). I-75 (a program whose credential heel adds at its egress proxy never receives it) was added with credential delivery at the proxy. The open questions Q-\* are answered here (§4). |
| **MCP** | heel research: MCP and provider APIs, `art_1G3anPKA` | Several findings forced decisions: MCP 2026-07-28 is stateless; tokens must not be passed through; tool annotations are untrusted (§0); the options for returning a pending result (§1.7); how Gmail and Graph actually send mail and what they return (§2); merging GitHub PRs with a head-SHA guard (§4); gh and kubectl parsing hazards (§5); `looks_like` has no reliable standard (§6). |
| **STK** | heel research: stack and architecture, `art_wgq2qFAj` | The stack, Monty limits and stop semantics (§2.1), the bubblewrap runner (§3), the vault and refresh rules (§4), SQLite tables (§5), passkeys (§6), the YAML pipeline (§8), notification channels (§9), the request flow (§10.2), the fail-closed table (§10.3), and the repo layout, tests and CI (§11). |

**Findings that changed the design.**

- **Recipients often aren't in the arguments.** Gmail `drafts.send` and Graph `send` take no body. Graph `replyAll` loads its recipients from the original message _[MCP §0 fact 4, §2.2]_. So heel resolves recipients with its own reads before rules run, and a failed resolution is a deny. Mapping third-party MCP tools cannot do this reliably, which is why built-in providers are native.
- **One call can affect many items.** Gmail `batchModify` takes up to 1000 ids. A thread-level trash affects every message in the thread. GitHub's async merge of a stacked PR includes the PRs below it _[MCP §0 fact 5]_. So `items` is computed by expanding the call, never by counting calls.
- **A race-free merge guard exists.** GitHub accepts a REST `sha` and rejects the merge with `409` when the PR head has moved _[MCP §4]_. heel pins the head SHA it checked.
- **A state lookup that fails can't count as "false".** Under first-match, a false condition falls through to a broader `allow` below it _[STK §10.2 step 6]_. So a failed lookup denies the whole call.
- **Code mode must stop a script without an exception.** An exception could be caught with `try/except` _[STK §2.1 item 2]_. heel stops by never resuming the script.
- **A CLI's verb depends on its config and environment, not just argv.** gh shell aliases, kubectl `kuberc` aliases, and plugins or extensions can change what runs _[MCP §0 fact 7, §5]_. heel neutralises them or denies the call.
- **Login-code detection has no reliable standard, and reset-link detection has no open-source detector.** _[MCP §6, §7 gap 9]_. `looks_like` fails closed and ships with a measured fixture corpus, not a claimed accuracy.

> **Note:** Provider facts in this spec come from the research documents, which cite the primary sources. Where a document marks something as a gap (for example, whether Graph `replyAll` drops your own address), this spec treats it as unknown and designs around it.

Part 1

# System shape

*Processes, planes, and the single pipeline every call goes through.*

## Architecture

*One process, `heel serve`, running as the `heel` Unix user. It has three listeners, one decision pipeline, and four ways of executing a call. Agents reach only the agent plane, and only with a heel token.*

> **Diagram: heel process and trust boundaries.** Agents reach the agent plane with a heel token. Approvers reach the human plane with a passkey. Operators reach the admin socket through file permissions. All three feed one pipeline backed by the vault and SQLite store. The pipeline executes allowed calls through native providers, upstream MCP servers, the HTTP proxy, Monty workers or the CLI runner.
>
> Diagram labels: AGENT · heel token only · APPROVER · phone + passkey · OPERATOR · shell on heel host · AGENT PLANE · /mcp · /http · /run · HUMAN PLANE · HTTPS approval page · ADMIN SOCKET · unix, mode 0600 · PIPELINE · auth · pause · normalize · hidden target · state · counts · decide · execute · hide · audit · VAULT · STORE · SQLite, AES-GCM · EXECUTORS · native providers · upstream MCP · HTTP proxy · Monty (bwrap) · CLI runner (bwrap) · trust boundary
>
> *Three listeners feed one pipeline. Everything right of the dashed line runs as the `heel` user.*

### Processes

| Process | Holds | Can reach |
| --- | --- | --- |
| `heel serve` | Every credential, the master key and the database | Provider APIs, upstream MCP servers, notification services |
| Monty worker (under bubblewrap) | The script, plus host-call results after hiding | Nothing. It talks to the main process over stdio only. No network or filesystem, and its environment never holds a credential _[STK §2.1 item 4]_. |
| CLI runner child (under bubblewrap) | For `gh`, a placeholder in place of the token (heel's egress proxy adds the token on the wire); for another CLI, one credential variable. A tmpfs `HOME`, and the agent's cwd bound in | Allowlisted hosts for that CLI, through heel's egress proxy _[STK §3.2]_ |
| Local stdio MCP server (third-party code) | With credential hosts, a placeholder in its credential variable; without them, the credential itself | Same bubblewrap and egress treatment as CLIs _[STK §13 N-8]_ |
| `heel run` client (agent side) | The agent token only | The agent plane |

### Listeners

- **Agent plane** (default `127.0.0.1:7300`). Endpoints:  It accepts heel agent tokens only.
  - `/mcp`: code mode;
  - `/mcp/<account>`: direct tools for one account;
  - `/http/<account>/…`: the HTTP proxy;
  - `/run`: the CLI runner;
  - `/approvals/<id>`: status check-back only.
- **Human plane** (default `127.0.0.1:7301`). The operator exposes it on a stable HTTPS hostname, which becomes the WebAuthn RP ID. **Decision:** heel refuses to start the human plane when `public_url` is not `https://`. The exception is `localhost`, for development. This plane accepts passkey or OIDC sessions only. Agent tokens are rejected here (I-58).
- **Admin socket** (`/run/heel/admin.sock`, mode 0600, owned by `heel`). Used by `heel connect`, `heel agent`, `heel pause`, `heel approvals`, `heel audit` and the passkey bootstrap code.

### Code layout

One package. A lint rule keeps I/O imports out of `src/core`, so the decision logic stays pure and can be table-tested. The layout follows _[STK §11.1]_:

- `src/core`: the call model, canonical hash, rules schema, evaluator, count math and hide filters.
- `src/definitions`: native provider tools, action maps, response shapes, deny lists and CLI tables.
- `src/store`: Drizzle schema and migrations.
- `src/vault`: envelope encryption, OAuth connect and refresh.
- `src/gateway`: the agent plane and the pipeline.
- `src/codemode`: Monty pool and `.pyi` stub generation.
- `src/runner`: the bubblewrap argv builder and egress proxy.
- `src/web`: Hono pages and WebAuthn.
- `src/notify`: web push, email and Slack.
- `src/teams`: OIDC, roles and org rules.
- `src/cli`: the `heel` command.

Pinned dependencies, at the versions in _[STK §0]_:

- `@modelcontextprotocol/server` and `/client` 2.4.x
- `@pydantic/monty` 1.6.x
- `better-sqlite3` 13.1.x, with Drizzle 0.45.x
- `openid-client` 6.9.x
- `@simplewebauthn/server` 14.1.x
- Hono 4.13.x
- `yaml` 2.9.x and Zod 4.6.x
- `web-push` 4.0.x, `nodemailer` 10.5.x and `@slack/web-api` 8.4.x
- pino 10.4.x, Vitest 5.1.x and Biome 2.6.x

Patch versions float, and the lockfile is committed.

## Call model and normalization

*Every surface (MCP tool call, a call from inside a code-mode script, an HTTP request or a `heel run` command) becomes the same `Call` record before any rule sees it. Rules, counts, approvals and audit only ever see this record.*

*src/core/call.ts: the normalized call (intended interface)*

```typescript
type Surface = "mcp" | "code" | "http" | "cli";

interface Call {
  // who
  orgId: string;               // single org per install in v1
  agentId: string;             // from the heel token, never from the request body
  ownerId: string;             // user who owns the agent
  runId?: string;              // agent-supplied; scoped per agent
  // what
  surface: Surface;
  account: string;             // alias, e.g. "gmail-work"; HTTP and CLI use the connected alias
  provider: string;            // "gmail" | "outlook" | "github" | … | "mcp:<alias>" | "http:<alias>" | "cli:<name>"
  tool: string;                // native tool name, raw upstream tool name, "<METHOD> <path-template>", or the CLI command path
  args: unknown;               // exactly what will be executed, after heel's own rewrites (e.g. pinned sha)
  // derived by the provider definition (absent when unknown)
  action?: string;             // "email.send", "email.remove", "github.merge", …
  kind?: "read" | "write";     // only from built-in definitions (I-20)
  recipients?: string[];       // lower-cased addr-specs: to ∪ cc ∪ bcc ∪ derived
  items: number;               // expanded item count; 1 when unknown
  targets?: string[];          // ids the call touches (messages, PRs) for hidden-target and audit
  repo?: string;               // "owner/name" for GitHub
  cli?: { command: string; verb?: string; subcommand?: string; flags: Record<string, string | true>; argv: string[] };
  persistence?: boolean;       // the tool creates something that outlives revocation (I-70)
}
```

### Pipeline order

This order is binding. Each step runs before the next, and any exception in any step denies the call _[STK §10.2, §10.3]_.

1. **Authenticate** the agent token (stored only as a hash) and resolve the agent, owner and org. A missing, unknown or revoked token is rejected before anything else happens (I-03).
2. **Pause check** on the global, agent, account and provider scopes. If any matches, the result is `paused` (I-60).
3. **Normalize** the call through its provider definition. Resolving recipients and expanding items may require provider reads. If a needed read fails, the call is denied.
4. **Hard denies.** These ignore rules: commands that print credentials, a call aimed at a hidden message, a `persistence` tool with no rule that names it, and a call into a batch endpoint heel cannot expand.
5. **Approved re-run lookup.** If an approved approval matches this call's hash, go to the [re-check path](#approvals-standing-approvals-and-pause).
6. **State checks** run lazily: only for rules whose other conditions already match, in rule order. Each lookup has a 5-second timeout. If a lookup fails, the call is denied _[STK §10.3]_.
7. **Counts and decide** run in one `BEGIN IMMEDIATE` transaction. Order: org rules first, then your rules from top to bottom, with each standing approval checked just above the rule that asked for it _[README "Rules"]_. The first match wins, and no match means deny. If the decision is allow, the items are reserved in the same transaction (I-10, I-11, I-24).
8. **Execute** through the executor. heel attaches the credential; the agent never supplies one.
9. **Hide** filters the response before it reaches the agent or the code-mode sandbox (I-40, I-45).
10. **Audit.** Write one record per decision, then return (I-73).

### Run ids

- **Where they travel** (you decided this earlier):
  - MCP: `params._meta["heel/runId"]`
  - HTTP: the `Heel-Run-Id` header
  - `heel run`: the `HEEL_RUN_ID` environment variable, which the client forwards
  - code mode: the `run_id` argument of `run_code`; if absent, the run id of the MCP request that carried it
- **Decision:** heel stores run ids as `(agent_id, run_id)`, so two agents that send the same string never share a count. The format is 1–128 characters from `[A-Za-z0-9._:-]`. Anything else is ignored and logged, and the call is treated as having no run id.
- **Decision:** per-run counts are kept for 7 days after the run's last call, then deleted. Per-hour counts never depend on the run id (I-25).

### Canonical call hash: what counts as "the same call"

**Decision.** The approval key is `sha256(JCS({agentId, account, tool, args}))`, where JCS is RFC 8785 JSON canonicalization and `args` are the post-rewrite arguments.

- The run id is **excluded**. A new run that asks for the same send joins the pending request instead of creating a duplicate.
- The agent is **included**. Another agent's identical call is a separate request, because the approver is approving an agent as well as an action.
- For the CLI, `args` is `{argv, cwd}`. The cwd matters because the same command run against a different checkout is a different action.
- Answers REQ Q-A2 and satisfies I-51 and I-52.

Part 2

# Behavior

*Rule semantics, counts, state checks, approvals, pause, hiding and watch mode. The README leaves these underspecified; this part settles them.*

## Rules language

*The README's examples are the grammar. This section adds the parts the README leaves out: how conditions combine, what a list field means for each check, what happens when a field is missing, and how files load.*

### Files and layers

- **Where the files live.**
  - `$HEEL_HOME/org-rules.yaml`: org rules. Only admins edit this file.
  - `$HEEL_HOME/rules/<user>.yaml`: one file per user. A single-user install has exactly one.
  - Both files share one top-level schema, `{ rules: Rule[], hide?: HideEntry[] }`.
  - An agent's calls go through the org file and then its **owner's** file.
- **Evaluation order** _[README "Rules"]_:
  1. Org rules.
  2. The owner's rules from top to bottom. Each live standing approval is checked just above the rule that created it.
  3. If nothing matched, deny.
- **Org rules can only deny or ask.** `then: allow` in `org-rules.yaml` is a load error (I-12). An `ask` from an org rule goes to org admins. It can only ever be approved once, never as a standing approval, so no approval can loosen the org ceiling.
- **Hide entries** from the org file and from the account owner's file both apply to every call on that account.

*Rule shape (README grammar plus the optional fields this spec adds)*

```yaml
rules:
  - name: client-sends-ask         # optional; stable id shown in audit and on the approval page
    match:                          # every key must hold (AND); an unknown key is a load error
      action: email.send
      account: gmail-work           # scalar shorthand for { equals: gmail-work }
      recipients:
        all_domain_in: [company.com]
        max: 5
    then: ask                       # allow | deny | ask
    watch: true                     # optional: log what it would decide, then keep evaluating as if it hadn't matched
```

### How a match is decided

**Decision:**

- All keys in `match` are ANDed. v1 has no OR and no NOT. Write two rules instead.
- If a key names a field the call doesn't have, that condition is false and the rule doesn't match. For example, `recipients` on a GitHub call, or `kind` on an unknown tool (I-18, I-20).
- A rule with an empty `match: {}` matches every call. Use it to write an explicit catch-all.

| Check | On a single value | On a list (e.g. `recipients`) | Empty list |
| --- | --- | --- | --- |
| `equals` | Exact, case-sensitive. Addresses and domains are compared lower-cased. | The set equals the given set. | Matches only `[]`. |
| `one_of` | The value is in the set. | **Every** element is in the set. | false |
| `any_of` | The value is in the set (same as `one_of`). | **At least one** element is in the set. | false |
| `matches` | The regex matches the whole value (anchored), using linear-time RE2 syntax. | Every element matches. | false |
| `any_domain_in` | The address's domain is in the set. | At least one element's domain is in the set. | false |
| `all_domain_in` | Same as `any_domain_in`. | Every element's domain is in the set. | false |
| `max` | Number ≤ n. | Length ≤ n. | true |
| `all_in_thread` | n/a | A state check. See [Counts and state](#counts-and-state-checks). | false |

**Rationale.** "All" checks are false on an empty list. Without that, a send whose recipients were never resolved would pass `all_domain_in` vacuously and match an `allow`.

**Address and domain normalization** (applied before any check):

- Keep only the address part (addr-spec) and lower-case it. Domains go through IDNA to punycode.
- `user+tag@x.com` stays as written.
- A domain in a rule matches that exact domain. Subdomains match only when written as `*.company.com`.
- Addresses that fail to parse make the call a deny.

### Fields a rule can name

| Field | Set by | Notes |
| --- | --- | --- |
| `account`, `provider`, `agent` | Every call | `agent` is the agent's name. |
| `action`, `kind`, `recipients`, `repo`, `checks` | Built-in definitions only | Action catalog: see [Built-in providers](#built-in-providers). `kind: read` comes only from a built-in definition, never from upstream annotations (I-20). |
| `items: { over: N, per: run \| hour }` | Every call | Unknown tools count as 1 item. Without `per`, the check applies to this call's items alone. |
| `tool`, `args.<dotted.path>` | Any MCP call | For unknown servers: the raw tool and argument names _[README "Rules"]_. A path into an array checks every element. |
| `method`, `path`, `query.<k>`, `body.<dotted.path>` | HTTP proxy | `path` matches the template from an OpenAPI or built-in definition when there is one, and the literal path otherwise. |
| `command`, `verb`, `subcommand`, `flags.<name>`, `argv` | CLI runner | `verb`, `subcommand` and `flags` exist only for known CLIs. `argv` (the raw argument list) works for any CLI. |

### Watch mode

- **Per-rule `watch: true`.** When the rule matches, heel writes an audit record of what it _would_ have decided, then keeps evaluating as if the rule hadn't matched (I-72).
- **Global `heel serve --watch`.** Outcomes from your own rules and the default deny are logged as "would deny" or "would ask", and the call runs (I-71). A would-be ask creates no pending request and sends no notification (Q-W2).
- **Decision on Q-W1, confirmed by you on Nov 13: global watch never relaxes**  These protect the ceiling and secrets rather than tune personal policy. This narrows the README's "lets every call through", and I'm flagging it as a departure.
  - pause;
  - org rules, because they are the admin's ceiling;
  - commands that print credentials (I-31);
  - persistence tools with no rule naming them (I-70);
  - calls aimed at a hidden message;
  - hiding of responses (Q-W3).

### Loading, testing and reload

- The YAML is parsed in YAML 1.2 core schema mode with duplicate keys rejected, then validated with a strict Zod schema. Every error carries the file, line and column _[STK §8]_.
- `heel rules check` validates the files. `heel rules schema` prints a JSON Schema for editor completion. `heel rules show` prints the effective order, including live standing approvals.
- `heel rules test cases.yaml` runs offline cases against the pure evaluator with no provider access. State-check results come from the case file. Exit code 0 means all cases pass and 1 means at least one fails.
- **Hot reload.** heel watches the files and swaps the rule set in atomically. If a reload is invalid, heel keeps the last good set and alerts admins. If no valid set exists at boot, `heel serve` starts and denies every call.

*cases.yaml (heel rules test input)*

```yaml
cases:
  - name: personal account never emails a client
    call: { agent: inbox-bot, account: gmail-personal, action: email.send, recipients: [ceo@clientco.com] }
    expect: { decision: deny, rule: 2 }
  - name: 21st removal this run asks
    call: { agent: inbox-bot, account: gmail-work, action: email.remove, items: 1, run: r1 }
    counts: { run: 20, hour: 20 }
    expect: { decision: ask }
  - name: merge with red checks falls through to deny
    call: { agent: ci-bot, account: github, action: github.merge, repo: acme/web }
    state: { checks: failing }
    expect: { decision: deny, rule: default }
```

## Counts and state checks

*Counts and state checks are the two kinds of condition that need information from outside the call itself. If heel can't get that information, the condition counts as failed and the call is denied.*

### Item counts

- **What is counted.**
  - Every call that heel lets run writes a row: `count_events(agent_id, run_id?, call_fields, items, at)`. This covers rule-allowed calls, approved re-runs and watch-mode pass-throughs. It is written in the same transaction as the decision.
  - Denied, asked, paused and expired calls write nothing.
  - If the upstream call fails, the items are not refunded. A batch that half-succeeded still counts in full.
- **What a count condition sums. Decision:**
  - It sums the items of past events from the same agent whose stored fields match the rule's other _plain_ conditions (account, action, repo and so on), then adds the current call's items (I-24).
  - So `{ action: email.remove, account: gmail-work, items: {over: 20, per: run} }` counts only removals on `gmail-work`.
  - State checks are not replayed against history.
- **Windows.**
  - `per: hour` is a sliding 60-minute window keyed by agent. The run id has no effect on it (I-25).
  - `per: run` is keyed by agent plus the agent-supplied run id.
  - Count events are kept for 7 days and survive restarts (I-04).
- **No run id.** A call without a run id never matches a `per: run` condition (I-26). **Decision on Q-C2:**
  - That rule falls through to the next one. That is why the README pairs every run limit with an hourly limit.
  - `heel rules check` warns when a `per: run` rule has no `per: hour` rule for the same action below it.
- **Concurrency.** The count read, the decision and the event insert all happen inside one `BEGIN IMMEDIATE` transaction. Of two parallel 15-item batches against `over: 20`, exactly one is allowed and the other gets `ask` _[STK §5]_.
- **Code mode** sends each call in the script through this path separately. A 500-iteration loop of single deletes ends in the same decision as one 500-item batch (I-27).

### Item expansion per action

| Call | Items | Source |
| --- | --- | --- |
| Gmail `batchDelete` / `batchModify` | The length of `ids` (up to 1,000) | _[MCP §2.1]_ |
| Gmail `threads.trash` / `threads.delete`, or a thread-level label removal | The number of messages in the thread, from one `threads.get(format=minimal)` read before deciding | _[MCP §2.1]_ |
| Gmail `/batch` multipart and Graph `/$batch` | Every part is checked and counted as its own call. If any part can't be parsed, the whole batch is denied. | _[MCP §2.1, §2.2]_ |
| Anything else | 1 | Decision |

### State checks

State checks run only for a rule whose plain conditions already match, in rule order. Each read uses heel's own credential for that account and has a 5-second timeout, and results are not cached across calls. A state check on a provider with no built-in definition is a load error (I-23).

**all_in_thread** _(email)_

- **Thread.** Gmail uses `threadId`, or resolves `In-Reply-To`/`References` to a thread. Outlook uses the original message's `conversationId`.
- **Which messages count.** Messages the account sent: Gmail `SENT` label (not `DRAFT`), Outlook the Sent Items folder. **Amended Nov 17 (D9a-2 review):** a `From` matching the mailbox doesn't count, since anyone can write it on mail to you and drafts carry it too.
- **Allowed set.** The union of To, Cc and Bcc across those messages.
- **Pass.** Every normalized recipient of the new call is in the allowed set.
- **Fails.** A new message with no thread, a thread where the account never sent anything, or any read error (I-21) _[MCP §2.1, §2.2]_.

**checks: passing** _(github)_

1. GET the PR and record head SHA H.
2. Read the combined status and all check runs for H (`filter=latest`, every page).
3. The required checks come from the branch rules. If that read fails, every reported check run counts as required.
4. **Pass:**
   - at least one check or status exists;
   - every required run is `completed` with `success`, `neutral` or `skipped`;
   - no status context is `failure`, `error` or `pending`.
5. The merge goes out with `sha=H`. A `409` response is reported as "head moved" (I-22).

Under this check, `bypass_rules`, `--admin` and `--auto` are denied _[MCP §4]_.

> **Note:** **Decision:** `neutral` and `skipped` count as passing; the research left this as a policy choice for heel to state _[MCP §4]_. A repo that reports no checks at all never passes, because an empty CI result must not read as green. **Reversal condition:** if a user needs merges on repos with no CI, they write an explicit rule without `checks`.

## Approvals, standing approvals and pause

*An `ask` never holds the agent's connection open. The agent gets a pending id right away. A person decides on heel's page with a passkey. The call runs only when the agent sends it again.*

> **Diagram: Approval lifecycle.** A pending approval moves to approved, denied or expired. An approved one moves to executed when the agent re-sends the identical call, or to expired if the agent never returns.
>
> Diagram labels: pending · approved · denied · executed · expired · passkey approve · passkey deny · identical call re-sent · no re-send in 1 h · pending TTL (24 h) passes
>
> *Approval states. Every transition writes an audit record (I-73).*

### Pending, joining and checking back

- **Creating a request.** An `ask` creates, or joins, the approval keyed by the call hash (see [Call model](#call-model-and-normalization)).
  - The agent gets back `{ status: "pending", approvalId }` at once (I-50).
  - Re-sending the identical call while it is pending returns the same id. It does not notify again (I-51).
  - A different agent sending the same call gets its own request (Q-A2).
- **Decision on Q-A1: how an approved call runs.**
  - It runs only when the agent re-sends the identical call. Re-sending is the only path that executes (I-53).
  - Check-back is read-only. Each surface has one: `GET /approvals/<id>`, the MCP tool `heel_status`, and `heel status <id>`. Each returns `pending | approved | denied | expired | executed` and never executes anything.
  - This fits code mode, where "the agent writes the rest as a new script" _[README "Code mode"]_.
- **Executes once.** In one transaction, an approved re-run moves the row from `approved` to `executed` and then calls upstream. A second identical call after that is evaluated as a new call (I-54).
- **Decision on Q-A4: TTLs.**
  - A pending request expires after 24 h.
  - An approval the agent hasn't used expires 1 h after the decision.
  - Both are configurable. A call on an expired request returns `expired` (I-55).
- **Decision on Q-A5: deny.**
  - Check-back returns `denied`.
  - Re-sending the identical call before the original 24 h TTL ends returns `denied` with the same id. This keeps an agent from spamming the approver.
  - After the TTL, a re-send creates a new request.

### Re-check when an approved call runs

**Decision on Q-A3.** An approved call goes through the whole pipeline again; it is not replayed blindly:

- pause, the hard denies and the hidden-target check;
- org rules;
- state checks;
- counts;
- your rules.

Then:

- The approval satisfies exactly one thing: an `ask` from the same rule, identified by its content hash. That rule is the one that created the request.
- If something above that rule now denies the call (a new deny rule, a failed state check or a pause), the call is denied and the approval stays `approved` until it expires.
- If a _different_ `ask` now matches first, a new pending request is created.
- Items are reserved only when the call executes.

### Standing approvals

- **Where they live.** SQLite, in `standing_approvals`. heel never writes them into your YAML. `heel rules show` and the approval page list them, positioned just above their parent rule _[STK §5]_.
- **Decision on Q-A6: scope.** The approver picks one of two scopes:  The duration is 1 h, 1 day, 7 days or 30 days, with a hard cap of 90 days.
  - _this exact call_: the same account, tool and arguments;
  - _everything this rule asks about_: the parent rule's whole match, limited to this agent.
- **Lapsing.**
  - A standing approval is bound to the parent rule's content hash (canonical `match` + `then`). If that rule is edited in any way (widened, narrowed or reworded) or deleted, the standing approval lapses: it stays in the audit log and stops matching.
  - Moving the rule without changing it keeps the approval, which moves with it.
  - This follows the Charming precedent that an approval lapses when what it covered changes _[README "Where this comes from"]_. It is stricter than I-16 requires.
- **What it can do.** It can only turn that rule's `ask` into `allow` (I-15). A deny above it still wins (I-14).
- **Org asks never stand (Q-A7).** They are approved once, by an org admin.
- **Revoking.** `heel approvals revoke <id>` or the page revokes one immediately.

### The approval page

- **Shown:**  Fields that rules match on (recipients, repo, command, ids) are never truncated (I-57). For email, there is also a rendered view of recipients, subject and body. Attachments are listed by name, type and size, not inlined (Q-N4) _[STK §7]_.
  - agent, run id, account, provider and tool/action;
  - the deciding rule's name, file and line;
  - the full canonical arguments.
- **Every decision needs a fresh passkey assertion** with user verification. That covers approve once, approve as standing, deny and resume. Pause is the one exception (see [Pause](#pause)). The WebAuthn challenge is bound to `approvalId` and the call hash, so a stolen session cookie can't decide anything _[STK §6]_.
- **Who can approve.**
  - The account's named approver, which is the owner by default.
  - On a single-user install, the owner approves their own agents. That is intended (Q-A9).
- **Decision on Q-N2: bootstrap and recovery.** `heel user enroll <user>` runs over the admin socket and prints a one-time enrollment URL that is valid for 15 minutes. Adding a device or recovering a lost passkey uses the same command. No agent-plane path exists (I-58).

### Notifications

- **Channels.** Web push (an installable PWA with VAPID), email over the operator's SMTP, and Slack DMs through a bot token _[STK §9]_.
- **Content.** Each message carries the agent name, the action, the account and a link. It never carries arguments or message content.
- Replying to a notification changes nothing (I-56). Slack messages have no buttons.

### Pause

- **Scopes:** `heel pause --agent <name>`, `--account <alias>`, or `--all`, plus the same controls on the page. Pause state lives in SQLite and survives a restart (I-04).
- **Effect.** Pause is checked before the rules and again when an approved call runs.
  - Every call in scope returns `paused` and reaches no upstream, even a call that was already approved (I-60).
  - A code-mode script stops at its next call (I-62).
  - Approving a request in scope is refused (I-61).
- **Decision on Q-A8: after resume.**
  - Pending requests become approvable again unless their TTL has passed.
  - Nothing that was called during the pause is replayed (I-63).
- **Decision on Q-N5: pausing is easier than resuming.**  The asymmetry is deliberate: pausing can only stop calls, never cause one.
  - Pause is one tap on a signed-in page, with no new assertion, so stopping an agent is never slowed by a passkey prompt.
  - Resume needs a fresh passkey assertion.

## Hiding

*Rules decide whether a call runs. `hide` decides what an allowed call returns. It applies to every allowed call on every account whose response shape heel knows (I-40).*

### Schema

*hide entries (README grammar)*

```yaml
hide:
  - email: { from: { any_of: [sarah@example.com] } }
  - email: { looks_like: [password_reset, login_code] }
  - email: { subject: { matches: "(?i).*offer letter.*" }, labels: { any_of: [HR] } }   # keys in one entry are ANDed
```

- **Fields.** `from`, `to` (To, Cc and Bcc together), `subject` and `labels` are plain checks with the same semantics as in [Rules](#rules-language). `looks_like` takes `password_reset` and/or `login_code`.
- **Decision on Q-L1:** `any_of` is a full operator, not a hide-only alias.
  - On a single value it means the same as `one_of`.
  - On a list it means at least one element is in the set.
  - It is valid in rules too.
- **How entries combine.** Keys inside one entry are ANDed. A message matching _any_ entry is hidden.
- **Decision on Q-H4:** v1 hides email only, on Gmail and Outlook. Any other top-level key under `hide` is a load error.
- **Unknown shapes.** On a surface whose response shape heel doesn't know (an unknown MCP server or an unknown CLI), `heel rules check` reports the hide entry as not enforceable. The call is still allowed or denied normally (I-46).

### What the agent sees

**Dropped, with one count** _(list · search · thread)_

Hidden messages are removed from the result before it is serialized. The id, sender, subject, snippet and body are all removed (I-41).

**Decision on Q-H1:** each response carries one placeholder, `{ hidden: { count: N } }`, plus a text line in the MCP text mirror. There are no per-row markers, because those would leak position and order.

In a thread list, a thread's snippet comes from its latest visible message. A thread whose messages are all hidden drops out.

**Denied** _(by id)_

The call is denied when it fetches, replies to, forwards, modifies, trashes or deletes a hidden message (I-42).

**Decision on Q-H3:** a batch that contains any hidden id is denied whole. The error doesn't say which id.

The deny reason is a generic `not available`, never "hidden".

**Never enters the sandbox** _(code mode)_

Filtering runs before results are fed back into Monty, so a script can't read a hidden item through any call (I-45).

**Decision on Q-H2: how heel recognizes a hidden id.**

- Every by-id call first reads the target's metadata and body prefix with heel's own credential, then evaluates `hide` on it.
- Verdicts are cached per `(account, messageId, hide-rules hash)` for 24 h. Any edit to the hide rules changes the hash, which invalidates the cache.
- If the lookup fails, the call is denied.

### `looks_like`

1. **Patterns first, tuned for recall** _[MCP §6]_:  A pattern hit hides the message.
   - reset and code keyword sets;
   - a code regex near a keyword;
   - URL heuristics (`reset`, `token=`, `magic`, `verify`, `otp`);
   - WICG `@origin #code` lines.
2. **Then the in-process classifier** scores subject, sender, the first 4 KB of plain-text body and the URLs. The message is hidden in any of these cases:
   - the classifier says reset or code;
   - the confidence is below threshold;
   - the classifier errors, times out (200 ms) or isn't loaded (I-44).
3. **Unparseable mail is hidden**: S/MIME, encrypted or image-only bodies.
4. `looks_like` can only add to the hidden set (I-43). Each message is judged on its own, so a reply that quotes a hidden message is hidden only if it matches too _[README "Hiding"]_.

> **Decision · classifier (Q-H5)**:
>
> - **What it is.** A small linear text classifier (hashed word and character n-grams with logistic regression). It runs in-process in TypeScript, and its weights are committed in the repo. It needs no Python, no network and no GPU.
> - **Release gate.** On the held-out evaluation set:  `pnpm eval:looks-like` prints both numbers, and CI fails below the gate.
>   - recall ≥ 0.99 for reset and code mail, with patterns and classifier combined;
>   - false-positive rate ≤ 5% on ordinary mail.
> - **Evaluation corpus.** Decided Nov 13: v1 uses synthetic reset and code mail generated from public provider templates, plus ordinary mail from a public corpus. Real, consented samples can be added later to make the gate stricter, but v1 doesn't wait for them.
> - **Why.** The research found no published small classifier or labelled dataset for this task _[MCP §6, §7 gap 9]_, so heel has to build and measure its own. A linear model keeps the stack TypeScript-only, as the reversal table in _[STK §12]_ allows.
> - **Reversal.** If the gate can't be met, switch to the Python sidecar from _[STK §12]_. heel never ships a classifier that is below the gate.

> **Note:** **Known leak, accepted:** the hidden count tells the agent that hidden messages matched its query. For example, `q="from:sarah"` returns `hidden: 1`. The README chose a count placeholder deliberately. The sender, subject and content still never leak.

Part 3

# Surfaces and providers

*How agents reach heel, and what heel knows about each service.*

## MCP and code mode

*Agents connect to heel's MCP endpoint and authenticate with a per-agent heel token. Each connected account appears as its own server. By default, though, agents see a single `run_code` tool _[README "Every way an agent reaches a system"]_.*

### Agent authentication

- **Decision: one static bearer token per agent.**  MCP authorization is optional, and the RFC 9728 OAuth resource-server flow is deferred _[MCP §1.6]_.
  - `heel agent add <name>` prints the token once. heel stores only its SHA-256 (I-03).
  - The token is sent as `Authorization: Bearer`. A token in a query string is rejected.
  - `heel agent rotate` and `heel agent revoke` take effect on the next call.
- **Provider tokens are refused.** heel never accepts a provider token from an agent and never forwards an agent's token upstream, because MCP forbids token passthrough _[MCP §0 fact 2]_. Any `Authorization` value that isn't a valid heel token gets a 401.

### Endpoints and tools

| Endpoint | Tools it lists | Default |
| --- | --- | --- |
| `/mcp` | • `run_code(code, run_id?)` • `heel_stubs(account?)`, which returns the generated `.pyi` stubs • `heel_status(approval_id)` | Code mode, the default |
| `/mcp?tools=direct` | Every tool of every account, prefixed `<account>__<tool>`, plus `heel_status` | For clients that work better with plain tools |
| `/mcp/<account>` | One account's tools, unprefixed, plus `heel_status` | One server per account, such as `gmail-work` |

- **Native tools.** Built-in providers expose heel's own tools, for example `send`, `reply`, `search` or `merge`. Their schemas and output schemas live in `src/definitions`, and each output schema includes the optional `hidden` count.
- **Passthrough tools.** A passthrough account re-serves the upstream server's tools under their raw names.
  - heel drops `outputSchema` from these, so a deny or pending result never breaks a schema the client expects _[MCP §1.3]_.
  - Every `tools/call` is mapped against the current upstream definition, not one cached at connect time. A tool that appears mid-run is default-denied until a rule names it _[MCP §1.4]_.
- **Listing.** Denied tools are listed anyway. Rules decide per call on the arguments, and a tool that is denied for one argument set may be allowed for another.

### Result shapes

**Decision.** Every outcome other than allow comes back as an `isError: true` tool result, so the model sees it and can correct itself _[MCP §1.2, §1.7 option A]_. The result carries both a `structuredContent` object and an identical JSON text block. JSON-RPC errors are reserved for protocol faults: an unknown tool or a malformed request.

*Non-allow results (structuredContent)*

```json
{ "status": "pending",  "approvalId": "apr_7Qx…", "check": "heel_status", "message": "Approval needed: email.send to bob@vendor.com. Re-send the same call once approved." }
{ "status": "denied",   "reason": "no rule matched", "rule": null }
{ "status": "denied",   "reason": "checks not passing", "rule": { "name": "merge-green", "file": "rules.yaml", "line": 14 } }
{ "status": "paused",   "scope": "agent" }
{ "status": "expired",  "approvalId": "apr_7Qx…" }
```

- **Tasks extension.** heel does not use the MCP tasks extension in v1 _[MCP §1.7 option B]_. Reversal: broad client support for it.
- **Elicitation.** heel never uses elicitation to approve anything, because the client answering would be the agent's own host _[MCP §1.7 option C]_.

### Upstream MCP servers

- **Remote servers.** heel is the OAuth client, using the SDK's `OAuthClientProvider`. Credentials are keyed by issuer _[STK §1, MCP §1.6]_.
- **Local stdio servers** are spawned under bubblewrap with the same egress allowlist treatment as CLIs (N-8).
  - **With credential hosts** (`--credential-host`, a subset of `--egress`), the server's credential variable holds an inert placeholder, and heel's egress proxy adds the credential to its requests to those hosts, as `--credential-auth` says: `bearer` (the default), `basic` or `header:<Name>`. The server never holds the credential (I-75). See CLI runner, "Credential delivery".
  - **Without them** (accounts connected before this existed), the credential is in the variable itself, where anything the server runs can read it. heel warns about each such account at startup and marks it `credentialDelivery: "env"` in `heel account list`; `heel account set <alias> --credential-host <host>` moves it without reconnecting, and stops the running server at once so its old environment doesn't outlive the change. Left out, `--credential-auth` keeps the account's current auth. Because the server held the credential until then, heel tells the operator to rotate it; `--credential-stdin` stores the new one in the same command.
  - Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`, so the runner sets it whenever a sandbox has egress, with `NO_PROXY=localhost,127.0.0.1,::1` so the sandbox's own loopback stays direct (minus any loopback name the egress list allows, which is the host's and goes through the proxy).
- **Decision: heel never forwards raw request bytes.** It re-issues each call through the SDK client using the post-rewrite arguments. `Mcp-Name` and `Mcp-Param-*` headers are therefore always consistent with what runs, and a rewrite such as a pinned `expectedHeadSha` can't trigger `HeaderMismatch` _[MCP §1.5]_.
- **Tool lists.** heel pages through each upstream `tools/list` itself and serves its own cursors _[MCP §1.1]_.

### Code mode

- **Language.** Scripts are the Monty Python subset, locked (N-6).
  - There is one host module per account, named after the alias with `-` turned into `_`: `gmail_work.send(...)`.
  - The module's `.pyi` stub is generated from the tool's JSON Schema.
  - A type error comes back to the agent before anything runs _[STK §2, §2.1 item 1]_.
- **Each host call** goes through the full pipeline as its own `Call`, with `surface: "code"`. How the script continues depends on the decision _[STK §2.1 item 2]_:
  - _allow_: the script resumes with the hidden-filtered result.
  - _deny_: the script resumes with a raised `HeelDenied`, which it may catch.
  - _ask_ or _paused_: heel never resumes the script. It discards the snapshot and returns the pending id with what already ran, so no later statement runs (I-59, I-62).
- **Decision on the worker boundary.** Code mode runs as its own heel subprocess (`heel codemode-worker`) under bubblewrap:  This works whether or not `@pydantic/monty` exposes control over how it spawns workers, which the research couldn't confirm _[STK §2.1 item 4]_.
  - no network namespace and no mounts;
  - a clean environment, talking to the main process over stdio;
  - clock and entropy turned off.
- **Limits per script, all configurable:**  Hitting a limit stops the script, which then returns its partial output and the reason _[STK §2.1 item 3, §10.3]_.
  - 200 host calls, with Monty's `max_suspensions` set to 201;
  - 30 s of `max_feed_duration_secs`;
  - 256 MB `max_memory`, under a 512 MB cgroup ceiling;
  - 1 MB of stdout.
- **Scripts at once.** Each script is its own sandbox, so heel limits how many run together: 4 per agent and, by default, one per GiB of the host's memory less one (2 to 16) in all, shared with `heel run` (`sandboxes.per_agent`, `sandboxes.total`). Over either limit `run_code` returns status `busy` at once, with nothing run; the agent sends it again later. Every ending gives the slot back. When the HTTP request is aborted, the script is stopped at once; an MCP cancel notification can't reach a stateless request, so then the slot is held until the script ends on its own.
- **Snapshots** are never persisted _[STK §2.1 item 5]_.

*run_code result*

```json
{
  "status": "pending",                       // completed | pending | paused | error | busy
  "approvalId": "apr_7Qx…",                  // when pending
  "stdout": "archived 12 newsletters\n",
  "calls": [
    { "account": "gmail-work", "tool": "modify", "decision": "allow", "items": 12 },
    { "account": "gmail-work", "tool": "send",   "decision": "ask" }
  ],
  "error": null                              // HeelDenied traceback, limit reason, or type-check output
}
```

## HTTP proxy

*The agent sends a plain HTTP request to heel and names the account in the path. heel attaches the credential and forwards the request to the account's one base URL.*

- **Shape.** `<METHOD> /http/<account>/<path>?<query>` with `Authorization: Bearer <heel token>`. heel forwards it to `<account.base_url>/<path>`.
- **The target host can't change.**
  - Absolute URLs, `..` segments after decoding, encoded slashes (`%2F`) and a `Host` override are all rejected with 400.
  - heel never follows redirects. A 3xx is returned to the agent with `Set-Cookie` stripped.
- **Agent credentials are stripped.** heel removes `Authorization`, `Cookie`, `Proxy-Authorization` and the account's configured auth header or query parameter from the agent's request before attaching its own. The strip is logged.
- **What rules see** _[README "Every way an agent reaches a system"]_:  `Call.tool` is `"<METHOD> <path-template>"`, or the raw path when no template matches.
  - `method`;
  - `path`, both raw and as the matched template;
  - `query`, as a decoded map;
  - `body`, parsed from JSON or `application/x-www-form-urlencoded`.
- **Decision: other body types.** For any other content type, `body` is unavailable. A rule with a body condition then doesn't match, and the call falls through toward the default deny.
- **Body limits.** Request bodies are capped at 25 MB. Responses are buffered whenever hiding applies.

### Definitions

- **Built-in providers.** The REST APIs of the eight built-in providers reuse the native definitions. For example:  Actions, recipients, items, state checks and hiding all behave exactly as they do over MCP. MIME that can't be parsed is denied.
  - `POST /gmail/v1/users/me/messages/send` is `email.send`, with recipients parsed from the `raw` MIME;
  - `PUT /repos/{o}/{r}/pulls/{n}/merge` is `github.merge`.
- **Other APIs.** `heel connect http --as <alias> --base-url … --openapi spec.yaml --auth bearer|basic|header:<name>|query:<name>`.
  - It accepts OpenAPI 3.0 and 3.1.
  - Path templates and `operationId` come from the file.
  - Optional `x-heel-action` and `x-heel-kind` extensions name the action. Without them, the operation has no `action` or `kind`, and rules match on method and path.
- **Hiding on an OpenAPI account** needs an `x-heel-hide` mapping on the operation. The mapping gives an items path and the `from`, `to`, `subject`, `labels` and body fields, as JSONPath expressions. Without it, hiding is not enforceable on that account (I-46).

### Status codes

| Outcome | Status | Body |
| --- | --- | --- |
| allow | The upstream status, passed through | The upstream body, after hiding. heel adds `Heel-Decision: allow` |
| ask | `202` | `{status:"pending", approvalId, check:"/approvals/<id>"}`_[README "Approvals"]_ |
| deny | `403` | `{status:"denied", reason, rule}` |
| paused | `423` | `{status:"paused", scope}` |
| expired | `410` | `{status:"expired", approvalId}` |
| bad or missing heel token | `401` | — |
| heel internal failure | `503` | `{status:"denied", reason:"heel error"}`. Fail-closed: nothing was sent upstream |

> **Note:** A `202` from heel and a `202` from the upstream API both mean "accepted". The `Heel-Decision` header tells them apart.

## CLI runner

*heel never runs a command on the agent's side. `heel run` sends the argv and working directory to heel. heel parses the command, decides, and runs it inside bubblewrap as the `heel` user. `gh` never holds its token: heel's egress proxy adds it on the wire. Another CLI gets one credential in its environment _[README "Every way an agent reaches a system"], [STK §3.2]_.*

### Client and topology

- **Usage.** `heel run [--account <alias>] [--json] -- <cmd> [args…]` reads `HEEL_TOKEN`, `HEEL_URL` and `HEEL_RUN_ID` from the environment and posts `{argv, cwd, runId}` to `/run`. stdout and stderr stream back.
- **stdin.** The command's stdin is `/dev/null`, so interactive commands are unsupported in v1.
- **Same host, Linux only (N-5).**
  - The `cwd` must sit under a work root configured for that agent (`heel agent add --workdir`). Otherwise the call is denied.
  - If user namespaces are unavailable, `/run` refuses every call and `heel serve` logs why _[STK §3.3 item 4]_.
- **The binary is heel's.** Each CLI is configured with an absolute path (`heel connect cli gh --bin /usr/bin/gh --account github`). `argv[0]` is only a lookup key, and an unconfigured command is denied. The agent can't swap the binary (I-34).

### Sandbox

- **bubblewrap options** _[STK §3.2]_:  The argv is built by a pure function and spawned without a shell, so `sh -c` is matched as `command: sh` (I-30).
  - new user, pid, ipc, uts and network namespaces;
  - `--die-with-parent`, `--new-session` and `--clearenv`;
  - read-only `/usr` plus the binary;
  - the `cwd` bound read-write at the same path;
  - a tmpfs `HOME` and `TMPDIR`;
  - a seccomp filter.
- **Network.** The only route out is heel's egress proxy, with a per-CLI host allowlist. For example, `gh` may reach only `api.github.com` and `github.com`. A client that ignores the proxy fails.
- **Limits.** 10 minutes of wall time, 1 GB of memory and 256 pids by default. Exceeding one kills the command and returns exit 70.
- **Commands at once.** Shared with code mode: 4 per agent, and by default one per GiB of memory less one (2 to 16) in all. Over either, `/run` answers 429 `busy` and nothing runs; `heel run` exits 75.
- **Credential delivery.** For `gh`, and for local MCP servers with credential hosts, the credential never enters the sandbox (I-75):
  - The program gets an inert, random placeholder (`heel-placeholder-…`) where it expects the credential.
  - For each credential host, heel's egress proxy terminates TLS with a CA made for that host in that sandbox: ECDSA P-256, its key only in heel's memory, name-constrained to exactly that host. A DNS name's subdomains are excluded (RFC 5280 alone would let `github.com` cover `uploads.github.com`); one CA per host is what lets `github.com` exclude its subdomains while `api.github.com` is a credential host too. The sandbox trusts it through `/heel/run/ca.pem` (the host's roots plus that CA), named by `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`, which a spec can't set. Every other allowlisted host is still tunnelled blind.
  - The proxy reads each HTTP/1.1 request and rewrites the auth position only: `Authorization` (bearer, `token` or basic userinfo) or one named header. That header must be absent or exactly the placeholder. Any other value, or two of them, is refused with `403 credential_mismatch`. An absent header goes upstream without a credential. The placeholder anywhere else (body, query, cookies, other headers) goes upstream unchanged, so an upstream that reflects requests can't be made to reflect the credential.
  - `Host` must name the CONNECT target and the request target must be a path (`403 host_mismatch`, `400 bad_target`). ALPN offers only `http/1.1`; h2c upgrades and CONNECT inside the tunnel are refused. A websocket upgrade is rewritten like any request, then piped.
  - A request body is re-framed as it was sent: a chunked body goes upstream chunked, whatever the method, so nothing inside it can be read as a second request. A transfer coding other than plain `chunked` is refused (`400 bad_framing`), as is a body on an upgrade.
  - Only final statuses 200 to 599 are passed on, with the standard reason phrase, never the upstream's; anything else becomes `502 upstream_bad_response`.
  - Deadlines: a CONNECT head must arrive within 10 seconds, each request's headers within 30 seconds, and a tunnel idle for 2 minutes is closed. One proxy holds at most 64 client connections; more get `503`. A client that leaves before heel has read the credential gets nothing sent on its behalf, and closing the proxy closes every upstream connection too.
  - The upstream is dialled at the address the egress decision checked, and its certificate is verified for the target host.
  - The credential is read from the vault for every request, so a refreshed OAuth token takes effect at once, and a disconnected account stops working mid-run (`503 credential_unavailable`). So does a pause: before each request the proxy asks whether a pause covers it (for `heel run`, the call's agent, owner, account or provider; for a local server, which keeps running between calls, a global, owner, account or provider pause).
  - Responses are scrubbed of the credential's predictable forms, its base64 at all three byte alignments, and the exact auth value heel sent (for basic auth, base64 of a user name the sandbox chose followed by the credential): headers always, bodies when unencoded (heel asks for `Accept-Encoding: identity`).
  - URL query parameters are never a credential position here: an account whose API wants one can't use this mode.
  - **Not covered.** Code in the sandbox can still *use* the credential against the credential hosts for as long as the sandbox runs; it just can't take it away. An upstream that echoes the credential in an encoding heel can't predict defeats the response scrub. Commands that fetch secrets from the server stay hard-denied.
- **Output scrub.** Every occurrence of the credential value in stdout or stderr is replaced with `[redacted by heel]`, along with its base64, base64url and hex forms. For a CLI that holds its credential this is a backstop, not a boundary: code that can run in the sandbox can re-encode it.

### Parsing known CLIs

**Decision: v1 parses `gh` and `kubectl`.** These are the README's examples, and the only CLIs the research covered. Every other CLI is unknown. For an unknown CLI:

- rules match `cli.argv` raw;
- nothing runs until a rule allows it (I-33);
- `heel rules check` warns that heel can't see what the command does.

|  | `gh` | `kubectl` |
| --- | --- | --- |
| Finding the verb | The first word must be a built-in command. Aliases and extensions are denied. Only flags after the command path are accepted _[MCP §5.2]_ | A full table of global flags with their arity, so `-n prod delete pod x` parses as `delete`. Unknown flags and unknown verbs (plugins) are denied _[MCP §5.1]_ |
| Hard denies: print credentials (I-31) | `auth token`, `auth status -t/--show-token`, and `--jq/-q` on any command: gh runs jq with its environment loaded, so `$ENV.GH_TOKEN` and `env` read the token, and a transform of it gets past the output scrub. `--template` stays allowed: gh's template functions read neither the environment nor files | `config view --raw/--flatten`, `create token`, `get` or `describe secret(s)`, `proxy`, `port-forward` |
| Denied: redirect or debug | `--hostname`; `GH_HOST`, `GH_REPO`, `GH_DEBUG` and `GH_CONFIG_DIR` are set by heel and never inherited | `--server`, `--kubeconfig`, `--kuberc`, `--context`, `--cluster`, `--user`, `--token`, `--as*`, `--username`, `--password`, `--insecure-skip-tls-verify`, `-v/--v` |
| Denied: defeats a check | `pr merge --admin` and `--auto` under `checks: passing`_[MCP §4]_ | — |
| Denied: runs repo code | `pr checkout`, `repo clone`, `repo sync`. Each invokes git in the cwd with `GH_TOKEN` set, and hooks would see it _[STK §3.3 item 2]_ | `exec`, `cp`, `debug`, `attach`. Each is mapped to its own action, denied by default |
| Mapping | `gh api` becomes `github.api` and is denied unless a rule names it. `pr merge` becomes `github.merge`, and heel injects `--match-head-commit H` | The verb becomes the action (`kubectl.delete`), with `-n` as the namespace |
| Credential delivery | `GH_TOKEN` is a placeholder; heel's egress proxy puts the token in the `Authorization` header of requests to `api.github.com` and `github.com`, and to `uploads.github.com` (release assets, comment attachments) when the operator added it to `--egress`. These are GitHub's hosts gh itself sends its token to; no other `--egress` host ever gets it | A generated kubeconfig in the sandbox's tmpfs, with `KUBECONFIG` pointing at it and `KUBECTL_KUBERC=false` |

### Exit codes

- **The command ran.** Its own exit code is passed through unchanged.
- **It didn't run.** `heel run` writes one line, `heel: {"status":…}`, to stderr and exits with a sysexits code:

| Outcome | Exit |
| --- | --- |
| pending approval, or busy (too many commands and scripts running; `/run` answers 429) | 75 (`EX_TEMPFAIL`) |
| denied or expired | 77 (`EX_NOPERM`) |
| paused | 69 (`EX_UNAVAILABLE`) |
| heel error, sandbox limit or no namespaces | 70 (`EX_SOFTWARE`) |
| usage error | 64 (`EX_USAGE`) |

> **Note:** A command can exit 75 or 77 on its own. When it matters, the agent should read the `heel:` stderr line or pass `--json`. The README promises "a CLI exit code" but not which one, so this is a decision.

## Built-in providers

*Each built-in definition is one module in `src/definitions/<provider>`. It holds the native tools and their schemas, the action each tool maps to, how recipients and items are derived, the state checks and the hide shape, and the tools that persist after revocation (I-20, I-70). The README names eight providers _[README "Built-in definitions"]_. The research went deep on three of them.*

> **Evidence depth**:
>
> - **Gmail, Outlook and GitHub** are specified from primary API research _[MCP §2, §3, §4]_.
> - **Calendar (Google and Outlook), Slack, Linear, Notion and Stripe** were not researched this session. For those five, this spec fixes the action catalogue and the persistence categories. The concrete endpoints are an implementation deliverable: each definition has to cite the official API reference and the version it was written against (acceptance criterion P-5).

### Email: Gmail and Outlook

| Native tool | Action, kind | How heel executes it |
| --- | --- | --- |
| `search`, `get_message`, `get_thread`, `list_labels` or `list_folders` | —, read | Gmail `messages.list` then `get`, and `threads.get`. Graph `/me/messages`. Hide filters the results (I-40, I-41) |
| `send` | `email.send`, write | • heel builds the MIME itself from `{from, to[], cc[], bcc[], subject, body, html?, attachments?}`. • `from` has to be in `sendAs.list` (Gmail) or be the mailbox (Outlook). Otherwise the call is denied. • There is no default `from`: the agent must name it, and the account it calls is the only mailbox it can send from (I-74). |
| `reply`, `reply_all`, `forward` | `email.send`, write | • **Gmail.** heel reads the original message and derives the recipients itself: ◦ reply goes to `Reply-To`, or else `From`; ◦ reply-all adds the original `To` and `Cc`, minus the account's own addresses; ◦ forward goes to the explicit `to`. heel then sends with `threadId`, `In-Reply-To` and `References` set _[MCP §2.1]_. • **Outlook.** **Amended in D9b:** heel derives the recipients the same way as for Gmail, from the original message's Reply-To, From, To and Cc. It composes the MIME itself and sends it through `sendMail`. Graph's `createReply`, `createReplyAll` and `createForward` exist, but their docs don't say which recipients they fill in, so heel doesn't depend on them. |
| `create_draft`, `update_draft`, `delete_draft` | `email.draft`, write | Drafts never send anything. Gmail `drafts.delete` is permanent, but it removes only a draft, so it is not counted as `email.remove`_[MCP §2.1]_ |
| `send_draft` | `email.send`, write | **Decision.** heel reads the draft as raw MIME and checks it. It sends _those exact bytes_ through `messages.send` (Gmail) or `sendMail` with a MIME body (Outlook), then deletes the draft. This closes the gap between checking a draft and sending it, which neither API can do conditionally _[MCP §7 item 1]_ |
| `archive`, `trash`, `delete`, `move`, `modify_labels`, `batch_modify`, `batch_delete` | `email.remove` when the call removes, otherwise `email.label`; write | `email.remove` covers: • trash and delete; • adding the TRASH or SPAM label; • removing INBOX (an archive); • a move to `deleteditems`, `junkemail`, `archive` or `recoverableitemsdeletions`. Items are expanded per [Counts](#counts-and-state-checks). Folder names are resolved through heel's own folder lookup, never by display name _[MCP §3.6, §7 item 5]_ |
| `create_filter` or `create_rule` | `email.filter`, write. When the filter forwards, it is also `email.send` and `persistence` | Gmail `settings.filters.create`; Graph inbox `messageRules` |
| Persistence (I-70) | Each of these is denied unless a rule names it: • forwarding addresses and auto-forwarding; • a filter or message rule that forwards or redirects; • a send-as alias; • delegates; • Graph change-notification subscriptions. |

### GitHub

- **Actions.**  `repo` is always set.
  - `github.read` (read) for PRs, issues, contents, checks and diffs;
  - `github.comment`, `github.pr.create`, `github.pr.update`, `github.issue.create` and `github.issue.update`;
  - `github.push` for contents and refs;
  - `github.merge`;
  - `github.api` for `gh api` and raw HTTP paths that have no mapping.
- **Merge.** `github.merge` uses the synchronous `PUT …/pulls/{n}/merge` with `sha=H` _[MCP §4]_. `merge-async` and `bypass_rules` are never offered.
- **Persistence (I-70).** Each of these is denied unless a rule names it:
  - creating webhooks;
  - deploy keys;
  - adding collaborators;
  - Actions secrets and variables;
  - a contents write under `.github/workflows/`, which is a scheduled automation.

### Calendar (Google and Outlook), Slack, Linear, Notion, Stripe

| Provider | Actions | Fields rules can see | Persistence category (I-70) |
| --- | --- | --- | --- |
| Google Calendar and Outlook calendar | `calendar.read`, `calendar.event.create`, `calendar.event.update`, `calendar.event.delete` (one action set for both) | `recipients` = attendees, because invites send email. `calendar` id | ACL or sharing grants; push-notification channels and Graph subscriptions |
| Slack | `slack.read`, `slack.post`, `slack.update`, `slack.delete` | `channel`, and whether the channel is shared externally | Incoming webhooks; app installs; scheduled messages |
| Linear | `linear.read`, `linear.issue.create`, `linear.issue.update`, `linear.issue.delete`, `linear.comment` | `team`, `project` | Webhooks; API keys; OAuth apps |
| Notion | `notion.read`, `notion.page.create`, `notion.page.update`, `notion.page.delete` | parent page or database id | Sharing or public links |
| Stripe | `stripe.read`, `stripe.refund`, `stripe.payment.create`, `stripe.customer.update`, `stripe.subscription.update` | `amount`, `currency`, `customer` | Webhook endpoints; restricted API keys |

> **Note:** The action names above are this spec's decision. The concrete endpoints and tools behind each one have to be verified against official documentation when they are built (P-5). If a category turns out to have no API, the definition says so explicitly rather than leaving it silent.

## Teams, audit and rule drafting

*v1 supports one organization per install. People sign in through the organization's OIDC provider, but every decision still needs a passkey. Admins set the ceiling, and each account's owner approves the calls made on it _[README "For teams"]_.*

- **Data model.** Every row carries `org_id`, and every agent, account and rules file carries `owner_id`. Multi-org is out of scope, but the schema doesn't block it.
- **Sign-in.**
  - With `oidc:` configured in `heel.yaml` (issuer, client id, groups claim), the human plane signs people in through OIDC using the authorization code flow with PKCE.
  - Without it, the install is single-user and passkey-only. The first user is enrolled over the admin socket.
  - An OIDC session never decides anything on its own. Every decision still requires a fresh passkey assertion from a passkey enrolled to that OIDC subject (I-56).
- **Roles** come from IdP groups through `roles: { admin: [group…], member: [group…] }`:  Group membership is re-read at each sign-in. A user removed from the IdP loses access when their session ends, and sessions last at most 12 h.
  - _admin_ edits `org-rules.yaml`, pauses anything, decides org asks, and assigns approvers;
  - _member_ owns agents and accounts and edits their own rules file.
- **Who may use an account.** An account is connected by its owner and can be shared with named users or groups. An agent may call an account only if the agent's owner may use it. Otherwise the call is denied before rules run.
- **Approvers.**
  - Each account names its approvers: `heel connect … --approver <user|group>`. The default is the owner.
  - A GitHub account can name approvers per repo: `approvers: { "acme/web": [alice] }`.
  - The approval goes to those people, not to admins. An admin can reassign approvers but can't approve a call on an account where they aren't an approver.
  - An org ask goes to admins.
- **Which rules apply.** First the org rules, then the rules of the _agent's owner_. Hide entries come from the org file and from the account owner's file (see [Rules](#rules-language)).
- **Audit.** One append-only table. The code has no update or delete path, and records are kept for 400 days by default (I-73).
  - Export: `heel audit export --since … --format jsonl`.
  - Optional SIEM sink: batched HTTPS POSTs of JSON Lines, retried with backoff. If the sink is down, nothing is decided differently, and a backlog alert goes to admins.
- **Rule drafting** _[README "You can describe a rule in words"]_.
  - `heel rules draft "<words>"` and a box on the rules page send a configured model three things: the description, the rules JSON Schema, and the names of the caller's accounts and actions. They never send call data, messages or audit rows.
  - The model is any OpenAI-compatible endpoint set in `drafting:`. Without one, drafting is off and nothing else changes (I-17).
  - The draft is validated against the schema, shown as a diff alongside the results of `heel rules test`, and saved only when a person saves it. It is never saved automatically.

Part 4

# Build

*Failure behavior, deliverables with acceptance criteria and tests, and how the work lands.*

## Fail-closed behavior

*When heel can't decide something safely, the call doesn't run. Every row below is a test in D3 or in the deliverable that owns the failing part. The baseline comes from _[STK §10.3]_ and is extended here to the surfaces and providers this spec adds.*

| Failure | What the agent gets | What heel records and does |
| --- | --- | --- |
| heel is down | The connection fails on every surface | Nothing reaches any upstream, because only heel holds credentials (I-01) |
| Any exception between normalizing the call and executing it | denied (`internal`) | An audit row if the store can be written. The error log never includes argument values |
| SQLite read or write fails, or the disk is full | denied | A call never runs unless its count reservation and audit row have been committed first. Admins are alerted |
| A state lookup (`all_in_thread`, `checks: passing`) errors or times out after 5 s | denied, with reason `state_check_unavailable` | The condition is never treated as false so a later rule can match. The whole call is denied _[STK §13 N-1]_ |
| The upstream returns an error, or times out after 60 s | The upstream error, passed through with credentials scrubbed | The items stay counted, because the call may have had an effect (see [Counts](#counts-and-state-checks)). The approval is consumed |
| The upstream connection drops after the request was sent | `upstream_outcome_unknown` | Counted and consumed, as above. heel never retries a write by itself |
| An OAuth refresh fails or a grant is revoked | denied on that account (`reconnect_required`) | The account is marked for reconnecting and the owner is notified. Other accounts are unaffected |
| The vault key is missing, or a credential won't decrypt | denied for everything | `heel serve` refuses to start the agent plane |
| A rules file is invalid at boot | denied for everything | The human plane still starts, so people can fix the file and pause agents |
| A rules file is invalid on reload | The last valid set keeps deciding | Admins are alerted, and the error is shown on the rules page and by `heel rules check` |
| The `looks_like` classifier errors, times out, isn't loaded or is unsure | The message is hidden | Counted in a metric (I-44) |
| A message can't be parsed for hiding | Hidden, as if a rule matched it | See [Hiding](#hiding) |
| A response can't be parsed on a surface where heel knows the shape | denied, with reason `response_unparseable` | Partial results are never passed through |
| The code-mode worker crashes or hits a limit | The script stops and returns the output so far plus the reason | Calls that already ran stay counted. The script never retries |
| bubblewrap or user namespaces are unavailable | `heel run` and code mode are refused | `heel serve` logs the reason at boot. MCP and HTTP keep working _[STK §3.3]_ |
| The notification channel fails | Still pending. The id is valid | heel retries with backoff. The approval page still lists the request |
| The SIEM sink is down | No change | The local audit log is the record of truth. A backlog alert goes to admins |
| The drafting model is unreachable | No change. It is never on the decision path | Drafting shows an error (I-17) |

## Deliverables and acceptance criteria

*There are fourteen deliverables, grouped by capability. Each one is accepted when every criterion below holds and the tests that prove it pass in CI. Each criterion cites the invariant it proves (`I-xx`, from _[REQ invariants]_) or the section of this spec that defines it.*

### How the tests are layered

- **Unit and property tests** (Vitest, plus fast-check for properties) cover the pure core: matcher, ordering, counts, hashing, normalization, the hide filter, argv building and schema errors _[STK §11.3]_.
- **Integration tests use fake upstreams wired in-process.** The agent is a real MCP `Client` pointed at heel's handler, and fake MCP servers are reached through `handler.fetch`, so there is no port and no mock transport _[STK §11.3]_. Provider fakes are recorded HTTP fixtures served from an undici `MockAgent`. One stdio fake runs as a real subprocess.
- **Linux end-to-end tests** exercise the CLI runner and code mode under real bubblewrap on the GitHub Actions Ubuntu runner, with user namespaces enabled.
- **Browser tests** drive the approval page with Playwright and a virtual WebAuthn authenticator. That combination comes from training data and wasn't checked this session; D4 confirms it works, or replaces it.
- **CI gates on every PR:**
  - `biome ci`, `tsc --noEmit` and every test layer;
  - drift in the generated `schema/heel-rules.schema.json`;
  - the `looks_like` evaluation gate;
  - MCP conformance, which is non-blocking at first _[STK §11.3, §11.4]_.
- **Invariant coverage.** Every `I-xx` listed below has at least one test tagged with its id, for example `it("I-13: org deny beats approvals", …)`. `pnpm test:invariants` fails if a listed id has no tagged test.

### Deliverables

| ID | Deliverable | Acceptance criteria | Tests that prove it |
| --- | --- | --- | --- |
| D1 | **Foundation** • Repo toolchain and CI • `heel.yaml` loader • SQLite schema and migrations • Vault • Agent tokens • Admin socket • Audit table • `heel serve` boot | • A missing, unknown or revoked token is rejected before rules run (I-03). • Counters, pending and standing approvals, and pause state survive a restart (I-04). • Credentials are encrypted at rest and never written to logs (I-02). • Every decision kind writes a complete audit row (I-73). • The admin socket is mode 0600, and a non-owner connection is refused. | `test/store/restart.test.ts`, `test/auth/agent-token.test.ts`, `test/vault/*.test.ts`, `test/audit/record.test.ts`, `test/admin/socket-perms.test.ts` |
| D2 | **Rules engine** • Zod schema and generated JSON Schema • Loading, validation and hot reload • Matcher • Watch mode • `heel rules check` and `heel rules test` | • A call that matches no rule is denied (I-10). • Evaluation is first-match in the README's order (see [Rules](#rules-language)). • An org `allow` is a load error (I-12), and an org deny wins over everything (I-13). • A check on an absent field doesn't match (I-18). • A state check on an unknown service is a load error (I-23). • A `watch: true` rule never decides a call (I-72). • Global watch relaxes only what [Rules](#rules-language) allows it to. • YAML errors report the file and line. • An invalid reload keeps the last good set. | • `test/rules/*.test.ts` (table tests per operator) • `test/rules/order.property.test.ts` (fast-check: an org deny is never overridden, and swapping overlapping rules changes the outcome) • `test/rules/reload.test.ts` • `test/rules/schema-drift.test.ts` |
| D3 | **Pipeline and counts** • Normalized call • Pipeline order • Canonical hash • Count reservations • Run ids • Fail-closed handling | • Counts sum items, and the count includes the current call (I-24). • A `per: hour` count ignores the run id (I-25). • A call with no run id never matches a `per: run` condition (I-26). • The approval hash is stable when arguments are reordered and changes when any argument changes (I-51, I-52). • Every row of [Fail-closed](#fail-closed-behavior) that this deliverable owns ends in a deny or a hide. | • `test/pipeline/order.test.ts` • `test/counts/*.test.ts` (including a 1,000-message batch) • `test/hash/canonical.property.test.ts` • `test/failclosed/*.test.ts` (kill the upstream, throw from a state lookup, make the DB read-only, corrupt the rules file) |
| D4 | **Approvals, standing approvals, pause and the human plane** • Passkeys • Approval page • Notifications | • An ask returns at once (I-50). • Repeats of the same call join one request (I-51). • Approving executes nothing by itself (I-53), and an approved call executes at most once (I-54). • Requests expire on their TTL (I-55). • Deciding needs a passkey assertion bound to the call hash, and notifications carry no approve action (I-56). • The page shows the full arguments (I-57). • An agent token can't reach the human plane (I-58). • Standing approvals follow [Approvals](#approvals-standing-approvals-and-pause) (I-14, I-15, I-16). • Pause and resume behave as specified (I-60, I-61, I-63). | • `test/approvals/*.test.ts` • `test/standing/*.test.ts` • `test/pause/*.test.ts` • `e2e/approval-page.spec.ts` (Playwright plus a virtual authenticator) • agent-browser screenshots and a WebM of approve, deny and pause |
| D5 | **MCP agent plane** • Per-account namespaces • Native tool registry • Upstream passthrough over HTTP and stdio | • Each call names exactly one account (I-74). • An unknown server's tool never matches `kind: read` (I-20). • No credential appears in any result (I-02). • With heel stopped, nothing reaches the upstream (I-01). • Pending, denied and paused results have the shapes in [MCP](#mcp-and-code-mode). | • `test/mcp/*.test.ts` (in-process client and fakes) • `test/mcp/stdio-upstream.test.ts` • a conformance job |
| D6 | **Code mode** • Generated stubs • `heel codemode-worker` under bubblewrap • Limits | • Each call in a script is counted separately (I-27). • Hidden items never enter the sandbox (I-45). • An ask stops the script, and `try/except` can't swallow it (I-59). • Pause stops the script at its next heel call (I-62). • Every attack in the escape corpus fails. | • `test/codemode/*.test.ts` • `e2e/codemode-escape.test.ts` (filesystem, sockets, environment reads, `eval` tricks, memory and loop bombs, too many host calls, a `try/except` around an ask) _[STK §11.3]_ |
| D7 | **HTTP proxy** and OpenAPI definitions | • Credential headers the agent sends are stripped, and heel attaches the real ones. • Hosts and paths outside the account's scope are denied. • Redirects are not followed. • Decisions return 202, 403 and 423 with the specified bodies. • Hide works on responses described by OpenAPI (I-40), and a hide rule on an unknown shape is reported at load time (I-46). | `test/http/*.test.ts`, `test/openapi/*.test.ts` |
| D8 | **CLI runner** (`heel run`), the `gh` and `kubectl` parsers, and stdio MCP servers under the runner | • No shell is used, so `sh -c` matches as `sh` (I-30). • Commands that print credentials are denied even under a broad allow (I-31). • Flags are parsed before matching (I-32). • An unknown CLI needs a raw-argument allow (I-33). • The agent can't swap the binary or read the credential environment (I-34). • `gh`, and a local MCP server with credential hosts, never receive the token's bytes (I-75). • Egress outside the allowlist fails. • Flags that redirect the endpoint are denied. • Exit codes follow [CLI](#cli-runner). | • `test/cli/parse-*.test.ts` • `e2e/runner/*.test.ts` (a fake CLI dumps its environment, cwd and `/proc`, and the test asserts the credential is absent) |
| D9 | **Email definitions** (Gmail and Outlook), `all_in_thread`, and hide with plain checks | • `email.send` covers send, reply, reply-all, forward and draft send on both providers, and `recipients` is to ∪ cc ∪ bcc plus derived recipients (I-19). • `all_in_thread` follows I-21. • `send_draft` sends exactly the bytes heel checked. • Hidden items drop out of results, with a placeholder (I-40, I-41). • Actions that target a hidden message are denied, including inside a batch (I-42). • Persistence tools are denied unless a rule names them (I-70). | • `test/definitions/gmail/*.test.ts` and `test/definitions/outlook/*.test.ts`, against recorded fixtures • `test/state/all-in-thread.test.ts` • `test/hide/*.test.ts` |
| D10 | **`looks_like`**: patterns, a linear classifier, and its evaluation set | • `looks_like` only ever hides (I-43). • When the classifier is unsure or down, the message is hidden (I-44). • On the held-out set, recall is at least 0.99 and the false-positive rate is at most 5% (see [Hiding](#hiding)). • Weights and the corpus manifest are committed. | • `test/lookslike/*.test.ts` • `pnpm eval:looks-like` as a CI gate |
| D11 | **GitHub definition** and `checks: passing` | • The merge passes the head SHA heel checked, and a 409 is reported as "head moved" (I-22). • A repo with no statuses isn't read as pending. • `--admin`, `--auto` and `bypass_rules` are denied. • GitHub persistence tools are denied (I-70). | `test/definitions/github/*.test.ts`, `test/state/checks-passing.test.ts` (head moves between check and merge; Actions-only repo) |
| D12 | **Calendar (Google and Outlook), Slack, Linear, Notion and Stripe definitions** | • **P-5.** Each definition cites the official API reference and version for every mapped endpoint. • Every action in [Providers](#built-in-providers) is mapped, or is explicitly marked unsupported with a reason. • Read tools are marked read (I-20). • The persistence categories are denied (I-70). | `test/definitions/<provider>/*.test.ts` against recorded fixtures, and a citation lint that fails when a mapping has no doc reference |
| D13 | **Teams, audit export and rule drafting** | • OIDC sign-in with PKCE. • Roles come from groups. • Approvals route to the named approvers, and an admin who isn't an approver can't approve. • Org asks go to admins. • An agent can't use an account its owner can't use. • JSONL export and the SIEM sink work. • Drafting never sees call data and is never on the decision path (I-17). | • `test/teams/*.test.ts` (a mock OIDC issuer) • `test/audit/export.test.ts` • `test/drafting/*.test.ts` (the model stubbed and also unreachable) |
| D14 | **Incident replays and the release** • OCI image • Docs • Example rules | • Each of the four README incidents replays end-to-end, as listed below this table, and the useful path in each still runs. • The OCI image starts with the example config. • The README's example rules load unchanged. | `e2e/incidents/*.test.ts`, a CI image smoke test, and `test/rules/readme-examples.test.ts` |

### The four incident replays (D14)

1. **claude-code #99453.** `email.send` returns pending and the upstream isn't called.
2. **claude-code #96004.** A send from `gmail-personal` to a client domain is denied.
3. **Kiro #8500.** An Outlook reply-all to a customer returns pending.
4. **OpenClaw inbox.** A run that trashes more than 20 messages hits ask, and pause stops the loop.

> **Note:** Each replay comes from the README's incident table _[README "Incidents heel would have stopped"]_.

## Delivery, locked decisions and risks

### Delivery

> **Delivery** (locked):
>
> - The work lands on a release branch, `release/heel-v0.1`, cut from `main` on Nov 13. Its draft release PR was [akhileshrangani4/heel#1](https://github.com/akhileshrangani4/heel/pull/1), reopened from the maintainer's account as [#50](https://github.com/akhileshrangani4/heel/pull/50).
> - Each deliverable, D1 to D14, is its own PR into that branch. A deliverable that turns out too large may be split, but never merged with another.
> - The release branch merges to `main` once, after D14's incident replays pass on it.
> - `main` stays README-only until then, so nobody installs a half-built gateway.

### Locked decisions

> **Product and architecture** (locked):
>
> 1. One TypeScript service on Node 26, shipped as an OCI image, with SQLite through Drizzle and the MCP SDK v2 ([Architecture](#architecture)).
> 2. Built-in providers are heel-native tools that call the provider APIs directly. Other MCP servers pass through, matched on their raw tool and argument names ([Decision](#decision-to-approve)).
> 3. Every surface normalizes into one call model and one pipeline. The approval hash is RFC 8785 JSON over agent, account, tool and arguments after any rewrite ([Call model](#call-model-and-normalization)).
> 4. Evaluation follows the README's order: org rules, then the owner's rules top to bottom, with each standing approval just above the rule that asked for it. A call that matches nothing is denied.
> 5. Org rules can only deny or ask. Org asks are approved once and never as a standing approval.
> 6. Global watch mode never relaxes:
>    - pause;
>    - org rules;
>    - credential-printing denies;
>    - persistence denies;
>    - denies on hidden targets;
>    - hiding itself.
> 7. Counts are taken when a call executes and are never refunded. A state lookup that fails denies the call.
> 8. An ask returns at once. An approval only takes effect when the agent re-sends the identical call: it runs once, and only after the rules are checked again.
>    - Pending requests last 24 h.
>    - An unused approval lasts 1 h.
>    - A standing approval lasts at most 90 days and ends when the rule it came from changes.
> 9. Every decision needs a fresh passkey assertion bound to the call hash. Pausing is one tap, while resuming needs a passkey.
> 10. Hiding fails closed: an unknown, unparseable or uncertain message is hidden. `looks_like` only ever hides, and it ships only if it passes its evaluation gate.
> 11. Code mode uses a Python subset run by Monty inside a separate `heel codemode-worker` under bubblewrap with no network. An ask or a pause stops the script because heel never resumes it.
> 12. The HTTP proxy is scoped per account, never follows redirects, and returns 202, 403 or 423 for pending, denied or paused.
> 13. The CLI runner runs on the same host as the agent, as a separate Linux user under bubblewrap, never through a shell. v1 parses `gh` and `kubectl`, and pending, denied and paused return exit codes 75, 77 and 69.
> 14. `send_draft` sends exactly the bytes heel checked and then deletes the draft.
> 15. v1 supports one organization per install. People sign in through OIDC, or with a passkey only on a single-user install. Approvals go to each account's named approvers, and the audit log is append-only.
> 16. The `looks_like` evaluation corpus for v1 is synthetic reset and code mail plus a public corpus of ordinary mail.

### Where this spec departs from its sources

| Source says | Spec does | Why |
| --- | --- | --- |
| The README says built-in definitions "map tools from different servers" | heel provides its own tools for the eight providers | Recipients, item counts and hidden-target checks all need reads only heel can do safely |
| REQ I-11 puts standing approvals in their own layer, before all user rules | Each standing approval sits just above the rule that asked for it, as the README says | The README is the higher-ranked source. I-11 is amended to match, and I-14 already assumes this position |
| The README and REQ I-71 say watch mode "lets every call through" | Watch mode relaxes only owner-rule and default-deny outcomes | Otherwise watch mode would be a way around the admin ceiling and the credential and persistence protections. You confirmed this on Nov 13, and I-71 is amended to match |

### Risks the plan must cover

| Risk | What covers it |
| --- | --- |
| Monty is young, and its worker controls may change _[STK §2]_ | Running it in its own worker process isolates heel from Monty's internals. The D6 escape corpus runs in CI. If Monty fails the corpus, code mode ships off by default rather than unsafe |
| User namespaces are restricted on Ubuntu 24.04 and later and under Docker seccomp _[STK §3.3]_ | heel probes at boot and refuses code mode and the runner, with a clear reason. The docs give the sysctl and the container flags |
| Five providers' APIs weren't researched | P-5 requires a citation for every mapped endpoint, plus recorded fixtures |
| Assumption: Outlook's reply-draft endpoints exist | D9 confirms them first. If they don't, Outlook falls back to the Gmail-style recipient derivation |
| Approval fatigue: people approving without reading | Standing approvals, watch mode for tuning rules, and the one-week watch check in the load-bearing assumption |
| The `looks_like` evaluation set may not reflect real mail | The release gate on a synthetic corpus, which you chose on Nov 13. Real samples can be added later without changing the gate |

### Open questions

No open questions. On Nov 13 you confirmed the narrowed watch mode and the synthetic `looks_like` corpus.
