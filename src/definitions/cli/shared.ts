import type { CliFields } from "../../core/call.ts";
import type { ParsedArgs, ParseResult } from "./cobra.ts";
import type { CliArgv, CliNormalization } from "./types.ts";

/**
 * `Call.cli` for a parsed command: the first path segment is the verb, the
 * rest (`deploy-key add`) the subcommand. `argv` keeps the command name at
 * index 0, exactly as the agent sent it.
 */
export function cliFields(argv: CliArgv, parsed: ParsedArgs): CliFields {
  const [verb, ...rest] = parsed.path;
  return {
    command: argv[0],
    ...(verb !== undefined && { verb }),
    ...(rest.length > 0 && { subcommand: rest.join(" ") }),
    flags: { ...parsed.flags },
    argv: [...argv],
  };
}

/** A command heel can't read: raw argv only, and a refusal ahead of rules. */
export function unparseable(
  argv: CliArgv,
  failure: Extract<ParseResult, { ok: false }>,
): CliNormalization {
  return {
    cli: { command: argv[0], flags: {}, argv: [...argv] },
    help: false,
    refusals: [{ kind: "unparseable", reason: failure.reason, detail: failure.detail }],
  };
}
