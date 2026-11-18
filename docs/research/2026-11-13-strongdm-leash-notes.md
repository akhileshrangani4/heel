# Notes from StrongDM Leash

Source: github.com/strongdm/leash, read at its last commit (April 6, 2026). It's Apache 2.0 and written in Go. StrongDM was acquired by Delinea in March 2026, and the repo has been quiet since.

## What it is

Leash runs a coding agent (Claude Code, Codex, Gemini) inside a container and governs what that container does:

- **In the kernel (eBPF LSM hooks):** which files the agent opens (read or write), which programs it runs, and which hosts it connects to.
- **In a TLS-intercepting proxy:** which HTTP hosts it reaches. The proxy also swaps a fake token in a request header for the real one, so the agent never holds the credential.
- **In an MCP observer inside that proxy:** which MCP servers and tools the agent calls.

Policies are written in Cedar and translated into Leash's own rule structures in memory. A web UI (the Control UI) streams every event live.

## What heel should take

1. **Three modes, switchable live with no restart:**
   - **Record:** allow everything, log everything.
   - **Shadow:** evaluate the rules and log `would_deny`, but allow everything.
   - **Enforce.**

   heel's watch mode is shadow. Record is worth adding as the first step of a rollout, and the mode should be switchable from the dashboard.

2. **Rules generated from what agents actually did.** Leash has `log2cedar`, and its UI can turn an observed event into a policy. For an enterprise rollout this is the main path: run in record mode for a week, then heel proposes a rule file from the traffic for a person to review. The UI requires both server and tool before generating an MCP rule, so one click can't block a whole server by accident.
3. **Every decision is a structured event, allowed ones too, streamed live.** The UI, audit log and SIEM export all read the same stream. This is the backbone of the observability side.
4. **Cedar as the policy language.** Leash chose it because it's readable, version-controlled, diffable, and the same vocabulary across products. Stacklok ToolHive and AWS Verified Permissions use it too, so enterprise security teams may already know it.
5. **A linter that refuses rules the engine can't enforce.** Errors carry file, line, column, a snippet and a suggested fix, and there's a validate endpoint the UI calls inline. heel needs the same: for example, reject a run limit with no hourly limit, or a field the action doesn't have.
6. **Strict custody of secrets.**
   - The private CA key lives on a mount only the manager can read.
   - Files are written with exact permissions.
   - The daemon refuses to start if the private directory is too open.

   For heel, refuse to start without a strong token-encryption key, and never put provider tokens anywhere the agent's side can read.

7. **Fail closed upstream.** If the proxy can't reach the upstream, the agent sees a failure, never a bypass.

## What heel should not copy

- **Kernel and container enforcement.** It fits a coding agent on one machine. heel governs calls to remote services from agents running anywhere, including in another company's cloud (Grok, ChatGPT, Claude). There's no machine for heel to sit on.
- **Deny-only MCP rules.** Leash can block an MCP tool but can't allow one, and it reads only the tool name, never the arguments.
- **No identity per person.** Rules apply to the whole container. An enterprise needs rules per person, group and agent.

## Signal

Leash's own "future directions" list includes "deny-by-default MCP enforcement with explicit permit rules" and "human-in-the-loop approval workflows". Both are at the center of heel, and Leash never built either.
