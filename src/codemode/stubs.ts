/**
 * Code mode's type stubs (D6a; spec: Code mode). Each account an agent may
 * use becomes one Python module, named after its alias with `-` turned into
 * `_` (`gmail-work` → `gmail_work`), and each of its tools one function in
 * it, with keyword-only parameters typed from the tool's JSON Schema. Monty
 * type-checks a script against these stubs before running any of it, so a
 * wrong argument comes back to the agent before a single call is made. Pure.
 */

/** Python's reserved words: never a module or function name. */
const KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  // `match`, `case` and `type` are soft keywords: fine as names.
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A tool as the definitions list it: a name, a description, a JSON Schema. */
export interface StubTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

export interface StubModule {
  /** The Python module name. */
  module: string;
  /** The `.pyi` source. */
  stubs: string;
  /** Python function name → the tool it calls. */
  functions: ReadonlyMap<string, string>;
  /**
   * Python function name → its renamed parameters (Python name → the tool's
   * argument name): a parameter named after a reserved word, like `from`,
   * is `from_` in Python.
   */
  renamed: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Tools left out, with why: a name that can't be a Python identifier, or a clash. */
  skipped: readonly { tool: string; reason: string }[];
}

/** The module name for an account alias; null when it can't be one (aliases are designed to fit). */
export function moduleName(alias: string): string | null {
  const name = alias.replaceAll("-", "_");
  return IDENTIFIER.test(name) && !KEYWORDS.has(name) ? name : null;
}

/** A Python function name for a tool: invalid characters become `_`; null when it still can't be one. */
export function functionName(tool: string): string | null {
  const name = tool.replace(/[^A-Za-z0-9_]/g, "_");
  return IDENTIFIER.test(name) && !KEYWORDS.has(name) && !name.startsWith("__") ? name : null;
}

type Schema = Record<string, unknown>;

/** Pure: the Python type for a JSON Schema, as narrowly as the stubs can say it. */
export function pythonType(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "Any";
  const s = schema as Schema;
  if (Array.isArray(s["enum"]) && s["enum"].every((v) => typeof v === "string")) {
    return `Literal[${(s["enum"] as string[]).map((v) => JSON.stringify(v)).join(", ")}]`;
  }
  if (typeof s["const"] === "string") return `Literal[${JSON.stringify(s["const"])}]`;
  const variants = (s["anyOf"] ?? s["oneOf"]) as unknown;
  if (Array.isArray(variants)) {
    const types = [...new Set(variants.map(pythonType))];
    return types.includes("Any") ? "Any" : types.join(" | ");
  }
  switch (s["type"]) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array":
      return `list[${pythonType(s["items"])}]`;
    case "object":
      return "dict[str, Any]";
    default:
      return "Any";
  }
}

function docstring(text: string | undefined): string {
  if (text === undefined || text === "") return "...";
  return `"""${text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"')}"""`;
}

/**
 * One function's stub: keyword-only, required parameters first. A parameter
 * named after a reserved word gets a trailing underscore (`from` → `from_`,
 * the usual Python spelling), recorded in `renamed` so heel passes the
 * tool's own name on.
 */
function functionStub(name: string, tool: StubTool, renamed: Map<string, string>): string | null {
  const properties = (tool.inputSchema["properties"] ?? {}) as Record<string, unknown>;
  const required = new Set(
    Array.isArray(tool.inputSchema["required"]) ? (tool.inputSchema["required"] as string[]) : [],
  );
  const params: string[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    // A parameter whose name can't be a Python identifier can't be passed;
    // neither can a reserved word whose `_` spelling is taken.
    const python = KEYWORDS.has(key) ? `${key}_` : key;
    if (!IDENTIFIER.test(key) || (python !== key && python in properties)) {
      if (required.has(key)) return null;
      continue;
    }
    if (python !== key) renamed.set(python, key);
    const type = pythonType(schema);
    params.push(required.has(key) ? `${python}: ${type}` : `${python}: ${type} = ...`);
  }
  params.sort((a, b) => Number(a.includes(" = ...")) - Number(b.includes(" = ...")));
  const signature = params.length === 0 ? "" : `*, ${params.join(", ")}`;
  return `def ${name}(${signature}) -> Any:\n    ${docstring(tool.description)}\n`;
}

/** The module for one account. */
export function accountModule(alias: string, tools: readonly StubTool[]): StubModule | null {
  const module = moduleName(alias);
  if (module === null) return null;
  const functions = new Map<string, string>();
  const renamedBy = new Map<string, ReadonlyMap<string, string>>();
  const skipped: { tool: string; reason: string }[] = [];
  const bodies: string[] = [];
  for (const tool of tools) {
    const name = functionName(tool.name);
    if (name === null) {
      skipped.push({ tool: tool.name, reason: "its name can't be a Python function" });
      continue;
    }
    if (functions.has(name)) {
      skipped.push({ tool: tool.name, reason: `its name clashes with ${functions.get(name)}` });
      continue;
    }
    const renamed = new Map<string, string>();
    const stub = functionStub(name, tool, renamed);
    if (stub === null) {
      skipped.push({
        tool: tool.name,
        reason: "a required parameter's name can't be a Python name",
      });
      continue;
    }
    functions.set(name, tool.name);
    if (renamed.size > 0) renamedBy.set(name, renamed);
    bodies.push(stub);
  }
  const header = `"""heel: tools of the account ${alias}. Each call is checked by heel's rules."""\nfrom typing import Any, Literal\n\n`;
  return { module, stubs: header + bodies.join("\n"), functions, renamed: renamedBy, skipped };
}
