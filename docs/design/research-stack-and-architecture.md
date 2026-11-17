> **Exported from the Obvious project `prj_rqc5uhH3`.** Source: *heel research — stack and architecture* (document `art_wgq2qFAj`), last updated 2026-11-13T19:54:42.065Z. Export date: 2026-11-17.

# heel research — stack and architecture

**Scope.** This is read-only research for building `akhileshrangani4/heel` from scratch. The repo is greenfield: `README.md` (208 lines, read in full), `LICENSE` (Apache 2.0), `.gitignore` and `assets/`. There is no code to inherit. Capability IDs (`C-xx`) and open-question IDs (`Q-xx`) refer to the companion document **heel research — requirements map** (`art_RNJqRJci`).

**How to read the evidence.** Each claim is tagged with where it came from:
- **[S#]** means I retrieved it on 2026-11-13. The source record in the appendix gives the URL, what it showed and how I fetched it.
- **(inferred)** means it is my own design reasoning.
- **(training data, not checked this session)** means general background I did not verify.

Every library version comes from a registry or release API queried on 2026-11-13.

> **Load-bearing assumption.** The recommended stack assumes heel can keep two isolation promises using components that run on heel's own host:
> - code mode runs "with no network and no credentials, so its only way out is heel";
> - the CLI runner ensures "the agent can't swap the binary or read the credential" **[S1]**.
>
> The proposed parts are a language-level interpreter (Monty) and Linux namespaces (bubblewrap).
>
> **What would confirm it:**
> - Monty's no-ambient-authority model **[S17]**.
> - An escape-attempt corpus and runner tests that pass in CI (§11).
>
> **What would break it:**
> - A Monty sandbox-escape advisory.
> - A deployment where heel cannot create user namespaces. Ubuntu 24.04+ restricts them by default **[S31]**.
>
> **Check before committing:**
> 1. heel can launch Monty's worker processes inside bubblewrap with no network.
> 2. bubblewrap works on the target hosts.
>
> **What the brief skipped.** The likelier leak paths are not sandbox escapes:
> - **Host functions heel exposes.** Monty's own docs call such a function "an unconstrained filesystem or network primitive that you wrote" **[S17]**.
> - **CLIs that send their credential to a destination the agent chose,** through a flag, a config file in the mounted working directory, or a git hook (§3.3).
>
> These shape the architecture more than the choice of interpreter does.

---

## 0. Recommendation in one screen

Build heel in **TypeScript on Node.js 26 LTS** (v26.13.1, LTS since 2026-11-10 **[S11]**). The pieces:

| Concern | Pick | Why, in one line |
|---|---|---|
| MCP server + client | `@modelcontextprotocol/server` / `client` 2.4.0 **[S3]** | Tier 1 **[S2]**. Documented `OAuthClientProvider` for remote servers **[S4]** and in-process testing via `handler.fetch` **[S5]** |
| Code-mode sandbox | **Monty** (`@pydantic/monty` 1.6.0) **[S22]**, workers wrapped in bubblewrap | No ambient authority **[S17]**, host functions plus `.pyi` stubs with a bundled type checker **[S21]**, hard limits **[S19]**, v1 stable **[S16]** |
| CLI runner | Separate `heel` Unix user + **bubblewrap** (v0.13.1 **[S29]**) + an egress allowlist proxy, Linux only | Unprivileged and scriptable. The pattern Anthropic's sandbox-runtime uses on Linux **[S31]** |
| Credentials | Envelope encryption with Node's built-in AES-256-GCM. OAuth via `openid-client` 6.9.0 **[S33]** | No native crypto dependency. Library documents the refresh-token grant, PKCE and DPoP **[S33]** |
| State | **SQLite** via `better-sqlite3` 13.1.1 + Drizzle 0.45.4. Postgres later through Drizzle's pg drivers **[S37]** | One file per self-hosted node. Single-writer transactions make count-and-reserve atomic |
| Passkeys | `@simplewebauthn/server` 14.1.0 + `/browser` 14.0.0 **[S38]** | Maintained pair that supports Node 22+ **[S38]** |
| Approval page | Server-rendered HTML with Hono 4.13.18 + a small client script **[S39]** | Smallest attack surface for the one page that must never be wrong |
| Rules YAML | `yaml` 2.9.1 (line/column errors) **[S40]** → Zod 4.6.7 schema → `z.toJSONSchema()` for editors **[S41]** | One schema source for validation, error messages and editor completion |
| Notifications v1 | Web push (`web-push` 4.0.0) + email (`nodemailer` 10.5.0). Slack (`@slack/web-api` 8.4.0) in v1.1 **[S43][S44]** | Push reaches a phone. Email reaches everyone. Every channel only links to the approval page |
| Distribution | **OCI image** (glibc base) + npm package. Node SEA single binary deferred | The README already requires heel on a separate server, container or user **[S1]**. SEA is still "Active development" **[S12]** |

**Cost:**
- The weakest single-binary story of the four languages.
- Agents write code-mode scripts in a Python subset while heel is written in TypeScript.
- Two native dependencies: Monty's worker binary and `better-sqlite3`.
- `heel run` is Linux-only in v1.

**What would reverse it** is in §12. The short version: if one static binary is a hard v1 requirement, or the team is fluent in Rust, choose **Rust**. It is the close runner-up.

---

## 1. Language and runtime

All four official SDKs are **Tier 1** on the MCP SDK page, along with C# and Ruby **[S2]**. They differ in how far their client-side OAuth support goes, in packaging, and in the libraries around them.

| | **TypeScript / Node 26** | **Go 1.27.4** | **Rust 1.100.0** | **Python** |
|---|---|---|---|---|
| MCP SDK (latest) | server/client **2.4.0**, 2026-10-23, Apache-2.0 **[S3]** | go-sdk **v1.8.0**, 2026-09-04 **[S7]** | rmcp **3.10.0**, updated 2026-11-12 **[S8]** | mcp **2.3.0**, MIT **[S9]** |
| Server role, stdio + Streamable HTTP | Yes. stdio docs and sources in repo **[S6]**, `createMcpHandler` is a fetch handler **[S5]** | Yes, `StdioTransport` **[S7]** | Yes, stdio and stateless Streamable HTTP **[S8]** | Yes: stdio, Streamable HTTP and SSE **[S9]** |
| Client role + OAuth to remote servers | `OAuthClientProvider` as `authProvider`. The SDK runs discovery and registration and calls your redirect hook. It tells you to key credentials by issuer **[S4]** | **"Client side OAuth has experimental support"** **[S7]** | Full OAuth 2.1 client: PKCE, RFC 8707/9728/8414, dynamic client registration, CIMD, **automatic token refresh** **[S8]** | Client OAuth guide and example exist in the repo (I saw the paths, not the contents) **[S9]** |
| Spec 2026-07-28 (stateless, no sessions) **[S10]** | Version negotiation `mode: 'auto'` documented **[S5]** | v1.7.0+ lists 2026-07-28 **[S7]** | README links the 2026-07-28 spec **[S8]** | not checked |
| Testing with fake upstreams | In-process: client transport `fetch` → `handler.fetch`, "no port, no socket, no mock transport" **[S5]** | not checked | not checked | not checked |
| Single binary | Weakest. SEA "Stability 1.1 – Active development". Native addons must be written to a temp file first **[S12]**. Bun **[S13]** and Deno **[S14]** compile and cross-compile, but heel's native addons complicate that | **Best.** Static binaries. GoReleaser v2.20.2 **[S15]** | **Good.** cargo-dist v0.34.0 **[S15]** | Poor. Container image is the realistic route |
| Code-mode sandbox | Monty JS binding **[S22]**, quickjs-emscripten **[S24]** | goja has interrupt support but no documented memory limit **[S28]**. gomonty: 13 stars, last push 2026-03-29 **[S28]** | Monty native (`monty-pool` 1.6.0) **[S22]**, rquickjs 0.14.0 **[S28]** | Monty native (`pydantic-monty` 1.6.0) **[S22]** |
| WebAuthn | SimpleWebAuthn 14.1.0 / 14.0.0 **[S38]** | go-webauthn v0.18.2 **[S38]** | webauthn-rs 0.6.2 **[S38]** | webauthn 3.0.1 **[S38]** |
| OAuth library for provider connects | openid-client 6.9.0 / oauth4webapi 3.8.8 **[S33]** | not checked | rmcp `auth` covers MCP servers only **[S8]** | not checked |
| `looks_like` classifier (C-13) | onnxruntime-node 1.31.1, transformers.js 4.3.2 **[S45]** | not checked | not checked | Strongest ML ecosystem (training data, not checked this session) |

**Verdict: TypeScript/Node.** Rust is a close second.

- **Go loses** on the two things only heel needs:
  - client OAuth to remote MCP servers is still experimental **[S7]**;
  - no Go sandbox candidate has both documented memory limits and maturity **[S28]**.
- **Python is viable.** Monty is native there and the ML ecosystem helps `looks_like`. But it has the worst distribution story, and the approval page still needs browser JavaScript.
- **Rust has the strongest MCP OAuth client** **[S8]**, native Monty and a single binary.
- **What tips the choice to TypeScript** is development speed on the parts of heel that change most: the rules language, provider definitions and the approval page. Two concrete reasons:
  - One schema language (Zod) serves both the MCP SDK's tool schemas (its testing example declares `inputSchema: z.object(...)` **[S5]**) and the rules file **[S41]**.
  - The approval page's browser code shares a language and a library pair with the server **[S38]**.

**Distribution follows from the trust boundary.** The README says heel "has to run where the agent can't reach it, for example a separate server, container, or user" **[S1]**. So the first-class artifacts are:
- an OCI image (use a **glibc** base, because Monty ships Linux builds only for `linux-x64-gnu` and `linux-arm64-gnu` **[S22]**);
- a systemd unit for running heel as a dedicated user;
- the npm package.

A Node SEA single binary waits until SEA stabilises **[S12]**. Monty's Linux package alone carries a 32,377,536-byte `monty` worker binary and a 10,450,176-byte `.node` addon **[S22]**, and both would have to be extracted at runtime.

---

## 2. Code-mode sandbox (`run_code`, C-09)

Requirements from the README **[S1]**:
- no network, no credentials, "its only way out is heel";
- typed definitions per account (`gmail_work.send(...)`);
- every inner call goes through the rules;
- a paused agent's script "stops on its next call";
- on `ask`, "the script stops there and returns the pending id along with what already ran".

The last point needs **stop and return partial output**, not suspend-and-resume. The agent writes the rest as a new script.

| Option | No net / no fs | Host async functions + typed definitions | Stop on pending, partial results | Resource limits | Maturity / security posture |
|---|---|---|---|---|---|
| **Monty** (Python subset, Rust) | Language-level: "the capability does not exist in the bytecode VM". No container, seccomp or VM. Clock and entropy are readable by default but can be disabled **[S17]** | Host functions suspend the VM. Futures and `asyncio.gather` are supported **[S18][S20]**. `type_check_stubs` and per-module `.pyi` stubs, checked by bundled `ty` **[S21]** | `feed_start` hands back a `FunctionSnapshot` at every host call. Heel can simply not resume. Snapshots also serialise to bytes **[S18]** | `max_memory`, feed and turn durations, recursion depth, `max_suspensions` (default 1000, **cannot be disabled**), total sleep **[S19]** | v1.0 declared stable **[S16]**. Bug bounty **[S17]**. 1.6.0 released 2026-11-11 **[S22]**. Young, and language-level isolation only |
| **quickjs-emscripten** (QuickJS in WASM) | No host I/O unless you inject it ("Safely evaluate untrusted Javascript") **[S24]** | `newPromise`, asyncify for synchronous-looking async host calls **[S24]**. No type checker: you would need a separate `tsc` pass against generated `.d.ts` (inferred) | Possible by never settling the host promise and disposing the context (inferred) | `setMemoryLimit`, `setMaxStackSize`, `setInterruptHandler` **[S24]** | 0.32.0 on 2026-02-16. 1,745 stars, last push 2026-07-23 **[S24]** |
| **isolated-vm** (V8 isolates) | Isolate has no Node APIs unless passed in (training data, not checked this session) | Via references. The README warns that leaking `Reference`/`ExternalCopy` instances is "usually trivial" to turn into full process control **[S23]** | Possible (inferred) | Memory limit and timeouts (training data, not checked this session) | **"Maintenance mode"** **[S23]**. npm 7.0.2 on 2026-10-30 **[S23]** |
| **Deno** subprocess with permissions | Permission flags. Deno's own docs say untrusted code needs more than one layer, including OS sandboxing or a VM **[S25]** | IPC bridge you build (inferred) | Kill the process (inferred) | OS-level only (inferred) | Deno 2.9.8 **[S11]**. Adds a second runtime to ship |
| **workerd** | "Not a hardened sandbox". Run it inside a VM for possibly malicious code **[S26]** | Bindings | — | — | Ruled out by its own README |
| **Node `vm` / permission model** | Node's permission model "does not protect against malicious code" **[S27]** | — | — | — | Ruled out |
| **goja** (Go) | No I/O unless injected (training data, not checked this session) | Go functions | `vm.Interrupt` **[S28]** | No memory limit documented **[S28]** | Only relevant if the core were Go |

Monty's own benchmark (vendor-published, single source) puts a new sandbox plus a ten-command agent run at 1.20 ms, against 200 ms for WASI/wasmtime and 900 ms for local Docker **[S16]**.

**Verdict: Monty, wrapped in an OS sandbox. quickjs-emscripten is the fallback if scripts must be JavaScript or TypeScript.**

Monty is the only candidate built for this exact job ("code that a language model wrote and nobody reviewed" **[S17]**) that also covers the other needs:
- stub-checked host APIs, so a type error comes back to the model as a retry prompt instead of failing halfway through **[S21]**;
- an engine-enforced limit on host round trips **[S19]**;
- a natural stop point at every host call **[S18]**.

The README does not name the script language. `gmail_work.send(...)` reads the same in Python and JavaScript (inferred). The spec must lock this choice.

### 2.1 Design notes for code mode (inferred unless cited)

1. **One host module per connected account.** `gmail_work`, `github`, and so on become `ExternalModule`s whose `.pyi` stubs are generated from each upstream tool's JSON Schema **[S21]**. The stub generator (JSON Schema → `TypedDict`) is heel code to write.
2. **How each decision maps to the sandbox:**
   - **allow:** resume with the result *after* `hide` has filtered it.
   - **deny:** resume with an error.
   - **ask or paused:** **do not resume**. Discard the snapshot and return stdout so far, the list of executed calls and the pending id. If heel raised an exception instead, the script could catch it with `try/except` and keep going, which breaks "the script stops there" **[S1]**.
3. **Set limits explicitly:**
   - `max_suspensions` must be at least heel's own per-script call budget. The default of 1000 cannot be disabled **[S19]**, and a 500-message loop is 500 host calls.
   - `max_memory` must sit under a cgroup ceiling, because it is "not a ceiling on process RSS" **[S19]**.
   - Use `max_feed_duration_secs`. Monty's clock pauses while suspended on the host **[S19]**, so heel's upstream latency doesn't count against the script.
4. **Defence in depth.** Monty is language-level only **[S17]**. Run its worker pool under bubblewrap with no network namespace and no mounts, and with a clean environment that never contains a credential. **Unverified:** whether `@pydantic/monty` lets heel control how workers are spawned. Its package has `nodeFactory` and `poolOptions` modules **[S22]**, but I did not read their API. If it can't, run code mode as its own heel subprocess under bubblewrap.
5. **Don't persist snapshots in v1.** If they are ever persisted, Monty requires provenance checks such as a MAC before restoring **[S18]**.
6. **Turn off clock and entropy access** where scripts don't need them **[S17]**.

---

## 3. CLI runner isolation (`heel run`, C-11)

What the README requires **[S1]**:
- Execute the binary directly, never through a shell.
- Run it "in a runner heel controls, not on the agent's machine, with the agent's working directory mounted in".
- The agent can't swap the binary or read the credential in the command's environment.
- Commands that print credentials can never be allowed.

### 3.1 Options

| Option | What it gives | Practical for v1? |
|---|---|---|
| **Separate Unix user only** | The agent user can't read heel's files. A process running as another uid hides its `/proc/<pid>/environ` from the agent (training data, not checked this session). No network or mount control | Necessary baseline, not sufficient |
| **bubblewrap** v0.13.1 **[S29]** | Unprivileged namespaces (user, pid, ipc, net, mount). Bind and tmpfs mounts. Seccomp. The setuid mode was removed. "Not a complete, ready-made sandbox": heel writes the policy. Use `--new-session` against TIOCSTI (CVE-2017-5226) **[S29]** | **Yes.** Small, scriptable, no daemon |
| **nsjail** 3.6 **[S30]** | Namespaces, cgroups v1/v2, Kafel seccomp policies, rlimits, userland networking (pasta), protobuf config **[S30]** | Yes, with more knobs. Built from source. Stronger resource controls than bubblewrap alone |
| **Anthropic sandbox-runtime** (`srt`) 0.0.83, Apache-2.0 **[S31]** | bubblewrap on Linux, Seatbelt on macOS, a dedicated user on Windows. **Network denied by default**, with domain allowlists through host HTTP and SOCKS5 proxies. Credential masks **[S31]** | Worth evaluating as a library or as a reference. "Beta Research Preview", and its APIs may change **[S31]** |
| **Rootless containers** (Podman v6.2.0 **[S32]**) | Full images, volumes | Heavy per command. Better for v2 when the agent and heel are on different hosts |
| **gVisor** (`runsc`, release-20261109.0 **[S32]**) | Syscall interception kernel | v2 option for hosts that want a VM-like boundary |

### 3.2 Recommended v1 runner (inferred design)

- **Topology:** Linux only. heel and the agent run on the **same host as different users**. Mounting "the agent's working directory" assumes it lives on heel's host. A different-host setup needs a sync or mount protocol that the README doesn't describe. That design is deferred (see the requirements map's mechanics gap).
- **Launch:** a pure function builds a bubblewrap argv, and Node spawns it without a shell. The sandbox has:
  - new user, pid, ipc, uts and network namespaces;
  - `--die-with-parent`, `--new-session` **[S29]**, and `--clearenv`;
  - read-only binds of `/usr` and the binary heel configured;
  - the agent's cwd bound read-write at the same path;
  - a fresh tmpfs `HOME` and `TMPDIR`, so a CLI that caches tokens under `$HOME` never writes them where the agent can read;
  - one credential variable;
  - a seccomp filter.
- **Network:** no route except a loopback-bridged proxy that enforces a **per-CLI domain allowlist**, as `srt` does **[S31]**. For example, `gh` is limited to the GitHub API hosts. A client that ignores the proxy simply fails, which is fail-closed.
- **Limits:** cgroup or rlimit for CPU, memory, pids and wall time.
- **Output:** heel streams stdout and stderr back to the `heel run` client. It also scrubs the exact credential value from output. The rules still deny known credential-printing commands **[S1]**.

### 3.3 Risks the README doesn't mention (inferred — the spec must decide)

1. **Flags, env and config that redirect where the credential goes.** For a known CLI, an agent-chosen endpoint makes the CLI send its own credential to that host. Examples: `kubectl --server` or `--kubeconfig ./x`, or a `gh` hostname override. Flag parsing must **deny endpoint-changing flags** for each known CLI. The egress allowlist is the backstop.
2. **The mounted cwd can contain code the CLI runs.** Examples: git hooks, `core.hooksPath`, `core.fsmonitor` or `core.sshCommand` in `.git/config`, package-manager scripts, CLI plugins. Running such a CLI with a credential in its environment gives agent-written code that credential. v1 should:
   - pin per-CLI hardening (for git, overriding hook and command settings — exact knobs to verify per CLI);
   - refuse credentialed runs of CLIs whose normal job is executing repo code.
3. **Debug and verbose flags** can print headers or tokens. Deny them for known CLIs, alongside the README's `gh auth token` rule **[S1]**.
4. **User namespaces may be unavailable.** Ubuntu 24.04+ restricts unprivileged user namespaces through AppArmor by default; the documented fix is a sysctl **[S31]**. Inside Docker, the default seccomp profile commonly blocks `unshare` (training data, not checked this session). The install docs and CI must cover this. Without namespaces, `heel run` must refuse to start rather than run commands unsandboxed.

---

## 4. Credential storage and OAuth refresh (C-01)

- **Encryption at rest:**
  - Envelope encryption with Node's built-in AES-256-GCM (training data, not checked this session). No native crypto addon needed. `sodium-native` 5.2.1 **[S35]** is the alternative if XChaCha20 is wanted, at the cost of another native dependency.
  - Each row has its own data key, wrapped by a master key held in a mode-0600 file owned by the `heel` user, or passed as a systemd credential or env var. Add a cloud KMS later.
  - Bind each ciphertext to `(credential_id, account_alias, key_version)` as AAD, so rows can't be swapped (inferred).
- **What is encrypted:** provider refresh and access tokens, API keys, OAuth client secrets, secrets for local MCP servers, the VAPID private key, the Slack bot token and the SMTP password.
- **Agent tokens:** high-entropy random values, stored only as hashes (inferred).
- **OAuth for `heel connect`:** `openid-client` 6.9.0 lists the Refresh Token, Device Authorization, CIBA and Client Credentials grants, plus PKCE and DPoP, for Node and other runtimes **[S33]**. For remote MCP servers, implement the SDK's `OAuthClientProvider` on top of the vault, keyed by issuer as the SDK instructs **[S4]**.
- **Refresh discipline (inferred):**
  - One refresh in flight per credential.
  - Refresh ahead of expiry, and retry once on a 401.
  - Persist a rotated refresh token before using the new access token.
  - If a refresh fails, calls on that account fail closed with a "reconnect needed" status, and the account owner is notified.
- **Google-specific limits:** these decide how `heel connect gmail` must behave **[S34]**:
  - An OAuth app in "Testing" status gets refresh tokens that **expire in 7 days**. Setup docs must tell self-hosters to move the app to production, or heel must warn.
  - There are **100 refresh tokens per Google Account per OAuth client**. Older tokens are invalidated "without warning".
  - A password change revokes tokens that carry Gmail scopes.
  - Tokens unused for six months expire.

---

## 5. State: approvals, counters, audit log

**SQLite for v1, with Postgres as a later option.**

| | SQLite (`better-sqlite3` 13.1.1) | Postgres (`pg` 8.23.1 / `postgres` 4.1.1) |
|---|---|---|
| Fit | One self-hosted node. One file to back up | Several heel replicas, or teams with a central audit store |
| Count-and-reserve atomicity | The single writer serialises `BEGIN IMMEDIATE` transactions (training data, not checked this session) | Needs row locks or serialisable transactions |
| Ops cost | None | A second service to run and secure |

Versions are from **[S37]**.

- **Built-in `node:sqlite` is not ready.** It is still "Stability 1.2 – Release candidate" **[S36]**, and Drizzle 0.45.4 exports drivers for `better-sqlite3`, `bun-sqlite`, `libsql`, `node-postgres`, `postgres-js`, `pglite` and `sqlite-proxy`, but none for it **[S37]**. Start on `better-sqlite3` and revisit.
- **Why Drizzle:** its pg drivers keep the move to Postgres a driver swap, not a rewrite **[S37]**.
- **Tables (inferred):**
  - identity: `agents`, `agent_tokens` (hash only), `accounts`, `credentials` (encrypted), `upstreams`;
  - policy: `rules_versions`, `standing_approvals`;
  - approvals: `approvals` (`call_hash`, canonical call JSON, status pending/approved/denied/expired/executed, `expires_at`);
  - counting and logging: `count_events` (agent, run, action key, items, ts), `audit_log` (append-only, each row hashes the previous one);
  - approver side: `passkeys`, `sessions`, `push_subscriptions`, `pause_state`.
- **Counters (inferred):** `per: hour` sums `count_events` over a rolling window (Q-C1). Reading the count, checking the rule and reserving the items happen in **one** transaction with the audit row.
- **SIEM export:** JSONL or syslog from `audit_log` (inferred).

---

## 6. WebAuthn / passkeys

- **Library:** `@simplewebauthn/server` 14.1.0 and `@simplewebauthn/browser` 14.0.0, both MIT. Supported on Node LTS 22+ and Deno 2.4+ **[S38]**.
- **Alternatives if the core language changes:**
  - Go: `go-webauthn` v0.18.2
  - Rust: `webauthn-rs` 0.6.2
  - Python: `webauthn` 3.0.1 **[S38]**

**Design (inferred):**
- **Relying party:** the RP ID is heel's stable public hostname, over HTTPS. WebAuthn requires a secure context (training data, not checked this session). Require user verification.
- **Fresh assertion per decision.** Every approve, deny or pause needs a **fresh assertion whose challenge is bound to the approval id and call hash**. A stolen session cookie then can't approve anything.
- **Bootstrap (Q-N2).** The first passkey is enrolled with a one-time code printed on heel's host console or admin socket, never through the agent-facing plane. Recovery follows the same path.

---

## 7. Approval page UI

- **Rendering:** server-rendered HTML from Hono 4.13.18 JSX on `@hono/node-server` 2.1.8 **[S39]**.
- **Client script:** only the WebAuthn ceremony, web-push subscription and a service worker.
- **Interactivity:** optional `htmx` 2.0.11 (0BSD) for pause toggles **[S39]**. No SPA build, no CDN, strict CSP.
- **Fit with the MCP SDK:** Hono and the SDK's `createMcpHandler` both use web-standard `Request`/`Response` **[S5]**, so one HTTP stack can serve both planes on separate listeners (inferred).
- **Content:** the README requires tool, account and full arguments **[S1]**. Add the agent, run id, the rule that asked, and for email a rendered recipient and body view (Q-N4).
- **Installable app:** a manifest and a service worker are mandatory for iOS push. Web push on iOS and iPadOS works only for **Home Screen web apps** (16.4+), and permission must follow a user tap **[S42]**.

---

## 8. YAML rule schema validation

- **Pipeline:**
  1. Parse with `yaml` 2.9.1 (ISC). Its `LineCounter` and `prettyErrors` give line and column positions **[S40]**.
  2. Validate with a Zod 4.6.7 schema.
  3. Run semantic checks (below).
  4. Compile to a pure evaluator.
- **Editor support:** `z.toJSONSchema()` emits Draft 2020-12 by default, or Draft 7 or OpenAPI 3.0 **[S41]**. Commit the generated `schema/heel-rules.schema.json` so editors can validate rule files. CI fails if the file drifts from the schema.
- **Semantic checks beyond the schema (inferred):**
  - organisation rules may not `allow` **[S1]**;
  - warn on a `per: run` limit with no `per: hour` partner **[S1]**;
  - unknown action, account or command;
  - unreachable rules shadowed by an earlier, broader match;
  - `matches` patterns must compile under a linear-time regex engine, to avoid ReDoS (engine still to choose);
  - `watch: true` placement.
- **Testing rules:** add a `heel rules test` fixture format (Q-L5) that reuses the same evaluator.

---

## 9. Push notifications for v1

| Channel | Library / service | Notes |
|---|---|---|
| **Web push** | `web-push` 4.0.0, **MPL-2.0** **[S43]** | VAPID and payload encryption **[S43]**. iOS needs a Home Screen web app **[S42]**. MPL is file-level copyleft. Using it unmodified as a dependency of an Apache-2.0 project is generally compatible (training data, not checked this session — get a licence review) |
| **Email** | `nodemailer` 10.5.0, MIT-0 **[S44]** | Universal fallback over the operator's SMTP |
| **Slack** (v1.1) | `@slack/web-api` 8.4.0, MIT **[S44]** | A bot token posts a link only. Replying approves nothing **[S1]** |
| **ntfy** (optional) | ntfy server v2.37.2 **[S44]** | Self-hosted push over plain HTTP POST. Cheap to add as a generic webhook |

**Rule for every channel (inferred):** a notification carries only the agent name, the action, the account and the link. It never carries arguments or message content, which could re-expose hidden data in Slack or email.

---

## 10. Proposed architecture

### 10.1 Components and process boundaries

```
 agent host user                         heel host — runs as the `heel` user
 ┌───────────────┐  MCP / HTTP          ┌──────────────────────────────────────────────────────────┐
 │ agent client  │  + agent token  ───▶ │ AGENT PLANE listener                                     │
 │ `heel run` CLI│  run API        ───▶ │   /mcp/<account>   /mcp (run_code)   /http/<account>/…   │
 └───────────────┘                      │   /run                                                   │
                                        │        │                                                 │
 approver phone ── HTTPS + passkey ───▶ │ HUMAN PLANE listener: approval page, pause, push sub     │
                                        │        │                                                 │
 operator shell ── unix socket ───────▶ │ ADMIN SOCKET: connect, agent add, pause, enrol passkey   │
                                        │        ▼                                                 │
                                        │  PIPELINE (core, pure where possible)                    │
                                        │  auth → pause → normalize → hidden-target → state checks │
                                        │  → counts+reserve → decide → execute → hide → audit      │
                                        │        │                                                 │
                                        │  vault (encrypted creds, refresh)   store (SQLite)       │
                                        │  notifier (web push, email, Slack)                       │
                                        │        │                                                 │
                                        │  ├─ upstream MCP pool ─▶ stdio MCP children (bwrap)      │
                                        │  │                    ─▶ remote MCP (OAuthClientProvider)│
                                        │  ├─ HTTP executor ─▶ provider APIs                       │
                                        │  ├─ code mode ─▶ Monty workers (bwrap: no net/fs/creds)  │
                                        │  └─ CLI runner ─▶ bwrap ─▶ execve(binary), cwd bind-mount│
                                        └──────────────────────────────────────────────────────────┘
```

| Process | Holds | Can reach |
|---|---|---|
| `heel serve` (main) | All credentials, master key, DB | Upstreams, notifier services |
| Monty workers | Script plus host-call results only | Nothing. Stdio to the main process only |
| CLI runner child | One credential, a tmpfs `HOME`, the agent's cwd | Allowlisted hosts through the proxy |
| Local stdio MCP servers (third-party code) | Their own credential env | Should get the same bubblewrap + egress treatment (inferred) |
| `heel run` client (agent side) | The agent token only | heel's agent plane |

**Why three listeners (inferred).** Each can be exposed differently: the agent plane on a private network, the human plane through TLS or a tunnel (Q-N1), and admin through filesystem permissions. Passkeys keep the human plane safe even if an agent can reach it.

### 10.2 Request flow: an MCP `tools/call` (inferred, aligned to **[S1]** and **[S10]**)

1. **Receive.** The agent sends `POST /mcp/gmail-work` over Streamable HTTP. Under spec 2026-07-28 there is no session; protocol version and client info travel in each request's `_meta` **[S10]**.
2. **Authenticate** the agent token and resolve the agent. Read the **run id** from a heel `_meta` key, such as `heel/runId` (Q-R1).
3. **Pause check** for global, agent and service scopes. If paused, return a paused error and write an audit row.
4. **Normalize.** The definition maps the tool to `action`, `kind`, `recipients` and `items` **[S1]**. A tool heel doesn't know keeps its raw name and arguments.
5. **Hidden-target check.** Fetch, forward, reply or delete aimed at a hidden message is denied **[S1]**. heel looks up the target with its own read access.
6. **State checks** (`all_in_thread`, `checks: passing`) are resolved with timeouts. **A failed lookup denies the whole call.** It must not make the condition "false": under first-match, a false condition can fall through to a broader `allow` below it. This sharpens the requirements map's Q-S2 assumption.
7. **Counts.** In one transaction: read the window counts, add this call's items, and evaluate.
8. **Decide** in order: org rules → standing approvals → user rules, first match wins, and **no match means deny** **[S1]**.
   - **deny:** return a tool result with `isError` and the reason.
   - **ask:** create or join the pending approval keyed by the canonical call hash, notify, and return "pending approval &lt;id&gt;" immediately **[S1]**.
   - **watch:** log the would-be decision and continue.
9. **Re-run of an approved call.** The agent repeats the identical call and the hash matches. Re-check pause, org rules, state and counts (Q-A3), then mark it `executed` in the same transaction, so it runs only once **[S1]**.
10. **Execute** through the pooled MCP client for that account. The credential is attached by the connection, never placed in the arguments. For `checks: passing`, pin the checked commit SHA in the merge call **[S1]**.
11. **Hide.** Filter the response with the definition's shape and return a placeholder count **[S1]**. A shape heel doesn't know passes through, as the README says.
12. **Audit** the agent, run, arguments, deciding rule or approval, and approver **[S1]**. Then return.

**Note on MCP tasks.** Spec 2026-07-28 moved *tasks* into an extension with `tasks/get` polling **[S10]**. Pending approvals could map onto it later. v1 returns a plain tool result, because client support is unknown.

### 10.3 Fail-closed behaviour (inferred)

| Failure | Behaviour |
|---|---|
| heel down | The connection fails. Calls never pass **[S1]** |
| Any exception in steps 2–12 | Deny, with an audit row if the store is writable |
| DB read or write error | Deny. Never allow without a durable count reservation and audit row |
| State-check timeout | Deny the call (step 6) |
| Upstream error | Return the upstream error. Counts reserved for a failed call: Q-C3/Q-C4 |
| Token refresh fails | Deny calls on that account, show "reconnect" and notify the owner |
| `looks_like` classifier unsure or down | Hide the message **[S1]** |
| Rules file invalid on reload | Keep the last valid version and alert. If none is valid, deny everything |
| Sandbox limit hit | Stop the script and return partial output plus the reason |
| User namespaces unavailable | `heel run` refuses to start |

---

## 11. Repo layout, toolchain, tests and CI

### 11.1 Layout

Start with **one package**, and enforce that `src/core` has no I/O imports through a lint rule. Split into packages only when something needs to ship separately.

```
heel/
  src/
    core/          # pure: Call model, canonical hash, rules schema (zod), evaluator, counts math, hide filters
    definitions/   # built-in providers as data: gmail, outlook, github… (action maps, response shapes, deny lists)
    store/         # drizzle schema, SQL migrations, repositories
    vault/         # envelope encryption, OAuth connect + refresh, OAuthClientProvider impl
    gateway/       # agent plane: MCP server faces, upstream client pool, HTTP proxy, pipeline
    codemode/      # Monty pool, stub generator (JSON Schema → .pyi), run_code tool
    runner/        # bwrap argv builder (pure), egress proxy, spawn
    web/           # human plane: Hono pages, WebAuthn, service worker, manifest
    notify/        # web push, email, slack
    cli/           # `heel` entry: serve, connect, agent, pause, run, rules test
  test/
    fakes/         # fake upstream MCP servers (gmail-like, github-like) built on @modelcontextprotocol/server
    integration/   # gateway driven by a real @modelcontextprotocol/client
    incidents/     # README incident replays as acceptance tests
    escape/        # code-mode and runner escape-attempt corpus
  schema/heel-rules.schema.json   # generated; CI checks drift
  deploy/          # Dockerfile (glibc base), systemd unit
  .github/workflows/ci.yml
```

### 11.2 Toolchain (versions as of 2026-11-13)

- **Runtime:** Node **26.13.1 LTS** **[S11]**. Node's type stripping is stable **[S46]**, so development runs `.ts` directly.
- **Build and lint:** TypeScript **7.0.2** **[S46]**, reported as the native Go compiler (InfoQ headline; search result only) **[S46]**. **Biome** 2.6.7 for lint and format **[S46]**.
- **Package and test:** **pnpm** 12.18.0, **Vitest** 5.1.0 **[S46]**.
- **Logging:** **pino** 10.4.0 **[S46]**.

### 11.3 Test strategy

- **Unit tests (pure core):** table tests for
  - rule ordering, org-cannot-allow and no-match-denies;
  - each plain check and items counting;
  - canonical call hashing;
  - hide filters against recorded response shapes;
  - the bubblewrap argv builder;
  - YAML errors with line numbers.
- **Integration tests with fake upstreams:**
  - Fake MCP servers are wired in-process. The gateway's upstream transport `fetch` points at the fake's `handler.fetch`, and the "agent" is a real `Client` against heel's own handler: "no port, no socket, no mock transport" **[S5]**.
  - One stdio fake runs as a real subprocess.
  - Fail-closed cases: kill the upstream, make a state lookup throw, make the DB read-only, corrupt the rules file. Each must deny.
- **Incident replays:** the four README incidents as end-to-end tests **[S1]** (requirements map C-24).
- **Code-mode escape corpus:** `import os` and `open`, sockets, environment reads, `eval` tricks, memory and loop bombs, more host calls than `max_suspensions`, and the stop-on-ask case where a script wraps the call in `try/except`.
- **Runner tests (Linux):**
  - A fake CLI dumps its env, cwd and `/proc` view. Assert the credential never appears in agent-readable files.
  - Assert network access outside the allowlist fails.
  - Assert endpoint-redirect flags are denied.
- **Protocol conformance:** run `modelcontextprotocol/conformance` (v0.1.16; repo active as of 2026-11-11) against heel's agent plane **[S47]**. I did not check how it is invoked, so add it as a non-blocking job first.
- **Approval page:** browser test with a virtual WebAuthn authenticator through Chrome DevTools (training data, not checked this session).

### 11.4 GitHub Actions CI

Actions at their current majors **[S47]**: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.1, `actions/upload-artifact` v7.0.2. Pin to commit SHAs in the real file (training data, not checked this session).

```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {} }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 26, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm biome ci .
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm schema:generate && git diff --exit-code schema/
  integration:
    runs-on: ubuntu-latest
    needs: check
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 26, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration   # fake upstreams, fail-closed, incidents, code-mode escape corpus
  runner-linux:
    runs-on: ubuntu-latest
    needs: check
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 26, cache: pnpm }
      - run: sudo apt-get install -y bubblewrap
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # Ubuntu 24.04+ default, per [S31]
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:runner
  conformance:
    runs-on: ubuntu-latest
    needs: check
    continue-on-error: true   # promote to required once the invocation is pinned
    steps:
      - uses: actions/checkout@v7
      - run: echo "run modelcontextprotocol/conformance against heel's agent plane"
```

---

## 12. Recommendation: what it costs and what would reverse it

**Recommendation.** TypeScript on Node 26 LTS, with:
- official MCP SDK v2 packages;
- Monty for code mode, wrapped in bubblewrap;
- bubblewrap with an egress allowlist for the Linux-only CLI runner;
- SQLite through Drizzle;
- SimpleWebAuthn on a server-rendered Hono approval page;
- Zod and `yaml` for rules;
- web push and email notifications;
- an OCI image as the primary distribution.

**What it costs:**
- **No single static binary in v1.** Node SEA is still in active development and native addons must be extracted to disk **[S12]**. Monty's worker and addon add about 42 MB unpacked on linux-x64 **[S22]**.
- **Two languages for one feature.** Agents write a **Python subset** in code mode **[S20]** while heel is TypeScript, so heel must generate `.pyi` stubs from JSON Schema.
- **Interpreter-level isolation only, from a young project.** Monty's isolation is language-level and it reached v1 recently **[S16][S17]**. That is why its workers also go under bubblewrap.
- **`heel run` is Linux-only and co-located-only in v1.** It needs user namespaces **[S29][S31]**.
- **Native addons** (`better-sqlite3`, Monty) tie images to glibc **[S22]**.

**What improves:**
- the most complete documented MCP client OAuth path with in-process testing **[S4][S5]**;
- one schema language across MCP tools and rules;
- a typed, limit-enforced, stop-anywhere code-mode sandbox **[S19][S21]**;
- fast iteration on the parts that change most.

**What would reverse it:**

| New fact | Switch to |
|---|---|
| A single static binary (curl-install or Homebrew) becomes a hard v1 requirement | **Rust**: rmcp's full OAuth client **[S8]**, native `monty-pool` **[S22]**, webauthn-rs **[S38]**, cargo-dist **[S15]** |
| The team is fluent in Rust and not in TypeScript | **Rust** |
| go-sdk client OAuth leaves experimental **[S7]** *and* a Go sandbox with memory limits matures | Go becomes viable |
| A Monty sandbox escape without a timely fix, or agent evals show high failure rates on the Python subset | **quickjs-emscripten** **[S24]**, with TypeScript scripts type-checked against generated `.d.ts` |
| `looks_like` must ship in v1 with model quality that needs Python tooling | A Python **sidecar** for the classifier, not a language switch |
| Several heel replicas, or a central team audit store | **Postgres** through Drizzle's pg drivers **[S37]** |
| Agents run on other machines and still need `heel run` | A cwd sync design plus a container-based runner (Podman or gVisor **[S32]**), not bubblewrap |

---

## 13. Decisions this research adds for the spec (inferred)

- **N-1:** A state-lookup failure **denies the call**. It does not make the condition false (§10.2 step 6; refines Q-S2).
- **N-2:** In code mode, `ask` and pause **stop** the script by never resuming it. Raising an exception would let `try/except` swallow the stop (§2.1).
- **N-3:** Set the per-script host-call budget explicitly, and size Monty's `max_suspensions` to match **[S19]**.
- **N-4:** For each known CLI, list:
  - denied endpoint-redirect flags and debug flags;
  - hardening for config the CLI executes from the cwd;
  - the egress allowlist (§3.3).
- **N-5:** The v1 CLI runner is co-located only (heel and the agent on one host, different users).
- **N-6:** The code-mode script language (the Python subset via Monty) is locked in the spec. The README is silent on it.
- **N-7:** Each approval decision requires a fresh passkey assertion bound to the approval id and call hash (§6).
- **N-8:** Local stdio MCP servers run under the same bubblewrap and egress treatment as CLIs.

---

## Appendix — source record

All retrieved 2026-11-13. "Registry" means a JSON API query (npm, PyPI, crates.io, the Go module proxy). "GitHub API" means `gh api` on repo README, contents, releases or trees. "Fetch" means a full-page fetch. "curl" means raw page text extracted with a script.

| # | Source (URL) | What it showed | Method |
|---|---|---|---|
| S1 | `akhileshrangani4/heel` README.md (repo checkout) | All product requirements quoted above: trust boundary, code mode, CLI runner, rules, hide, approvals, pause, teams | file read |
| S2 | https://modelcontextprotocol.io/docs/sdk | TypeScript, Python, C#, Go, Rust and Ruby SDKs are Tier 1. Java Tier 2. Swift, PHP and Kotlin Tier 3 | curl |
| S3 | https://registry.npmjs.org/@modelcontextprotocol/server (also /client, /sdk); packages/server/package.json | server 2.4.0 and client 2.4.0, 2026-10-23, Apache-2.0. Legacy `sdk` 1.32.2 (MIT). Server `engines.node >=20` | registry, GitHub API |
| S4 | typescript-sdk `docs/clients/oauth.md` | `OAuthClientProvider` as the transport's `authProvider`. The SDK runs discovery, registers the client and calls `redirectToAuthorization`. Key credentials by `ctx.issuer` | GitHub API |
| S5 | typescript-sdk `docs/testing.md` | `createMcpHandler(createServer)`, client transport `fetch: (url, init) => handler.fetch(...)`, "no port, no socket, no mock transport". `versionNegotiation: { mode: 'auto' }`. Example uses `inputSchema: z.object(...)` | GitHub API |
| S6 | typescript-sdk repo tree | `docs/serving/stdio.md`, `packages/client/src/client/stdio.ts` (stdio on both sides) | GitHub API |
| S7 | go-sdk README; proxy.golang.org `@latest` | v1.7.0+ supports spec 2026-07-28. "Client side OAuth has experimental support". `auth` and `oauthex` packages. `StdioTransport`. v1.8.0 on 2026-09-04 | GitHub API, registry |
| S8 | rust-sdk README + `docs/OAUTH_SUPPORT.md`; crates.io `rmcp` | stdio and stateless Streamable HTTP. OAuth 2.1 with PKCE, RFC 8707/9728/8414, DCR, CIMD, scope upgrade, automatic token refresh. rmcp 3.10.0, updated 2026-11-12 | GitHub API, registry |
| S9 | python-sdk README + repo tree; PyPI `mcp` | stdio, Streamable HTTP and SSE. `docs/client/oauth-clients.md` and `examples/snippets/clients/oauth_client.py` exist (paths only). mcp 2.3.0, MIT | GitHub API, registry |
| S10 | https://modelcontextprotocol.io/specification/2026-07-28/changelog | Removed sessions and `Mcp-Session-Id`. No `initialize`; version and capabilities in `_meta`. `server/discover`. `subscriptions/listen`. Tasks moved to extension `io.modelcontextprotocol/tasks` with `tasks/get` polling | curl |
| S11 | nodejs.org/dist/index.json; GitHub releases (bun, deno, rust); go.dev/dl | Node v26.13.1 LTS 2026-11-10. bun-v1.4.4 2026-10-22. Deno v2.9.8 2026-10-21. Rust 1.100.0 2026-11-12. go1.27.4 | registry, GitHub API |
| S12 | https://nodejs.org/api/single-executable-applications.md | "Stability: 1.1 - Active development". Native addons can't load from the VFS; write them to a temporary file first | curl |
| S13 | oven-sh/bun `docs/compiler/executables.mdx` | `bun build --compile`. `--target` cross-compiles to linux, windows and darwin on x64/arm64 | GitHub API |
| S14 | https://docs.deno.com/runtime/reference/cli/compile/ | `deno compile --target` cross-compiles to every listed target regardless of host | curl |
| S15 | GitHub releases goreleaser/goreleaser, axodotdev/cargo-dist | GoReleaser v2.20.2 2026-11-12. cargo-dist v0.34.0 2026-11-02 | GitHub API |
| S16 | https://pydantic.dev/docs/monty/ | "Monty v1.0.0 is released … ready for production use". Latency table (OSS Monty 1.20 ms combined; WASI 200 ms; local Docker 900 ms). Suspend and resume from bytes. Python, JS and Rust packages. Commercial tier adds OS-level isolation | fetch |
| S17 | https://pydantic.dev/docs/monty/concepts/security/ | "language-level sandbox, not an OS-level one". No ambient authority; clock and entropy are the exceptions and can be disabled. A host function is "an unconstrained filesystem or network primitive that you wrote". Bug bounty | fetch |
| S18 | https://pydantic.dev/docs/monty/concepts/snapshots/ | `feed_start` returns a `FunctionSnapshot` at each host call. `resume` / `resumeError` / `resumeFuture`. Dumps are opaque bytes. Restore only trusted snapshots and verify a MAC | fetch |
| S19 | https://pydantic.dev/docs/monty/concepts/resource-limits/ | `max_memory` (not an RSS ceiling; use a cgroup), feed and turn durations, `max_recursion_depth` (1000), `max_suspensions` (1000, cannot be disabled), total sleep. Clock paused while suspended on the host | fetch |
| S20 | https://pydantic.dev/docs/monty/limitations/ | Python subset: no class inheritance, no generators, no user exception classes, no third-party packages. async/await and `asyncio.gather` supported. Stdlib subset | fetch |
| S21 | https://pydantic.dev/docs/monty/concepts/type-checking/ | Bundles `ty`. `type_check_stubs`. `ExternalModule` with `.pyi` stubs. Diagnostics point at the model's own lines | fetch |
| S22 | npm `@pydantic/monty` + `-linux-x64-gnu`; unpkg file list; PyPI `pydantic-monty`; crates.io `monty-pool`; GitHub pydantic/monty | 1.6.0, 2026-11-11, MIT, node >=20. Optional deps only darwin-x64/arm64, linux-x64-gnu, linux-arm64-gnu, win32-x64-msvc. linux-x64-gnu ships `monty` (32,377,536 B) + `.node` (10,450,176 B), unpacked 42,828,419 B. JS dist has `nodeFactory`, `poolOptions`, `print` modules. pydantic-monty 1.6.0. monty-pool 1.6.0 | registry, unpkg, GitHub API |
| S23 | laverdet/isolated-vm README; npm | "currently in maintenance mode". Security section warns that leaked references give "complete control over a process". npm 7.0.2 on 2026-10-30 (ISC). GitHub's latest release tag is older (v6.0.2) | GitHub API, registry |
| S24 | justjake/quickjs-emscripten README; npm; repo | "Safely evaluate untrusted Javascript". `setMemoryLimit`, `setMaxStackSize`, `setInterruptHandler`, `newPromise`, asyncify. 0.32.0 on 2026-02-16. 1,745 stars, pushed 2026-07-23 | GitHub API, registry |
| S25 | https://docs.deno.com/runtime/fundamentals/security/ | For untrusted code, "have more than one layer of defense": limited permissions, Web Worker, OS sandboxing (chroot, cgroups, seccomp), VM/MicroVM | curl |
| S26 | cloudflare/workerd README | "workerd is not a hardened sandbox". Run it inside a VM for possibly malicious code | GitHub API |
| S27 | https://nodejs.org/api/permissions.md | The permission model "does not protect against malicious code" | curl |
| S28 | dop251/goja README; Go proxy; ewhauser/gomonty; DelSkayn/rquickjs; crates.io | goja documents `vm.Interrupt`; a README grep for memory or limit found nothing. goja pseudo-version 2026-11-10. gomonty 13 stars, pushed 2026-03-29. rquickjs 0.14.0 (2026-09-18), 1,072 stars | GitHub API, registry |
| S29 | containers/bubblewrap README; releases | Unprivileged user namespaces; setuid mode removed. "not a complete, ready-made sandbox". `--new-session` against TIOCSTI (CVE-2017-5226). Seccomp support. v0.13.1 2026-10-14 | GitHub API |
| S30 | google/nsjail README; releases | Namespaces, chroot and pivot_root, rlimits, Kafel seccomp-bpf, cgroups v1/v2, pasta networking, protobuf config. Release 3.6 2026-03-18 | GitHub API |
| S31 | anthropics/sandbox-runtime README; npm | "Beta Research Preview". bubblewrap on Linux, sandbox-exec on macOS, dedicated user + WFP on Windows. Network denied by default with domain allowlists via HTTP/SOCKS5 proxies. Credential masks. Ubuntu 24.04+ AppArmor restricts unprivileged userns (sysctl fix). npm 0.0.83, 2026-11-13, Apache-2.0 | GitHub API, registry |
| S32 | GitHub releases google/gvisor, containers/podman | gVisor release-20261109.0 (2026-11-11). Podman v6.2.0 (2026-11-10) | GitHub API |
| S33 | panva/openid-client README; npm | Refresh Token, Device Authorization, CIBA and Client Credentials grants. DPoP. PKCE. Node, browsers, Deno, Workers. openid-client 6.9.0 (2026-11-13), oauth4webapi 3.8.8 | GitHub API, registry |
| S34 | https://developers.google.com/identity/protocols/oauth2 ("Refresh token expiration") | "Testing" publishing status → refresh token expires in 7 days. Limit of 100 refresh tokens per Google Account per client; oldest invalidated "without warning". Password change revokes Gmail-scoped tokens. Six months unused | curl |
| S35 | npm sodium-native | 5.2.1, 2026-11-09, MIT | registry |
| S36 | https://nodejs.org/api/sqlite.md | "Stability: 1.2 - Release candidate" | curl |
| S37 | npm better-sqlite3, drizzle-orm (+ 0.45.4 exports), kysely, pg, postgres | better-sqlite3 13.1.1 (2026-11-11, MIT). drizzle-orm 0.45.4 (Apache-2.0) exports better-sqlite3, bun-sqlite, libsql, node-postgres, postgres-js, pglite, sqlite-proxy, with no node:sqlite driver. kysely 0.29.9. pg 8.23.1. postgres 4.1.1 | registry |
| S38 | MasterKale/SimpleWebAuthn README; npm; Go proxy; crates.io; PyPI | Supports Node LTS 22+ and Deno 2.4+. server 14.1.0 (2026-11-06), browser 14.0.0 (2026-09-02), MIT. go-webauthn v0.18.2. webauthn-rs 0.6.2. webauthn (py) 3.0.1 | GitHub API, registry |
| S39 | npm hono, @hono/node-server, htmx.org | hono 4.13.18 MIT. @hono/node-server 2.1.8 MIT. htmx.org 2.0.11 0BSD | registry |
| S40 | https://eemeli.org/yaml/; npm yaml | `LineCounter` → `linePos(offset)`. `prettyErrors` adds line and column. yaml 2.9.1, ISC | curl, registry |
| S41 | https://zod.dev/json-schema; npm zod | `z.toJSONSchema()` targets draft-2020-12 (default), draft-07, draft-04, openapi-3.0. `fromJSONSchema` experimental. zod 4.6.7 | fetch, registry |
| S42 | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ (2023-02-16) | Web Push for Home Screen web apps on iOS/iPadOS 16.4. Permission must follow user interaction. No Apple Developer Program needed. Allow `*.push.apple.com` | fetch |
| S43 | web-push-libs/web-push README; npm | VAPID keys and payload encryption. web-push 4.0.0, 2026-11-06, MPL-2.0 | GitHub API, registry |
| S44 | npm @slack/web-api, nodemailer; GitHub binwiederhier/ntfy | @slack/web-api 8.4.0 MIT. nodemailer 10.5.0 MIT-0. ntfy v2.37.2 (2026-11-04) | registry, GitHub API |
| S45 | npm onnxruntime-node, @huggingface/transformers | 1.31.1 MIT. 4.3.2 Apache-2.0 | registry |
| S46 | npm typescript, @biomejs/biome, vitest, pino, @types/node, tsx; GitHub pnpm/pnpm; https://nodejs.org/api/typescript.md; web search (InfoQ, Microsoft devblogs) | typescript 7.0.2 (2026-07-08). Biome 2.6.7. Vitest 5.1.0. pino 10.4.0. pnpm v12.18.0. Node "Type stripping is now stable". Search-result title: "Microsoft Releases TypeScript 7.0 with a Native Go Compiler" (InfoQ, 2026-08; title only, article not read) | registry, curl, search |
| S47 | GitHub releases actions/checkout, actions/setup-node, pnpm/action-setup, actions/upload-artifact, modelcontextprotocol/conformance | v7.0.1, v7.1.0, v6.1.1, v7.0.2. Conformance v0.1.16 (2026-03-27); repo "Conformance Tests for MCP", pushed 2026-11-11 | GitHub API |
| S48 | Project artifact `art_RNJqRJci` (heel research — requirements map) | Option B recommended. It defers code mode, HTTP and CLI. Q-IDs referenced above | SDK read |

**Retrieval note.** Part of this research ran before a context compaction. Every version and claim cited above was re-retrieved after it, on 2026-11-13, so each row reflects a call I can point to.
