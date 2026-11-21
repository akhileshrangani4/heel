import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where heel's dependencies sit on disk. Both ways of running a script start
 * a Node process that may read heel's install and nothing else, so both need
 * to know when Monty lives outside it: the bubblewrap worker mounts that
 * directory, and the helper is allowed to read it.
 */

/** Where Monty's entry point resolves: the process needs it and what sits beside it. */
function resolvedDependency(): string | null {
  try {
    return fileURLToPath(import.meta.resolve("@pydantic/monty"));
  } catch {
    return null;
  }
}

/** True when `path` is `dir` or below it. */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The `node_modules` holding heel's dependencies when they aren't inside the
 * install, or null when they are (a checkout, the OCI image, `npm install -g`).
 *
 * A local or npx install puts heel at `<dir>/node_modules/useheel` and
 * hoists its dependencies beside it; pnpm keeps them in
 * `<dir>/node_modules/.pnpm`. Either way the outermost `node_modules` above
 * the install holds them all, so that's what's mounted (read-only), and only
 * when Monty actually resolves inside it.
 */
export function hoistedDependencies(
  install: string,
  entry: string | null = resolvedDependency(),
): string | null {
  if (entry === null || within(install, entry)) return null;
  const parts = install.split(sep);
  const at = parts.indexOf("node_modules");
  if (at < 0) return null;
  const dir = parts.slice(0, at + 1).join(sep);
  return within(dir, entry) ? dir : null;
}
