import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasErrnoCode } from "../util/errno.ts";
import { type HeelConfig, HeelConfigFileSchema, resolveConfig } from "./schema.ts";
import { parseYamlStrict } from "./yaml.ts";

export const DEFAULT_HEEL_HOME = "/var/lib/heel";

/** Where the config comes from; `explicit` means a person named the file. */
export interface ConfigSource {
  home: string;
  file: string;
  explicit: boolean;
}

/**
 * Pure: picks $HEEL_HOME and the config file. A `--config` flag beats
 * HEEL_CONFIG, which beats `$HEEL_HOME/heel.yaml`.
 */
export function resolveConfigSource(
  env: Readonly<Record<string, string | undefined>>,
  configFlag?: string,
): ConfigSource {
  const home = resolve(env["HEEL_HOME"] ?? DEFAULT_HEEL_HOME);
  const named = configFlag ?? env["HEEL_CONFIG"];
  if (named) return { home, file: resolve(named), explicit: true };
  return { home, file: join(home, "heel.yaml"), explicit: false };
}

/**
 * Reads and validates heel.yaml. A missing default file means "all
 * defaults"; a missing file someone named is an error, because silently
 * running on defaults would ignore the config they meant to apply.
 */
export function loadConfig(source: ConfigSource): HeelConfig {
  let text: string;
  try {
    text = readFileSync(source.file, "utf8");
  } catch (error) {
    if (!source.explicit && hasErrnoCode(error, "ENOENT")) {
      return resolveConfig(HeelConfigFileSchema.parse({}), source.home, null);
    }
    throw error;
  }
  const file = parseYamlStrict(text, source.file, HeelConfigFileSchema);
  return resolveConfig(file, source.home, source.file);
}
