/**
 * Pure helpers for `pnpm test:invariants`: find the invariant ids (`I-xx`)
 * that test titles claim to prove, and which required ids no test claims.
 */

/** An invariant id as the spec writes it: `I-` and two or more digits. */
export const INVARIANT_ID = /^I-\d{2,}$/;
const INVARIANT_ID_IN_TEXT = /\bI-\d{2,}\b/g;

/**
 * `it(`/`test(` with optional chained modifiers, then a string-literal title.
 * The lookbehind skips member calls such as `regex.test("…")`.
 * Group 1 is the modifier chain, group 2 the quote, group 3 the title.
 */
const TEST_CALL =
  /(?<![\w$.])(?:it|test)((?:\.[A-Za-z]+(?:\([^()]*\))?)*)\s*\(\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;

/**
 * Modifiers that may keep a test from running or passing in CI. A test that
 * is skipped, conditional, todo or expected to fail proves nothing, so its
 * tag doesn't count.
 */
const NON_PROVING_MODIFIERS = new Set(["skip", "skipIf", "runIf", "todo", "fails"]);

export interface TestTitle {
  title: string;
  /** False when a modifier means the test may not run, or must fail. */
  proves: boolean;
}

function modifierNames(chain: string): string[] {
  return [...chain.matchAll(/\.([A-Za-z]+)/g)].map((match) => match[1] ?? "");
}

/**
 * Pure: the titles of every `it`/`test` call in a test file. Titles built at
 * runtime (`it.each`, computed strings) aren't literal and are not found, so
 * they can't satisfy a listed invariant: tag a plain `it` instead.
 */
export function testTitles(source: string): TestTitle[] {
  return [...source.matchAll(TEST_CALL)].map((match) => {
    const modifiers = modifierNames(match[1] ?? "");
    return {
      title: match[3] ?? "",
      proves: !modifiers.includes("each") && !modifiers.some((m) => NON_PROVING_MODIFIERS.has(m)),
    };
  });
}

/** Pure: how many proving tests tag each invariant id. */
export function countTaggedIds(titles: readonly TestTitle[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { title, proves } of titles) {
    if (!proves) continue;
    // A title that names an id twice still counts once.
    for (const id of new Set(title.match(INVARIANT_ID_IN_TEXT))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export interface InvariantReport {
  /** Required ids with no proving test. */
  missing: string[];
  /** Ids tagged in tests but not on the required list: a typo, or a list to extend. */
  unlisted: string[];
}

/** Pure: compares the required list with what the tests claim. */
export function checkInvariants(
  required: readonly string[],
  tagged: ReadonlyMap<string, number>,
): InvariantReport {
  const requiredSet = new Set(required);
  return {
    missing: required.filter((id) => (tagged.get(id) ?? 0) === 0),
    unlisted: [...tagged.keys()].filter((id) => !requiredSet.has(id)).sort(compareIds),
  };
}

/** Orders `I-2` before `I-10`. */
export function compareIds(a: string, b: string): number {
  return Number(a.slice(2)) - Number(b.slice(2));
}
