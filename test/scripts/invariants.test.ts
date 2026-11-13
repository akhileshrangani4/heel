import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  compareIds,
  countTaggedIds,
  type TestTitle,
  testTitles,
} from "../../scripts/lib/invariants.ts";

/**
 * Builds test-call source at runtime so this file's own text never contains
 * a literal tagged call that `pnpm test:invariants` would count as coverage.
 */
function call(fn: string, title: string, quote = '"'): string {
  return `${fn}(${quote}${title}${quote}, () => {});`;
}

describe("testTitles", () => {
  it("finds it and test titles in every quote style", () => {
    const source = [
      call("it", "I-02: double"),
      call("test", "I-03: single", "'"),
      call("it", "I-04: template", "`"),
    ].join("\n");
    expect(testTitles(source)).toEqual([
      { title: "I-02: double", proves: true },
      { title: "I-03: single", proves: true },
      { title: "I-04: template", proves: true },
    ]);
  });

  it("keeps escaped quotes inside a title", () => {
    expect(testTitles(call("it", 'I-02: the \\"secret\\" field')).map((t) => t.title)).toEqual([
      'I-02: the \\"secret\\" field',
    ]);
  });

  it("counts concurrent and sequential tests as proving", () => {
    const source = [call("it.concurrent", "a"), call("test.sequential", "b")].join("\n");
    expect(testTitles(source).map((t) => t.proves)).toEqual([true, true]);
  });

  it("does not count skipped, conditional, todo, failing or parameterized tests", () => {
    const source = [
      call("it.skip", "skip"),
      call("it.skipIf(process.env.CI)", "skipIf"),
      call("test.runIf(isLinux)", "runIf"),
      call("it.todo", "todo"),
      call("it.fails", "fails"),
      call("it.each([1, 2])", "each %s"),
    ].join("\n");
    expect(testTitles(source).map((t) => t.proves)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("ignores describe blocks, member calls and identifiers that end in it or test", () => {
    const source = [
      call("describe", "I-02: a suite"),
      call("INVARIANT_ID.test", "I-02"),
      call("submit", "I-02"),
      call("latest", "I-02"),
      call("$it", "I-02"),
    ].join("\n");
    expect(testTitles(source)).toEqual([]);
  });

  it("finds a title split from its call by a newline", () => {
    expect(testTitles('it(\n  "I-73: spans lines",\n  () => {},\n);')).toEqual([
      { title: "I-73: spans lines", proves: true },
    ]);
  });
});

describe("countTaggedIds", () => {
  const title = (text: string, proves = true): TestTitle => ({ title: text, proves });

  it("counts each proving test once per id it names", () => {
    const tagged = countTaggedIds([
      title("I-02: one"),
      title("I-02, I-03: two ids"),
      title("I-03: names I-03 twice"),
      title("no id"),
    ]);
    expect(Object.fromEntries(tagged)).toEqual({ "I-02": 2, "I-03": 2 });
  });

  it("ignores tags on tests that don't prove anything", () => {
    expect(countTaggedIds([title("I-02: skipped", false)]).size).toBe(0);
  });

  it("needs two or more digits and a word boundary", () => {
    const tagged = countTaggedIds([title("I-2 is too short"), title("XI-04 and I-045x")]);
    expect(tagged.size).toBe(0);
  });
});

describe("checkInvariants", () => {
  it("reports listed ids with no tagged test", () => {
    const tagged = new Map([["I-02", 3]]);
    expect(checkInvariants(["I-02", "I-03"], tagged)).toEqual({ missing: ["I-03"], unlisted: [] });
  });

  it("passes when every listed id has a tagged test", () => {
    const tagged = new Map([
      ["I-02", 1],
      ["I-73", 2],
    ]);
    expect(checkInvariants(["I-02", "I-73"], tagged).missing).toEqual([]);
  });

  it("reports tagged ids missing from the list in numeric order", () => {
    const tagged = new Map([
      ["I-25", 1],
      ["I-02", 1],
      ["I-100", 1],
      ["I-9", 1],
    ]);
    expect(checkInvariants(["I-02"], tagged).unlisted).toEqual(["I-9", "I-25", "I-100"]);
  });

  it("orders ids numerically, not lexically", () => {
    expect(["I-73", "I-100", "I-04"].sort(compareIds)).toEqual(["I-04", "I-73", "I-100"]);
  });
});
