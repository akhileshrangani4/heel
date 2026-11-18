# heel: spec-v0.1 vs the enterprise v1 design

Written 2026-11-17 to decide which plan the code follows.

- **spec-v0.1**: `docs/design/spec-v0.1.md` on `release/heel-v0.1`, approved Nov 13 (last edit 20:34 UTC). It's being built: D1, D2, D3, D4a, D8a, D10a and D13a are merged, and D4b (PR #9) is open.
- **v1 design**: `docs/design/2026-11-13-v1-design.md`, untracked on `main`, written Nov 13 around 19:23 UTC in a separate session, informed by the StrongDM Leash notes. None of it is built.

The two were written in parallel on the same day. Neither one references the other.

## Where they differ

| | spec-v0.1 (being built) | v1 design |
|---|---|---|
| Who it's for | Anyone self-hosting, from one person to a team | Companies on Google Workspace |
| Scope | The whole README: MCP, code mode, HTTP proxy, CLI runner, 8 providers | Gmail (native tools) and Calendar (proxying Google's MCP server) only |
| Rules | heel's own YAML, first-match, in files | Cedar (forbid > ask > permit), stored in the DB with history, edited in a dashboard |
| Stack | Node 26, SQLite, Drizzle | Bun, Postgres |
| How agents connect | A static bearer token per agent; MCP OAuth deferred | MCP OAuth 2.1 with dynamic client registration, so Claude, ChatGPT and Grok can add heel as a custom connector |
| Where heel listens | The agent plane on 127.0.0.1 by default | Public HTTPS, because those clients call from their vendors' clouds |
| Rollout modes | Watch mode (per rule, or global), which never relaxes org rules | Record, shadow and enforce, set per group, switchable live |
| Rule suggestions | A model drafts a rule from a written description | Drafted from record-mode traffic |
| Approving | A fresh passkey assertion bound to the call hash | A recent Google sign-in |
| Running an approved call | The agent re-sends the identical call | `heel_run_approved(id)`, so the agent doesn't have to rebuild the arguments |
| `looks_like` | Patterns plus a linear classifier, with an eval gate | A readable pattern list only, no model |
| Observability | Append-only audit table, JSONL export, SIEM sink | Adds an agent inventory, a live stream, an event explorer and OpenTelemetry |
| First step | Build D1 through D14 in order | A spike against real Claude, ChatGPT and Grok connectors |

## Where they already agree

Most of the decision core is shared:

- default deny and fail closed;
- organization rules form a ceiling that personal rules can't loosen;
- an ask returns at once, and an approval executes only once, after the rules are checked again;
- standing approvals lapse when the rule that asked for them changes;
- pause by scope, with pause checked again before an approved call runs;
- hide fails closed;
- recipients and `all_in_thread` state checks, plus item counts;
- the README's incident replays as the acceptance test.

The release branch already implements most of this (D1, D3, and D4b in #9), and the shared parts don't depend on which plan wins.

## The real forks

Only three differences change code that already exists:

1. **Rules language (YAML or Cedar).** This is the biggest one. D2 is built and tested, the README shows YAML, and the README's own alternatives list counts Cedar as what ToolHive and ContextForge use. Switching to Cedar means rewriting D2 and the rule-related parts of D3 and D4b. Cedar's advantage is that enterprise security teams may already know it and it can be statically analyzed.
2. **Agent authentication.** Static tokens can't be used by Claude, ChatGPT or Grok custom connectors, which need OAuth discovery and dynamic client registration. Without OAuth, v0.1 serves local agents (Claude Code, Codex, scripts) but not the cloud chat clients v1 is built around. This is additive: OAuth can sit next to static tokens.
3. **How approvers prove who they are (passkey or Google sign-in).** The passkey work is built in #9. A Google sign-in is weaker: a stolen session can approve. Keeping passkeys and adding Google OIDC for sign-in matches what spec-v0.1 already says for teams (D13).

The rest of v1 adds to spec-v0.1 rather than contradicting it:

- record, shadow and enforce modes per group, which extend watch mode;
- suggestions drawn from traffic;
- the dashboard views;
- `heel_run_approved`;
- Postgres, which Drizzle supports alongside SQLite.

## Recommendation

**Keep the release branch and spec-v0.1 as the base, and move v1's enterprise ideas into it as new deliverables.** Concretely:

1. **Keep YAML for now.** Leave room for a Cedar import/export later instead of rewriting D2. Revisit only if a real enterprise buyer asks for Cedar.
2. **Finish D4 on #9** (passkeys stay), then merge it.
3. **Add three deliverables, reordered so the enterprise demo comes first:**
   - **D5 + OAuth.** MCP OAuth 2.1 with dynamic client registration on the agent plane, plus a run behind public HTTPS. Do v1's spike against Claude, ChatGPT and Grok here.
   - **Modes.** Record, shadow and enforce, set per group, building on watch mode.
   - **Observability.** The agent inventory, a live stream and an event explorer on the human plane. Rule suggestions from traffic go here.
4. **Re-order the remaining work so Gmail (D9) and Calendar passthrough land before** code mode (D6), the HTTP proxy (D7), the rest of the CLI runner (D8) and the other providers (D11, D12). That reaches v1's success scenario first: a Workspace company runs heel in record mode for a week.
5. **Put both plan docs on the release branch** so later sessions stop finding two plans.

The alternative, rebuilding on Cedar, Bun and Postgres, throws away about 7 merged deliverables to gain one language choice. It's only worth it if Cedar is a hard requirement from a buyer.

## Addendum: Daily Strategy meeting, Nov 17 (Avi, Michael, Lachlan)

Source: Granola, "Daily Strategy", 2026-11-17 11:00 PT. Points that change the plan above:

1. **A decision model in front of the rules.** Avi described three tiers: the user's YAML rules, an intent-based decision model on top, and the hardcoded rules engine as the fallback. Lachlan's view is that the decision model is where the value is: auto-approve the obvious calls and only ask a person about the ambiguous ones, because people who see every approval end up approving without reading. **This conflicts with both plans.** spec-v0.1 locks "a model never sees a live call" (except `looks_like`), and v1 lists "a model makes any decision on a live call" as an anti-goal.
2. **The adapter chain.** Lachlan proposed making the decision layer a middleware chain. Each adapter checks the request, and all of them must pass. The same chain runs again on the response to filter what shouldn't come back. Possible adapters include the rules engine, a decision model, OpenFGA, Zanzibar, ask-the-user and a Slack vote. Hard rules are combined with AND, so they still win. Avi committed to refactoring toward this. D3's pipeline is already ordered stages, so this is mostly about making the stages pluggable and giving each adapter a defined power (deny, ask, allow or abstain).
3. **Positioning.** The term is "intent-based access control" (IBAC). The references to read are ibac.dev (a paper built on OpenFGA, where a model writes FGA rules from the intent; its weakness is taking seconds instead of milliseconds) and Composio's Firewall (Michael posted it in Slack). Pitch: "provably safe API connections, already built, open source." The publishable asset is the design decisions, not just the code.
4. **Phone approvals** were picked out as the most compelling standalone piece. Michael's OPBridge, which sends 1Password approvals to a phone over Tailscale, independently validates the idea.
5. **Later ideas.** A command that moves the MCP servers already configured in Claude Code behind heel, and a `heel claude` wrapper.
6. **A demo on Nov 18.** Avi said it was 80 to 90% done. **What's on the branches doesn't support that yet:** the agent plane returns `501 surface_unavailable` on every surface, no provider definitions exist apart from the CLI tables, and the human plane serves only `/healthz`. The pieces exist but aren't wired together: rules, pipeline, approvals store, passkeys and UI components.

### Open design question this raises

What may a model adapter decide? Two safe readings, both keeping hard rules and org rules as a ceiling:

- **Tighten only.** The model can turn allow into ask or deny, but never loosen anything. This fits the current specs as written.
- **Also loosen asks.** The model can turn an owner-rule `ask` into `allow` when it's confident the call matches the stated intent, with every such decision audited and switchable per rule. This is what reduces approval fatigue, and it means amending the "no model on a live call" invariant.

Org denies, hard denies, pause and hidden targets stay outside the model's reach in both readings.

## Decisions (Avi, Nov 17)

1. **Base:** keep `release/heel-v0.1` and spec-v0.1, stay on YAML, and add v1's enterprise ideas as new deliverables (see Recommendation).
2. **Model power: tighten only.** The decision-adapter chain (PR #11) lets an adapter pass or deny, never allow. No model turns an ask or a deny into a live allow.
3. **Approval fatigue is fixed with grants, not model judgment:**
   - **Approval-scoped grants.** When a person approves with a passkey, they can grant a narrow, expiring allow derived from the system-rendered call (the exact call, the rule's scope, or this task/run). This extends D4b's standing approvals with a run scope.
   - **Optional up-front intent grants.** The owner states a task. A model may propose a narrow grant set from that trusted text only, the person confirms it once, and the rules engine enforces it. The model drafts policy for a person to sign; it never gives live verdicts.
   - **A model may annotate the approval queue** ("looks routine", "new recipient") but never answers for the person.
4. **Adapters are a general extension point.** Beyond OpenFGA or a model, anyone can write a custom adapter for their own services. Custom-adapter packaging and config come later; the seam in #11 ships as is.
5. **No demo deadline.** Build properly. The code should be easy to understand just by reading it.
6. **Next:** finish D4 on #9 (approval page routes, check-back, notifications, Playwright), merge #9 and then #11, then the new deliverables in the Recommendation's order.
