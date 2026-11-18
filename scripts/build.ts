/**
 * `pnpm build`: compiles src to dist for the npm package (Node won't strip
 * types inside node_modules). dist keeps src's layout, and the files src
 * reads at runtime (looks_like weights, migrations) are copied beside the
 * compiled modules. Runs on `npm pack` and `npm publish` (prepack).
 */
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
let copied = 0;
for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith(".ts") || entry.name.endsWith(".md")) continue;
  const from = join(entry.parentPath, entry.name);
  cpSync(from, join(dist, relative(src, from)));
  copied += 1;
}
console.error(`built dist: compiled src and copied ${copied} data files`);
