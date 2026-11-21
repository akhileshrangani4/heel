import { loadConfig, resolveConfigSource } from "../config/load.ts";
import type { HeelConfig } from "../config/schema.ts";
import { YamlValidationError } from "../config/yaml.ts";
import { hasErrnoCode } from "../util/errno.ts";

/** Exit codes, from sysexits(3) as the spec uses for `heel run`. */
export const EXIT = {
  ok: 0,
  /** heel answered and refused the request, or a `heel rules test` case failed. */
  failed: 1,
  usage: 64,
  /** The rules files or a cases file are invalid. */
  dataErr: 65,
  /** heel isn't running, or (for `serve`) another heel already owns the admin socket. */
  unavailable: 69,
  /** heel.yaml is missing or invalid. */
  config: 78,
} as const;

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<string | Buffer>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** HTTP for commands that call out (`heel rules draft`); the global `fetch` when absent. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** The current directory; `process.cwd()` when absent. */
  cwd?: () => string;
  /**
   * Runs another program, without a shell (`heel agent add --client` adding heel to
   * Claude Code). Only the `heel` binary passes one; when absent, heel prints the
   * command instead, so no test can ever change a real app's config.
   */
  exec?: ExecFn;
}

/** A program's exit code and its stdout and stderr together. Code 127: not installed. */
export type ExecFn = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; output: string }>;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export class RefusedError extends Error {
  override readonly name = "RefusedError";
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** The `--config <file>` flag every command accepts. */
export const CONFIG_OPTION = { config: { type: "string" } } as const;

/** Runs a parseArgs call, turning node:util's ERR_PARSE_ARGS_* errors into usage errors. */
export function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TypeError && /^ERR_PARSE_ARGS/.test(String(Reflect.get(error, "code")))) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

export function configFrom(io: CliIo, configFlag: string | undefined): HeelConfig {
  const source = resolveConfigSource(io.env, configFlag);
  try {
    return loadConfig(source);
  } catch (error) {
    if (error instanceof YamlValidationError) {
      throw new ConfigError(`invalid config:\n${error.message}`, { cause: error });
    }
    if (hasErrnoCode(error, "ENOENT")) {
      throw new ConfigError(`config file not found: ${source.file}`, { cause: error });
    }
    throw error;
  }
}

export function onePositional(positionals: string[], what: string): string {
  const [value, ...extra] = positionals;
  if (value === undefined) throw new UsageError(`missing ${what}`);
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  return value;
}

/** `--json`: the list commands print JSON instead of a table, for scripts. */
export const JSON_OPTION = { json: { type: "boolean" } } as const;

/** Pure: rows as aligned columns under upper-case headers, or `empty` when there are none. */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  empty: string,
): string {
  if (rows.length === 0) return `${empty}\n`;
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return `${[line(headers.map((h) => h.toUpperCase())), ...rows.map(line)].join("\n")}\n`;
}

/** Pure: an ISO time as `YYYY-MM-DD HH:MM` UTC, short enough for a table. */
export function shortTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
