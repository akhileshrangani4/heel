import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { hasErrnoCode } from "../util/errno.ts";
import { Secret } from "./secret.ts";

export type SecretFileProblem = "missing" | "empty" | "insecure_permissions";

/**
 * A secret named in heel.yaml (an OIDC client secret, a SIEM token) could not
 * be loaded. The message names the source, never the value.
 */
export class SecretFileError extends Error {
  override readonly name = "SecretFileError";
  readonly problem: SecretFileProblem;

  constructor(problem: SecretFileProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/**
 * Loads a secret from the environment variable `envName`, else from `file`.
 * The file gets the same checks as the master key: a regular file owned by
 * the user heel runs as and unreadable by anyone else. One trailing newline
 * is dropped, since editors add one.
 */
export function loadSecret(
  env: Readonly<Record<string, string | undefined>>,
  envName: string,
  file: string,
): Secret {
  const fromEnv = env[envName];
  if (fromEnv !== undefined && fromEnv !== "") return new Secret(fromEnv);

  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new SecretFileError("missing", `no secret: set ${envName} or create ${file}`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new SecretFileError("insecure_permissions", `${file} is not a regular file`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new SecretFileError(
        "insecure_permissions",
        `${file} must be owned by the user heel runs as (uid ${uid})`,
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new SecretFileError(
        "insecure_permissions",
        `${file} is readable by other users; chmod 600 it`,
      );
    }
    const value = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (value === "") throw new SecretFileError("empty", `${file} is empty`);
    return new Secret(value);
  } finally {
    closeSync(fd);
  }
}
