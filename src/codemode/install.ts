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
 * when Monty actually resolves inside it. In a workspace, where heel's folder
 * has no `node_modules` above it, it is the outermost one above Monty.
 */
export function hoistedDependencies(
  install: string,
  entry: string | null = resolvedDependency(),
): string | null {
  if (entry === null || within(install, entry)) return null;
  const parts = install.split(sep);
  const at = parts.indexOf("node_modules");
  if (at >= 0) {
    const dir = parts.slice(0, at + 1).join(sep);
    return within(dir, entry) ? dir : null;
  }
  // A workspace: heel's own folder holds no `node_modules` above it, and its dependencies are
  // hoisted to the workspace's. The outermost `node_modules` above Monty's entry holds them.
  const entryParts = entry.split(sep);
  const outer = entryParts.indexOf("node_modules");
  return outer < 0 ? null : entryParts.slice(0, outer + 1).join(sep);
}
