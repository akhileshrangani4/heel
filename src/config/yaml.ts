import { isNode, LineCounter, parseDocument } from "yaml";
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

/**
 * Parses YAML 1.2 (core schema, duplicate keys rejected) and validates it with
 * a Zod schema. Every error carries file, line and column (spec: Rules,
 * "Loading, testing and reload"); heel.yaml and the rules files share this.
 */
export function parseYamlStrict<S extends z.ZodType>(
  source: string,
  file: string,
  schema: S,
): z.output<S> {
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

  // An empty file is an empty mapping, so every key falls back to its default.
  const value: unknown = doc.contents === null ? {} : doc.toJS({ maxAliasCount: 100 });
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue): YamlIssue => {
    const path = issue.path.map(String);
    const pos = lineCounter.linePos(locateOffset(doc, issue.path));
    return { file, line: pos.line, col: pos.col, path: path.join("."), message: issue.message };
  });
  throw new YamlValidationError(issues);
}

/**
 * Finds the source offset for a schema path: the deepest node that exists on
 * that path. A missing key points at its parent mapping.
 */
function locateOffset(doc: ReturnType<typeof parseDocument>, path: readonly PropertyKey[]): number {
  for (let depth = path.length; depth >= 0; depth -= 1) {
    const node: unknown = doc.getIn(path.slice(0, depth), true);
    if (isNode(node) && node.range) return node.range[0];
  }
  return 0;
}
