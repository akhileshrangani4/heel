# IBAC and Composio Firewall: what a model may decide

Research date: 2026-11-17. Question: should heel's planned adapter chain let a decision model only tighten a verdict, or also loosen an owner-rule `ask` to `allow`?

Legend: **[verified]** means read in the primary source. **[unverified]** means a secondary source only, or not found.

## 1. Intent-Based Access Control (IBAC), ibac.dev

Sources:
- Site: https://ibac.dev
- Paper (PDF): https://ibac.dev/ibac-paper.pdf, "Intent-Based Access Control: Securing Agentic AI Through Fine-Grained Authorization of User Intent", Jordan Potti
- Blog post: https://fragilesecurity.substack.com/p/your-ai-agent-has-root-access-to (Mar 3, 2026)

**Author and affiliation.** Jordan Potti. The paper lists only a gmail address, and the site lists only a LinkedIn profile. **[unverified]** Neither the paper, the site, nor the blog mentions Rivian, and a web search found no link. Treat "at Rivian" as hearsay.

**Definition [verified].** IBAC "derives per-request permissions from the user's explicit intent, enforces them deterministically at every tool invocation, and blocks unauthorized actions regardless of how thoroughly injected instructions compromise the LLM's reasoning." Its thesis line is "Security that depends on AI judgment is hope with extra steps."

**Steps [verified].**
1. Request context. A trusted contact store resolves names to addresses ("Bob" to bob@company.com) before the agent runs. The paper says other data (files, calendar, history) may be attacker-influenced and must not feed authorization.
2. Intent parsing. One dedicated LLM call with a conservative system prompt reads only the user's message and the trusted request context. It outputs a plan, capabilities, and `denied_implicit` patterns. In strict mode the plan is shown to the user for approval before execution.
3. Tuple writing. Each capability becomes an OpenFGA tuple `(user:{requestId}, can_invoke, tool_invocation:{agent}:{tool}#{resource})` with a TTL condition, in turns or wall-clock time.
4. Check per call. Every tool invocation runs one FGA check. The model is `can_invoke: [user with within_ttl] but not blocked`. Org deny tuples (for example `shell:exec#*`, `*:*#/etc/*`) are written at config time and "cannot be overridden by user approval or escalation."
5. Escalation on denial. A denial caused by a deny tuple is final (`canEscalate: false`). A denial caused by a missing allow tuple produces an escalation prompt.

**What the model decides versus the deterministic layer [verified].** The LLM decides only the *scope* of the grant, once, from trusted input, before any untrusted content is read: "Cr is fixed before any untrusted content is processed." OpenFGA makes every live allow or deny: "The FGA engine is the sole arbiter; the LLM agent has no write access to the FGA store." The intent parser is still probabilistic and can over-scope or under-scope. All 3 permissive-mode breaches came from wildcard over-scoping (`email:send#*`), not from bypassing the check.

**When intent is captured [verified].** Once per user request, before the agent touches tools. Tuples are scoped to a request ID and expire by TTL, with 2 to 3 turns suggested. Scope mode (strict or permissive) is set per deployment, not per request. Escalations add new tuples mid-request.

**Latency [verified].** About 9 ms per FGA check (8.8 ms strict, 7.9 ms permissive). The parser adds one LLM call per request, about 5,500 ms strict and about 6,800 ms permissive, using Claude Sonnet. The paper gives no hardware or load conditions.

**"Isn't this LLM-as-judge with extra steps?" [verified].** The paper's answer: a judge that checks whether a call "looks reasonable" does the same job as the intent parser, "but at the tool call boundary rather than up front, and without a formal authorization model backing it." IBAC's decisions are "deterministic once tuples are written." The blog adds that a judge shares a trust domain with the attack: "An attacker who can manipulate the agent's reasoning can potentially manipulate the judge too." The paper calls IBAC a complement to probabilistic defenses, not a replacement.

**Prompt-injection threat model [verified].** The attacker controls content the agent processes (documents, web pages, API responses) but not the user's message. The paper covers recipient substitution, exfiltration, lateral file read, scope expansion, privilege escalation, persistent backdoors (prevented by TTL and by the agent having no write path), escalation manipulation, and reference confusion. Its stated limits:
- Only one resource argument is constrained, so an email body is not.
- String matching causes false denials.
- The parser is probabilistic.
- Escalation fatigue.

