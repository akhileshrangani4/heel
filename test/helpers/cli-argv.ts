import fc from "fast-check";
import type { CliArgv, CliNormalization } from "../../src/definitions/cli/index.ts";

/** One flag, in every spelling the CLI accepts (`["-n", "prod"]`, `["--namespace=prod"]`, …). */
export type FlagSpellings = readonly (readonly string[])[];

export interface CobraCommandLine {
  readonly command: string;
  /** The command path as typed, e.g. `["pr", "merge"]`. */
  readonly path: readonly string[];
  /** Flags cobra knows at the root (persistent there), so they may also go before the path. */
  readonly early?: readonly FlagSpellings[];
  /** Flags that belong to the resolved command: only valid after the path. */
  readonly late?: readonly FlagSpellings[];
  /** Positional arguments, kept in their relative order. */
  readonly positionals?: readonly string[];
}

/**
 * Every argv order cobra itself accepts for one command: each flag in any
 * spelling, early flags before or after the path, and flags interleaved with
 * positionals in any position after it. Local flags never go before the path,
 * where cobra would read them as unknown and swallow the next word.
 */
export function cobraOrderings(line: CobraCommandLine): fc.Arbitrary<CliArgv> {
  const early = line.early ?? [];
  const late = line.late ?? [];
  const positionals = line.positionals ?? [];
  const spelled = (flags: readonly FlagSpellings[]) =>
    fc.tuple(...flags.map((spellings) => fc.constantFrom(...spellings)));
  const total = early.length + late.length + positionals.length;
  return fc
    .record({
      early: spelled(early),
      late: spelled(late),
      beforePath: fc.array(fc.boolean(), { minLength: early.length, maxLength: early.length }),
      merge: fc.array(fc.boolean(), { minLength: total, maxLength: total }),
    })
    .chain((drawn) => {
      const before = drawn.early.filter((_, i) => drawn.beforePath[i] === true);
      const after = [...drawn.early.filter((_, i) => drawn.beforePath[i] !== true), ...drawn.late];
      return fc
        .shuffledSubarray(after, { minLength: after.length, maxLength: after.length })
        .map(
          (shuffled): CliArgv => [
            line.command,
            ...before.flat(),
            ...line.path,
            ...interleave(shuffled, positionals, drawn.merge),
          ],
        );
    });
}

/** Merges flag groups into positionals, keeping each list's own order; `picks[i]` takes a flag group. */
function interleave(
  flags: readonly (readonly string[])[],
  positionals: readonly string[],
  picks: readonly boolean[],
): string[] {
  const flagQueue = [...flags];
  const positionalQueue = [...positionals];
  const out: string[] = [];
  for (const pickFlag of picks) {
    const flag = pickFlag || positionalQueue.length === 0 ? flagQueue.shift() : undefined;
    if (flag !== undefined) {
      out.push(...flag);
      continue;
    }
    const positional = positionalQueue.shift();
    if (positional !== undefined) out.push(positional);
  }
  return [...out, ...flagQueue.flat(), ...positionalQueue];
}

/** What rules and the pre-rule refusals see, without the raw argv (which differs by design). */
export function meaning(normalized: CliNormalization): unknown {
  const { argv: _argv, ...cli } = normalized.cli;
  return {
    cli,
    action: normalized.action,
    kind: normalized.kind,
    repo: normalized.repo,
    persistence: normalized.persistence,
    help: normalized.help,
    refusals: normalized.refusals,
  };
}
