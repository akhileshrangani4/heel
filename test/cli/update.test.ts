import { describe, expect, it } from "vitest";
import {
  checkMessage,
  detectInstall,
  latestVersion,
  newer,
  updatePlan,
} from "../../src/cli/update.ts";

/** `heel update`: what it decides to do, without npm or a network. */

const NPM_PACKAGE = "/opt/homebrew/lib/node_modules/useheel";
const NODE = "/opt/homebrew/bin/node";

describe("heel update", () => {
  it("compares versions by number, with a pre-release older than its release", () => {
    expect(newer("0.3.0", "0.2.0")).toBe(true);
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("0.2.0", "0.3.0")).toBe(false);
    expect(newer("0.3.0", "0.3.0-rc.1")).toBe(true);
    expect(newer("0.3.0-rc.1", "0.3.0")).toBe(false);
  });

  it("tells an npm install from a checkout, the image and anything else", () => {
    const npmHere = (path: string) => path === "/opt/homebrew/bin/npm";
    expect(detectInstall(NPM_PACKAGE, npmHere, NODE)).toEqual({
      kind: "npm",
      npm: "/opt/homebrew/bin/npm",
    });
    // No npm beside this Node: the one on PATH.
    expect(detectInstall(NPM_PACKAGE, () => false, NODE)).toEqual({ kind: "npm", npm: "npm" });
    expect(detectInstall("/src/heel", (p) => p === "/src/heel/.git", NODE)).toEqual({
      kind: "checkout",
      dir: "/src/heel",
    });
    expect(detectInstall("/opt/heel", (p) => p === "/.dockerenv", NODE)).toEqual({
      kind: "docker",
    });
    expect(detectInstall("/somewhere/heel", () => false, NODE)).toEqual({
      kind: "unknown",
      dir: "/somewhere/heel",
    });
  });

  it("runs npm for an npm install, pinned to the version it found", () => {
    const plan = updatePlan({ kind: "npm", npm: "/opt/homebrew/bin/npm" }, "0.2.0", "0.3.0");
    expect(plan).toMatchObject({
      kind: "run",
      command: "/opt/homebrew/bin/npm",
      args: ["install", "--global", "useheel@0.3.0"],
    });
    if (plan.kind === "run") expect(plan.after).toBe("heel is now 0.3.0.\n");
  });

  it("does nothing when heel is already the newest", () => {
    expect(updatePlan({ kind: "npm", npm: "npm" }, "0.3.0", "0.3.0")).toEqual({
      kind: "current",
      message: "heel 0.3.0 is the latest version.\n",
    });
  });

  it("tells the steps where heel can't replace itself", () => {
    const docker = updatePlan({ kind: "docker" }, "0.2.0", "0.3.0");
    expect(docker.kind).toBe("tell");
    if (docker.kind === "tell") {
      expect(docker.message).toContain("docker pull ghcr.io/akhileshrangani4/heel:0.3.0");
    }
    const checkout = updatePlan({ kind: "checkout", dir: "/src/heel" }, "0.2.0", "0.3.0");
    if (checkout.kind === "tell") expect(checkout.message).toContain("git pull");
    const unknown = updatePlan({ kind: "unknown", dir: "/x" }, "0.2.0", "0.3.0");
    if (unknown.kind === "tell")
      expect(unknown.message).toContain("npm install --global useheel@0.3.0");
  });

  it("--check only reports", () => {
    expect(checkMessage("0.2.0", "0.3.0")).toBe(
      "heel 0.3.0 is out (you have 0.2.0). Run: heel update\n",
    );
    expect(checkMessage("0.3.0", "0.3.0")).toBe("heel 0.3.0 is the latest version.\n");
  });

  it("reads the newest version from npm's registry, and refuses an answer without one", async () => {
    const asked: string[] = [];
    const answer = (body: unknown, status = 200) =>
      (async (url: string | URL | Request) => {
        asked.push(String(url));
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    expect(await latestVersion(answer({ version: "0.3.0" }))).toBe("0.3.0");
    expect(asked).toEqual(["https://registry.npmjs.org/useheel/latest"]);
    await expect(latestVersion(answer({}))).rejects.toThrow("no version");
    await expect(latestVersion(answer({}, 503))).rejects.toThrow("503");
  });
});
