import { type Document, isNode, LineCounter, parseDocument } from "yaml";
import type { z } from "zod";

/** One problem in a YAML file, located for the person who has to fix it. */
export interface YamlIssue {
  file: string;
  line: number;
  col: number;
  /** Dotted path to the offending value, empty for document-level problems. */
  path: string;
  message: string;
}

export class YamlValidationError extends Error {
  readonly issues: readonly YamlIssue[];

  constructor(issues: readonly YamlIssue[]) {
    super(issues.map(formatYamlIssue).join("\n"));
    this.name = "YamlValidationError";
    this.issues = issues;
  }
}

export function formatYamlIssue(issue: YamlIssue): string {
  const where = `${issue.file}:${issue.line}:${issue.col}`;
  return issue.path ? `${where}: ${issue.path}: ${issue.message}` : `${where}: ${issue.message}`;
}

/** A position in a source file, 1-based. */
export interface SourcePos {
  line: number;
  col: number;
}

/** A parsed YAML document that can still say where each value came from. */
export interface ParsedYaml {
  file: string;
  value: unknown;
  /** Where the value at `path` starts; a missing path points at its deepest existing parent. */
  locate(path: readonly PropertyKey[]): SourcePos;
}

/**
 * Parses YAML 1.2 (core schema, duplicate keys rejected). Syntax errors throw
 * a YamlValidationError carrying file, line and column (spec: Rules, "Loading,
 * testing and reload"). An empty file is an empty mapping.
 */
export function parseYamlDocument(source: string, file: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
    lineCounter,
  });

  const syntaxIssues: YamlIssue[] = [...doc.errors, ...doc.warnings].map((error) => {
    const pos = lineCounter.linePos(error.pos[0]);
    return { file, line: pos.line, col: pos.col, path: "", message: error.message };
  });
  if (syntaxIssues.length > 0) throw new YamlValidationError(syntaxIssues);

  const value: unknown = doc.contents === null ? {} : doc.toJS({ maxAliasCount: 100 });
  return {
    file,
    value,
    locate: (path) => lineCounter.linePos(locateOffset(doc, path)),
  };
}

/** Builds a located issue for a path in a parsed document. */
export function issueAt(
  parsed: ParsedYaml,
  path: readonly PropertyKey[],
  message: string,
): YamlIssue {
  const pos = parsed.locate(path);
  return {
    file: parsed.file,
    line: pos.line,
    col: pos.col,
    path: path.map(String).join("."),
    message,
  };
}

/** Validates a parsed document with a Zod schema; every issue is located. */
export function validateYaml<S extends z.ZodType>(parsed: ParsedYaml, schema: S): z.output<S> {
  const result = schema.safeParse(parsed.value);
  if (result.success) return result.data;
  throw new YamlValidationError(
    explainIssues(result.error.issues, []).map((issue) =>
      issueAt(parsed, issue.path, issue.message),
    ),
  );
}

/**
 * A union reports one vague "invalid input" when no branch accepts the value.
 * When exactly one branch accepted the value's type (an operator object
 * against `string | {operators}`), its own issues say what is actually wrong,
 * e.g. an empty list or a bad enum value, so report those instead.
 */
function explainIssues(
  issues: readonly z.core.$ZodIssue[],
  base: readonly PropertyKey[],
): { path: PropertyKey[]; message: string }[] {
  return issues.flatMap((issue) => {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union") {
      const applicable = issue.errors.filter((branch) => !rejectsTypeOnly(branch));
      const [only] = applicable;
      if (applicable.length === 1 && only !== undefined) return explainIssues(only, path);
    }
    return [{ path, message: issue.message }];
  });
}

function rejectsTypeOnly(branch: readonly z.core.$ZodIssue[]): boolean {
  const [first] = branch;
  return branch.length === 1 && first?.code === "invalid_type" && first.path.length === 0;
}

/**
 * Parses and validates in one step; heel.yaml, the rules files and the
 * `heel rules test` case files share this.
 */
export function parseYamlStrict<S extends z.ZodType>(
  source: string,
  file: string,
  schema: S,
): z.output<S> {
  return validateYaml(parseYamlDocument(source, file), schema);
}

/**
 * Finds the source offset for a schema path: the deepest node that exists on
 * that path. A missing key points at its parent mapping.
 */
function locateOffset(doc: Document, path: readonly PropertyKey[]): number {
  for (let depth = path.length; depth >= 0; depth -= 1) {
    const node: unknown = doc.getIn(path.slice(0, depth), true);
    if (isNode(node) && node.range) return node.range[0];
  }
  return 0;
}
