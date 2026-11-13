/**
 * The CLI runner's command-line normalization (spec: CLI runner). `gh` and
 * `kubectl` are parsed; every other command is unknown, so rules see only its
 * raw `argv` and nothing runs until a rule allows it (I-33).
 *
 * No command line is ever interpreted by a shell: `sh -c "gh auth token"` is
 * the command `sh` with two arguments, not a `gh` call (I-30).
 */
import { normalizeGh } from "./gh.ts";
import { normalizeKubectl } from "./kubectl.ts";
import type { CliArgv, CliNormalization } from "./types.ts";

export type { CliArgv, CliNormalization, CliRefusal } from "./types.ts";

// A Map, not an object literal, so `argv[0] = "toString"` can't reach a prototype method.
export const KNOWN_CLIS: ReadonlyMap<string, (argv: CliArgv) => CliNormalization> = new Map([
  ["gh", normalizeGh],
  ["kubectl", normalizeKubectl],
]);

/** Normalizes a command line by its configured command name (`argv[0]`). */
export function normalizeCliArgv(argv: CliArgv): CliNormalization {
  const known = KNOWN_CLIS.get(argv[0]);
  if (known !== undefined) return known(argv);
  return { cli: { command: argv[0], flags: {}, argv: [...argv] }, help: false, refusals: [] };
}
