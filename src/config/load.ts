import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hasErrnoCode } from "../util/errno.ts";
import { type HeelConfig, HeelConfigFileSchema, resolveConfig, SERVER_HOME } from "./schema.ts";
import { parseYamlStrict } from "./yaml.ts";

/**
 * Where heel lives when HEEL_HOME isn't set: a server install's
 * /var/lib/heel when that exists, else `~/.heel`, where `heel init` puts a
 * personal one. Every command picks the same place, so `heel serve` and a
 * `heel connect` in another terminal find each other without an export.
 */
export function defaultHeelHome(
  exists: (path: string) => boolean = existsSync,
  userHome: string = homedir(),
): string {
  return exists(SERVER_HOME) ? SERVER_HOME : join(userHome, ".heel");
}

/** Where the config comes from; `explicit` means a person named the file. */
export interface ConfigSource {
  home: string;
  file: string;
  explicit: boolean;
}

/**
 * Picks $HEEL_HOME and the config file. A `--config` flag beats
 * HEEL_CONFIG, which beats `$HEEL_HOME/heel.yaml`. Without HEEL_HOME, the
 * home is `fallbackHome` (`defaultHeelHome()` unless a test passes one).
 */
export function resolveConfigSource(
  env: Readonly<Record<string, string | undefined>>,
  configFlag?: string,
  fallbackHome: () => string = defaultHeelHome,
): ConfigSource {
  const home = resolve(env["HEEL_HOME"] ?? fallbackHome());
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
