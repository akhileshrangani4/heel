/** True when `error` is a Node system error with the given errno code. */
export function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
