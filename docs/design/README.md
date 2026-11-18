# heel design documents

These files were exported from the Obvious project `prj_rqc5uhH3` on 2026-11-17. They are the
design record for heel v0.1: the approved build spec, the research it was based on, and the chat
history of the build orchestration. The implementation itself is recorded in GitHub pull requests
[#1](https://github.com/akhileshrangani4/heel/pull/1)–[#9](https://github.com/akhileshrangani4/heel/pull/9)
(#1 is the release PR from `release/heel-v0.1` to `main`; #2–#9 are the deliverable PRs into the
release branch).

| File | What it is | Source |
| --- | --- | --- |
| [spec-v0.1.md](spec-v0.1.md) | **heel v0.1 — build spec.** The approved spec: architecture, call model and pipeline, rules semantics, counts and state checks, approvals and pause, hiding, every agent surface (MCP, code mode, HTTP, CLI), built-in providers, teams, fail-closed behavior, deliverables D1–D14 with acceptance criteria, and locked decisions. Converted from the Blueprint's HTML. | Blueprint `art_pghXabd9` |
| [research-requirements-map.md](research-requirements-map.md) | **Requirements map.** The README broken into capabilities C-01…C-25, testable invariants I-01…I-74, a dependency graph, MVP slice options and the open questions the spec answers. | Document `art_RNJqRJci` |
| [research-mcp-and-provider-apis.md](research-mcp-and-provider-apis.md) | **MCP and provider APIs.** The facts that most constrain the design: the MCP specification, Gmail and Outlook mail APIs, tool names and argument shapes of popular MCP servers, GitHub merges and `checks: passing`, `gh` and `kubectl` parsing, `looks_like` detection, and the gaps no reliable source covered. | Document `art_1G3anPKA` |
| [research-stack-and-architecture.md](research-stack-and-architecture.md) | **Stack and architecture.** Language and runtime, the code-mode sandbox, CLI runner isolation, credential storage, state, passkeys, the approval page, rule validation and notifications; the proposed architecture, repo layout, tests and CI; and what the recommendation costs. | Document `art_wgq2qFAj` |
| [research-provider-api-verification.md](research-provider-api-verification.md) | **Provider API verification.** Endpoint checks against official documentation for Outlook reply, reply-all and forward drafts (D9) and for Google Calendar, Microsoft Graph calendar, Slack, Linear, Notion and Stripe (D12), with the items still unconfirmed. | Document `art_zWpwHNdc` |
| [build-chat-history.md](build-chat-history.md) | **Build chat history.** Every user and assistant text message from the build orchestration thread, oldest first, with UTC timestamps and authors. Tool calls, tool results, assistant reasoning and context blocks are omitted. | Thread `th_rFEHGm5t` |

Each file opens with a header naming its source and the export date. The research documents are
copied verbatim from their Markdown source; the only change is that two Obvious comment-highlight
wrappers in the requirements map were removed, keeping their text.

## Added on 2026-11-17

Records from after the export, written while deciding how to continue the build:

| File | What it is |
| --- | --- |
| [2026-11-13-v1-design.md](2026-11-13-v1-design.md) | **Enterprise v1 design.** A parallel plan from Nov 13 for companies on Google Workspace: Cedar rules, Bun and Postgres, Gmail and Calendar only, record/shadow/enforce modes, MCP OAuth for cloud connectors. Not adopted as the base; its ideas are folded into this release as new deliverables. |
| [2026-11-17-plan-comparison.md](2026-11-17-plan-comparison.md) | **The two plans compared,** the Nov 17 Daily Strategy meeting's input (the adapter chain, a decision model, IBAC), and the decisions that settled the direction: spec-v0.1 as the base, tighten-only adapters, and grants instead of model judgment for approval fatigue. |
| [2026-11-17-flow.html](2026-11-17-flow.html) | **The call flow as a diagram:** every pipeline stage, the outcomes returned to the agent, and the approval loop, marked built, in review or planned as of Nov 17. Open it in a browser. |
| [../research/2026-11-13-strongdm-leash-notes.md](../research/2026-11-13-strongdm-leash-notes.md) | **StrongDM Leash notes:** what heel takes (modes, rules from traffic, structured events, a linter) and what it doesn't (kernel enforcement, deny-only MCP rules). |
| [../research/2026-11-17-ibac-and-composio-firewall.md](../research/2026-11-17-ibac-and-composio-firewall.md) | **IBAC, Composio Firewall and WorkOS Airlock:** what a model may decide in each, and why heel's adapters only tighten. |
