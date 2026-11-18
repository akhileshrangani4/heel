/**
 * `pnpm package:smoke`: what `npm install` users get. Packs heel, installs
 * the tarball with npm into an empty project (so dependencies are hoisted
 * above the package, as npm does), then starts it and checks it:
 *
 * - `heel --version` prints package.json's version;
 * - `heel serve` starts, runs its migrations, and answers on both planes
 *   (401 on the agent plane, the sign-in page on the human plane);
 * - `heel agent add` reaches it over the admin socket.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};
const work = mkdtempSync(join(tmpdir(), "heel-package-"));

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
) as { filename: string }[];
const tarball = join(work, packed[0]?.filename ?? "");
const project = join(work, "project");
execFileSync("mkdir", ["-p", project]);
writeFileSync(join(project, "package.json"), '{ "private": true }\n');
execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
  cwd: project,
  stdio: "inherit",
});
const heel = join(project, "node_modules", ".bin", "heel");

const printed = execFileSync(heel, ["--version"], { encoding: "utf8" }).trim();
if (!printed.includes(version)) throw new Error(`heel --version printed "${printed}"`);

const home = join(work, "home");
execFileSync("mkdir", ["-p", home]);
const config = join(work, "heel.yaml");
writeFileSync(
  config,
  [
    "public_url: http://localhost:17301",
    "listen:",
    '  agent: "127.0.0.1:17300"',
    '  human: "127.0.0.1:17301"',
    `admin_socket: ${join(home, "admin.sock")}`,
    "",
  ].join("\n"),
);
const env = {
  ...process.env,
  HEEL_HOME: home,
  HEEL_CONFIG: config,
  HEEL_MASTER_KEY: randomBytes(32).toString("base64"),
};
const server = spawn(heel, ["serve"], { env, stdio: ["ignore", "inherit", "inherit"] });
const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));

async function status(url: string): Promise<number | null> {
  try {
    return (await fetch(url)).status;
  } catch {
    return null;
  }
}

try {
  let agent: number | null = null;
  for (let i = 0; i < 60 && agent !== 401; i++) {
    if (server.exitCode !== null) throw new Error(`heel serve exited with ${server.exitCode}`);
    await new Promise((r) => setTimeout(r, 500));
    agent = await status("http://127.0.0.1:17300/mcp");
  }
  if (agent !== 401) throw new Error(`the agent plane answered ${agent}`);
  const human = await status("http://127.0.0.1:17301/sign-in");
  if (human !== 200) throw new Error(`the human plane answered ${human}`);
  const added = execFileSync(heel, ["agent", "add", "smoke"], { env, encoding: "utf8" });
  if (!added.includes("smoke")) throw new Error(`heel agent add printed "${added.trim()}"`);
  console.error(
    `package smoke passed: ${packed[0]?.filename} installs and serves (heel ${version})`,
  );
} finally {
  server.kill("SIGTERM");
  await exited;
}
