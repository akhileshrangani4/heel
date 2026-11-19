import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { DENY_REASONS } from "../../src/core/rules/evaluate.ts";
import { FIXED_MATCH_KEYS } from "../../src/core/rules/schema.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Every example in docs/rules-reference.md, run through `heel rules check`
 * and `heel rules test` in a fresh HEEL_HOME, so the page can't show a rule
 * that doesn't load or a case that doesn't hold.
 *
 * The page's conventions:
 * - A `yaml` block's `title` is the file it is: `rules/owner.yaml`,
 *   `org-rules.yaml` or `cases.yaml`. Untitled yaml blocks aren't allowed.
 * - Rules files accumulate until a `cases.yaml` block, which runs them; the
 *   next rules file starts a new example.
 * - A `text` block starting `$ heel rules test cases.yaml` or `$ heel rules
 *   check` is that command's exact output, with `~/.heel` for HEEL_HOME.
 * - Every rules file is run by cases or shown with its check output.
 */

const PAGE = join(import.meta.dirname, "..", "..", "docs", "rules-reference.md");
const page = readFileSync(PAGE, "utf8");

interface Block {
  lang: string;
  title: string | null;
  body: string;
  line: number;
}

function blocks(markdown: string): Block[] {
  const found: Block[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)(?: title="([^"]+)")?$/.exec(lines[i] ?? "");
    if (open === null) continue;
    const start = i;
    const body: string[] = [];
    for (i += 1; i < lines.length && lines[i] !== "```"; i++) body.push(lines[i] ?? "");
    found.push({
      lang: open[1] ?? "",
      title: open[2] ?? null,
      body: `${body.join("\n")}\n`,
      line: start + 1,
    });
  }
  return found;
}

const RULES_FILES = new Set(["rules/owner.yaml", "org-rules.yaml"]);
const HOME_SHOWN = "~/.heel";

interface Run {
  code: number;
  output: string;
}

async function heel(argv: string[], home: string): Promise<Run> {
  let output = "";
  const io: CliIo = {
    env: { HEEL_HOME: home },
    stdin: (async function* () {})(),
    stdout: { write: (text) => (output += text) },
    stderr: { write: (text) => (output += text) },
  };
  const code = await main(argv, io);
  return { code, output: output.replaceAll(home, HOME_SHOWN) };
}

/** A command's shown output: the `$ heel ...` line, then what it printed. */
function shownOutput(block: Block | undefined, command: string): string | null {
  if (block?.lang !== "text") return null;
  const prompt = `$ heel ${command}\n`;
  return block.body.startsWith(prompt) ? block.body.slice(prompt.length) : null;
}

interface Example {
  line: number;
  files: Map<string, string>;
  cases: string | null;
  /** The shown output of `heel rules test`, when the page shows it. */
  testOutput: string | null;
  /** The shown output of `heel rules check`, when the page shows it. */
  checkOutput: string | null;
}

function examples(all: readonly Block[]): Example[] {
  const found: Example[] = [];
  let current: Example | null = null;
  all.forEach((block, i) => {
    const next = all[i + 1];
    if (block.lang === "yaml") {
      if (block.title === null) throw new Error(`line ${block.line}: a yaml block needs a title`);
      if (RULES_FILES.has(block.title)) {
        if (current === null || current.cases !== null || current.checkOutput !== null) {
          current = {
            line: block.line,
            files: new Map(),
            cases: null,
            testOutput: null,
            checkOutput: null,
          };
          found.push(current);
        }
        current.files.set(block.title, block.body);
      } else if (block.title === "cases.yaml") {
        if (current === null) throw new Error(`line ${block.line}: cases with no rules above them`);
        current.cases = block.body;
        current.testOutput = shownOutput(next, "rules test cases.yaml");
      } else {
        throw new Error(`line ${block.line}: unknown file title "${block.title}"`);
      }
    } else if (current !== null) {
      const check = shownOutput(block, "rules check");
      if (check !== null) current.checkOutput = check;
    }
  });
  return found;
}

const all = blocks(page);
const pageExamples = examples(all);

/** A HEEL_HOME holding the example's files, and its cases file's path. */
function homeFor(example: Example): { home: string; cases: string } {
  const home = tempDir("heel-rules-reference-");
  for (const [path, content] of example.files) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), content);
  }
  const cases = join(home, "cases.yaml");
  if (example.cases !== null) writeFileSync(cases, example.cases);
  return { home, cases };
}

describe("docs/rules-reference.md examples", () => {
  it("has examples, and every one is run by cases or shown with its check output", () => {
    expect(pageExamples.length).toBeGreaterThan(20);
    for (const example of pageExamples) {
      expect(
        example.cases !== null || example.checkOutput !== null,
        `the example at line ${example.line} has no cases and no check output`,
      ).toBe(true);
    }
  });

  for (const example of pageExamples) {
    const files = [...example.files.keys()].join(" and ");
    it(`line ${example.line}: ${files} load as shown`, async () => {
      const { home } = homeFor(example);
      const result = await heel(["rules", "check"], home);
      if (example.checkOutput !== null) {
        expect(result.output).toBe(example.checkOutput);
      } else {
        expect(result.code).toBe(EXIT.ok);
        expect(result.output).not.toContain("warn");
      }
    });

    if (example.cases === null) continue;
    it(`line ${example.line}: its cases decide as shown`, async () => {
      const { home, cases } = homeFor(example);
      const result = await heel(["rules", "test", cases], home);
      if (example.testOutput !== null) {
        expect(result.output).toBe(example.testOutput);
      } else {
        expect(result.output).not.toMatch(/^(FAIL|ERROR)/m);
        expect(result.code).toBe(EXIT.ok);
      }
    });
  }
});

/** The rows of the first table after `heading`, as cells. */
function tableAfter(heading: string): string[][] {
  const start = page.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`no "${heading}" heading`);
  const lines = page.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("| "));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

const code = (cell: string | undefined) => /^`([^`]+)`$/.exec(cell ?? "")?.[1] ?? null;

describe("docs/rules-reference.md match keys table", () => {
  const rows = tableAfter("## Match keys");

  it("lists every match key", () => {
    const keys = rows.map((row) => code(row[0]));
    for (const key of FIXED_MATCH_KEYS) expect(keys).toContain(key);
    for (const dotted of ["args.<path>", "body.<path>", "query.<name>", "flags.<name>"]) {
      expect(keys).toContain(dotted);
    }
  });

  it("has examples that load", async () => {
    const rules = rows.map((row) => {
      const example = code(row[3]);
      if (example === null) throw new Error(`no example for ${row[0]}`);
      return `  - match: { ${example} }\n    then: deny\n`;
    });
    const home = tempDir("heel-rules-reference-");
    mkdirSync(join(home, "rules"));
    writeFileSync(join(home, "rules/owner.yaml"), `rules:\n${rules.join("")}`);
    const result = await heel(["rules", "check"], home);
    expect(result.output).toBe(
      `ok    rules/owner.yaml (user owner): ${rows.length} rules, 0 hide entries\n`,
    );
  });
});

describe("docs/rules-reference.md deny reasons", () => {
  it("lists every reason a call is denied", () => {
    const reasons = tableAfter("## How a call is decided").map((row) => code(row[0]));
    expect(reasons).toEqual([...DENY_REASONS]);
  });
});
