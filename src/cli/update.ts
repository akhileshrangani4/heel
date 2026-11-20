import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `heel update`: finds the newest heel on npm and moves this install to it,
 * the way it was installed. heel never updates itself in the background; a
 * gateway that changes under you is a surprise, so it happens when you run
 * this command and not otherwise.
 *
 * Deciding what to do is pure (`detectInstall`, `newer`, `updatePlan`), so
 * tests can check it without npm or a network; `runUpdate` is the I/O.
 */

/** The npm package heel ships as. */
export const PACKAGE = "useheel";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;
const IMAGE = "ghcr.io/akhileshrangani4/heel";

export type Install =
  /** `npm install -g useheel`: npm can replace it. */
  | { kind: "npm"; npm: string }
  /** The OCI image: a container can't replace itself. */
  | { kind: "docker" }
  /** A git checkout running the source. */
  | { kind: "checkout"; dir: string }
  | { kind: "unknown"; dir: string };

/**
 * Pure: how heel was installed, from its package folder. A checkout has a
 * `.git`; the image has `/.dockerenv`; an npm install sits in a
 * `node_modules/useheel` folder. npm is the one next to the Node running
 * heel, so the update lands in the same global folder.
 */
export function detectInstall(
  packageDir: string,
  exists: (path: string) => boolean,
  nodePath: string,
): Install {
  if (exists(join(packageDir, ".git"))) return { kind: "checkout", dir: packageDir };
  if (exists("/.dockerenv")) return { kind: "docker" };
  if (packageDir.includes(`${sep}node_modules${sep}${PACKAGE}`)) {
    const beside = join(dirname(nodePath), "npm");
    return { kind: "npm", npm: exists(beside) ? beside : "npm" };
  }
  return { kind: "unknown", dir: packageDir };
}

/** Pure: whether `latest` is a later release than `current` (x.y.z; a pre-release counts as older). */
export function newer(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre: pre !== undefined };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a.parts.at(i) ?? 0;
    const y = b.parts.at(i) ?? 0;
    if (x !== y) return x > y;
  }
  return b.pre && !a.pre;
}

/** What `heel update` does: run npm, or tell the person the steps for their install. */
export type UpdatePlan =
  | { kind: "current"; message: string }
  | { kind: "run"; command: string; args: string[]; before: string; after: string }
  | { kind: "tell"; message: string };

/** Pure: the plan for moving `current` to `latest` on this install. */
export function updatePlan(install: Install, current: string, latest: string): UpdatePlan {
  if (!newer(latest, current)) {
    return { kind: "current", message: `heel ${current} is the latest version.\n` };
  }
  const restart = "Restart heel to run it: a running heel keeps the old version until you do.";
  switch (install.kind) {
    case "npm":
      return {
        kind: "run",
        command: install.npm,
        args: ["install", "--global", `${PACKAGE}@${latest}`],
        before: `Updating heel ${current} to ${latest}…\n`,
        after: `heel is now ${latest}.\n`,
      };
    case "docker":
      return {
        kind: "tell",
        message: [
          `heel ${latest} is out (this container runs ${current}). A container can't replace itself; on the host:`,
          "",
          `  docker pull ${IMAGE}:${latest}`,
          "  then start the container again from the new image, with the same volume",
          "",
        ].join("\n"),
      };
    case "checkout":
      return {
        kind: "tell",
        message: [
          `heel ${latest} is out (this checkout is ${current}). In ${install.dir}:`,
          "",
          "  git pull && pnpm install",
          "",
          restart,
          "",
        ].join("\n"),
      };
    case "unknown":
      return {
        kind: "tell",
        message: [
          `heel ${latest} is out (you have ${current}), but heel can't tell how it was installed (${install.dir}).`,
          "If you installed it with npm:",
          "",
          `  npm install --global ${PACKAGE}@${latest}`,
          "",
        ].join("\n"),
      };
  }
}

/** Pure: the `--check` answer. */
export function checkMessage(current: string, latest: string): string {
  return newer(latest, current)
    ? `heel ${latest} is out (you have ${current}). Run: heel update\n`
    : `heel ${current} is the latest version.\n`;
}

/** The newest version on npm. */
export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(REGISTRY_LATEST, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`npm answered ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("npm's answer had no version");
  return body.version;
}

/** This install, from where this file is: `src/cli` in a checkout, `dist/cli` in the package. */
export function thisInstall(): Install {
  const packageDir = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
  return detectInstall(packageDir, existsSync, process.execPath);
}

/** Runs a plan's command with the terminal attached; its exit code. */
export function runCommand(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
