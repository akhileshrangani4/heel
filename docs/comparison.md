# How heel compares

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

| Project | What it is | How it decides | Where it differs from heel |
| --- | --- | --- | --- |
| **IBAC** ([ibac.dev](https://ibac.dev)) | A paper by Jordan Potti that named the idea | A model reads only the user's request and writes OpenFGA grants up front; OpenFGA checks every call | Needs OpenFGA. heel shares the principle and adds counts, thread checks, hiding, approvals tied to the exact call, and pause. |
| **WorkOS Airlock** | Closed, early access | Endpoints and arguments, plus optional model-judged runtime rules | Approvals go to Slack. Closed and hosted. |
| **Keycard** | Closed | One policy across shell commands, MCP tools and API calls | Closed. |
| **Overslash** | Source-available (Elastic License), pre-release | Vault; MCP, REST, CLI and HTTP; each action scoped by one argument | Approvals by dashboard, email or webhook, with "allow & remember". The closest in shape. |
| **airlock-dev/airlock** | MIT | MCP, CLI, REST and HTTP; allow, ask or deny by tool name | No argument checks that we found. Approvals over Telegram, Slack and iOS push. |
| **Archestra** | Open source MCP gateway | Argument matching, such as every `to` address in a domain | Argument rules are in a paid tier. |
| **IBM ContextForge** | Open source MCP gateway | Plugins with Cedar and OPA over MCP and REST | Its CPEX layer ties approvals to arguments over CIBA. |
| **Stacklok ToolHive** | Open source MCP gateway | Cedar rules on arguments | A list argument only shows whether it's present. |
| **agentgateway** | Open source gateway | CEL rules over MCP and HTTP | |
| **Docker's MCP gateway** | Open source | Arguments only under a Docker Sandboxes organization policy | Approval runs inside the session. |
| **StrongDM Leash** | Apache 2.0 | Cedar on a coding agent's files, network and MCP calls, in a container | MCP rules can block a tool but not allow one; process rules see the binary, not its arguments. |
| **agent-chaperone** | Open source MCP proxy | A model screens each call and result against thresholds | A model decides live calls. |
| **Warden** (stephnangue/warden) | Open source | Holds credentials, checks MCP calls down to their arguments | Can carry the identity of the person the agent acts for. |
| **Composio, Arcade** | Connector platforms | Composio: allow, ask or block a tool by name or type, plus a classifier Firewall. Arcade: webhooks before execution, where you write the checks. | Tied to their connections. |
| **OpenClaw's approvals** | Built into the agent | Telegram, Slack and Signal prompts | They run inside the agent, which holds the credentials. |

None of the open source gateways documents counts across a run, thread checks, or a pause.

**What heel puts together:** intent enforced on every call by rules rather than a model (heel's one classifier can only hide a message), rules on arguments with state checks and item counts, hiding what the agent shouldn't read, approvals tied to the exact call that the agent can't answer, pause and resume, one rule file for MCP, HTTP and CLI, and an open source license.