The paper says it does "not claim to solve prompt injection in general."

**Failure behavior [partly unverified].** The paper does not say what happens if the parser LLM or OpenFGA is down, or if the parser is unsure. Denial is the default by construction (no tuple means no call), so a missing parse would yield no grants. That is fail-closed in effect, but it is never stated. Parser uncertainty is handled only through the strict/permissive mode choice and escalation.

**Approvals and human in the loop [verified].**
- The escalation prompt is generated by the system from the denied call's parameters, not from agent text. For example: "The agent wants to send email to attacker@evil.com. Allow this?"
- The user's yes or no plus that prompt go back through the intent parser, which writes a narrow tuple.
- The default cap is 5 escalations per request.
- The paper names escalation fatigue as an open risk, and its "about 80% utility with escalation" figure comes from human classification of denied calls, not a user study.
- Headline results on AgentDojo (240 injection runs):

| Mode | Security | Automated utility |
|---|---|---|
| Strict | 100% | 33.3% (about 80% estimated with escalation) |
| Permissive | 98.8% | 65.8% |

**Note on responses.** IBAC does not inspect tool results at all. It contains the *consequence* of injected results at the next call.

## 2. Composio Firewall

Sources:
- Docs: https://docs.composio.dev/docs/firewall (also `.md`)
- Launch post: https://composio.dev/blog/introducing-composio-firewall (Oct 21, 2026)
- Product page: https://composio.dev/firewall
- Pricing: https://composio.dev/pricing
- Third-party review: https://explainx.ai/blog/composio-firewall-blocks-prompt-injection-tool-results-agents-claimed-vs-verified-2026

**Status [verified].** The docs page carries an "Experimental" label in its HTML. The launch post says it is "live now for all Composio developers."

**What it controls [verified].**
- `before_execute` hooks inspect the tool name and arguments before the call runs.
- `after_execute` hooks inspect the returned data before the agent reads it, and "can't undo the tool call."
- A built-in `prompt_injection_check` handler screens results.
- Coverage includes toolkit calls, proxy calls to a toolkit's API, and calls from Workbench scripts and multi-execute.
- Hooks do **not** run on Composio meta tools.

**Rule language [verified].** There is no rule language. Each check is a natural-language `condition` on a `condition_check` handler, scoped with `applies_to` (a list of toolkits or `"all"`). The docs warn that conditions must describe the thing to match ("Sharing internal pricing with anyone outside acme.com"), not instruct the agent ("Don't share..."). Example:

```python
hooks=[{"id": "no_pricing_to_customers", "type": "before_execute",
        "applies_to": {"toolkits": ["gmail"]},
        "handler": {"type": "condition_check",
                    "condition": "Sharing internal pricing with anyone outside acme.com",
                    "action": "block"}}]
```

**Does a model decide? [verified]** Yes, entirely.
- A classifier compares each call or result to the condition. It also considers earlier session activity, to catch chains such as copying from a pricing sheet and then emailing a customer.
- Under zero data retention (ZDR) the classifier loses that history and judges each call in isolation.
- The launch post says actions are evaluated with "Jev and custom small language models tuned by Composio on real-world usage data." The third-party review did not find Jev mentioned, but the launch post does name it.

**Model direction [verified].** The only documented action is `block`. If any hook blocks, the call is blocked, and the agent receives `Blocked by session policy` with a `block_reason`. The model can only tighten: there is no allow-override and no deterministic allow layer. Default is allow unless a condition matches.

**Approvals [unverified].** The Firewall docs mention no approval or redact action. The Composio homepage, as cited by explainx, says actions "can be limited or put behind approval," but that is a separate feature from Firewall hooks.

**Failure behavior [unverified].** No source says what happens when the classifier is down or slow. The product page lists "Added time... typical and worst case" as a metric but shows no numbers.

**Pricing and licensing.**
- **[verified]** Not on the Free plan. Included on Standard and Enterprise, with plain-English policies billed at $0.50 per 1M tokens beyond plan credits.
- **[unverified]** No source says Firewall is open source. Assume it is closed and hosted only.

**Tie to Composio connections [verified].** Hooks attach to a Composio **session**, set at `composio.create(user_id=..., hooks=[...])` and replaced in full by `session.update()`. They only see traffic flowing through Composio's runtime and managed auth. **[unverified]** The docs do not describe scoping per connected account or per project.

## 3. WorkOS Airlock (brief)

