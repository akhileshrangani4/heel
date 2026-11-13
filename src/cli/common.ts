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
}

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
