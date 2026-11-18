# Why heel

[README](../README.md) · [Using heel](using-heel.md) · [Why heel](why.md) · [How it works](how-it-works.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

## The problem

Agent permissions mostly stop at the tool: allow `send_email`, ask first, or block it. What people actually need to say is about the arguments:

| What you want to say | Why today's tools can't |
| --- | --- |
| "Send only to coworkers already in this thread" | OAuth scopes can't express it, and most clients only see tool names. It also needs a lookup of the thread first. |
| "Never email a client from my personal account" | Scopes are per service, not per account and recipient. |
| "Read my inbox, except password reset emails" | Nothing filters what comes back. An agent that reads your reset codes can sign in to your other accounts. |
| "No more than 20 deletes this run" | Rules see one call at a time. A limit needs a counter across calls. |

Gateways that do read arguments still leave gaps:

| Gap | Example |
| --- | --- |
| Approvals run inside the agent's session | Docker's MCP gateway docs say its approval prompt (in Docker Sandboxes) runs in the session, leaves out the arguments, and can be answered in code. An unattended agent can approve itself. |
| Approval settings live in each client | In [claude-code#99453](https://github.com/anthropics/claude-code/issues/99453), Gmail send was set to "Needs approval", but Projects thread sessions sent with no prompt. |
| Stopping a run means revoking credentials or killing the process | There's no switch that stops one agent and leaves the rest running. |

## Intent-based access control

An agent is useful because it can act, and dangerous for the same reason: what it reads can steer it. So the question for every call isn't "may this agent use Gmail" but "is this call what its owner meant it to do". heel answers that from intent you give it, never from what the agent says about itself.

| How intent reaches heel | What it looks like | Status |
| --- | --- | --- |
| **Rules you write down** | "Send only to coworkers already in the thread." "Ask before deleting more than 20 messages." Rules check the call's actual arguments, and the first match decides. | In v0.1 |
| **A person, when a call falls outside them** | The call waits for its owner, who approves or denies it with a passkey. An approval can become a grant: this exact call, everything that rule asks about, or this run. | In v0.1 (grants for a run: planned) |
| **A task stated up front** | Describe what a run is for. A model proposes narrow grants from your words alone, before the agent reads anything. You confirm them once, and the rules enforce them. | Planned |

**A model never decides a live call.** Whoever shapes a call (say, an injected instruction in an email) could shape a model judging it too, so every decision comes from rules, grants and people. Checks you plug in beside the rules (your own security service, an OpenFGA store, a classifier) can stop a call but never let one through.

## Where this comes from

We run a narrower version of this in production at [Charming](https://charm.ing), where apps that agents build call people's Gmail, GitHub, and other connected accounts. Each app function declares the tools it uses, the account owner approves each function, and the approval lapses when the function's tools, output, or allowed callers change. A classifier screens every tool across 124 services and keeps out the ones that leave access behind after a revoke. heel takes that model out of one product and puts it in front of any agent.

See also [incidents heel would have stopped](incidents.md) and [how it compares](comparison.md).