Source: https://workos.com/blog/airlock-deterministic-rules-runtime-checks (Sep 23, 2026); see also https://workos.com/blog/ai-agent-approval-policies-airlock. WorkOS brands Airlock as "IBAC" but it is a separate product from Potti's paper.

**[verified]** Fixed rules run first and are default-deny. A runtime AI verdict runs only for calls those rules allowed, and only can keep the allow, send to a human, or deny: "A favorable runtime verdict preserves the fixed allow. It cannot reopen a call the fixed rules denied." It fails closed: "If a required runtime evaluation fails, the call is denied."

**[verified, from search summaries of the approvals post]** An approval is a one-time pass bound to the same org, user, and intent. A retry with a changed recipient must be refused, and the approver's identity must be verified server-side. It is in early access.

## Implications for heel's model adapter

Common ground across all three: none of them lets a model turn a deterministic "no" or "ask" into a live "yes."
- IBAC lets a model *widen scope*, but only from trusted input (the user's own words, or a system-generated escalation the user approved), and only before untrusted content is seen.
- Airlock and Composio let a model only tighten.

The fixed set stays out of the model's reach under both options below: org denies, hard denies, pause, and hidden targets.

### Option (a): the model may only tighten (allow to ask, allow to deny, ask to deny)

- **Pros**
  - Keeps heel's current spec promise intact. No model output can cause a live call that rules did not already allow, so a compromised or confused model can at worst cost availability.
  - Matches Airlock and Composio.
  - Fail-closed behavior is simple: if the model is down or times out, keep the rule's verdict or degrade it to `ask`, never to `allow`.
  - Easy to explain and audit.
- **Cons**
  - Does nothing for approval fatigue. It can add asks.
  - A noisy model makes fatigue worse.

### Option (b): the model may also loosen an owner-rule `ask` to `allow`, when confident, audited, and switchable per rule

- **Pros**
  - Directly targets fatigue on calls that are obviously fine.
  - The per-rule switch keeps the blast radius owner-chosen.
- **Cons**
  - This is LLM-as-judge at the call boundary, the exact pattern IBAC argues against. The judge sees call arguments, which the attacker can shape, and possibly session context. Any injection that crafts a "benign-looking" call can also persuade the judge, so the `ask` that was meant to catch it disappears silently.
  - "Confident" is not calibrated security. Model confidence under adversarial input is the thing attackers optimize against.
  - Breaks the spec's current invariant, and makes heel's guarantees depend on a model version.
  - Audit after the fact cannot undo a sent email or a dropped table.
  - No surveyed product ships this.

### Recommendation

Ship **(a)** in the adapter chain, and fix fatigue with deterministic or human-derived grants rather than model loosening. The IBAC pattern, adapted to heel:

1. **Approval-scoped grants.** When a person approves an `ask` with a passkey, offer "allow this exact target and arguments pattern for this task or session, TTL N." heel writes a narrow, expiring allow derived from the system-rendered call. IBAC's escalation prompt is generated from the denied call's parameters, not from agent text, and Airlock binds approvals the same way.
2. **Optional up-front intent grants.** The owner states a task. A model may *propose* a narrow grant set from that trusted text only. The person confirms it once, and heel's rules engine enforces it deterministically. Here the model drafts policy for a human to sign, not live verdicts.
3. **The model may sort and annotate the approval queue**, for example "looks routine" or "new recipient", to make human review faster. It does not answer for the person.

If the team still wants (b), treat it as an explicit, off-by-default experiment with these guards:
- Opt-in per rule, with a visible owner flag.
- Limited to read-only or reversible effect classes, never sends, deletes, payments, or permission changes.
- The model sees only the system-rendered call (tool, target, structured arguments), never raw tool responses or agent prose.
- Any error, timeout, or below-threshold confidence falls back to `ask`.
- Rate and budget caps per session, plus a sampled after-the-fact human review.
- An exact-arguments binding so a loosened call cannot be swapped before it executes.

Even then, document it as weakening heel's injection guarantee for those rules.

### Not verified

- The Rivian affiliation.
- IBAC behavior when the parser or OpenFGA is unavailable. It is fail-closed by construction but never stated.
- Composio Firewall's failure behavior, latency figures, open-source status, per-connected-account scoping, and any approval action inside Firewall itself.
- Airlock's approval-binding details, which come from search summaries rather than a full read of that post.
