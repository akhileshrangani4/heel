import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../log.ts";
import type { SandboxHost } from "../../runner/plan.ts";
import type { StartSandboxed } from "../cli/definition.ts";
import { stdioSandboxSpec } from "./settings.ts";
import type { StdioLauncher } from "./upstream.ts";

/**
 * How heel starts a local (stdio) MCP server (spec: Upstream MCP servers,
 * N-8): in the sandbox, in a work directory of its own under heel's home and
 * nothing else of heel's, with the credential handled as `stdioSandboxSpec`
 * says. Refused egress, and requests heel's proxy refused to add the
 * credential to, are logged against the account.
 */
export function sandboxLauncher(deps: {
  host: SandboxHost;
  home: string;
  start: StartSandboxed;
  log: Logger;
}): StdioLauncher {
  return async (account, settings, credential) => {
    const workRoot = join(deps.home, "mcp", account.alias);
    mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    const spec = await stdioSandboxSpec(settings, { workRoot, credential, alias: account.alias });
    return deps.start(deps.host, spec, {
      onEgress: (decision) => {
        if (decision.allowed) return;
        deps.log.warn(
          { account: account.alias, target: decision.target, reason: decision.reason },
          "local MCP server: egress refused",
        );
      },
      onCredentialRequest: (event) => {
        if (event.refused === undefined) return;
        deps.log.warn(
          {
            account: account.alias,
            target: event.target,
            method: event.method,
            reason: event.refused,
          },
          "local MCP server: heel refused a request to a credential host",
        );
      },
    });
  };
}
