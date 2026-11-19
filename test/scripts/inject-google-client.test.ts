import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers/store.ts";

/** The release step that puts heel's Google client into the build (roadmap 1.14). */

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "inject-google-client.ts");
const BUILTIN = join(ROOT, "src", "definitions", "google", "builtin.ts");

function run(env: Record<string, string>) {
  const copy = join(tempDir("heel-inject-"), "builtin.ts");
  copyFileSync(BUILTIN, copy);
  try {
    execFileSync(process.execPath, [SCRIPT, copy], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: "pipe",
    });
    return { ok: true, text: readFileSync(copy, "utf8") };
  } catch {
    return { ok: false, text: readFileSync(copy, "utf8") };
  }
}

describe("inject-google-client", () => {
  it("fills in the client from the release's secrets", () => {
    const { ok, text } = run({
      HEEL_GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
      HEEL_GOOGLE_CLIENT_SECRET: "GOCSPX-test-only",
    });
    expect(ok).toBe(true);
    expect(text).toContain('const CLIENT_ID = "123-abc.apps.googleusercontent.com";');
    expect(text).toContain('const CLIENT_SECRET = "GOCSPX-test-only";');
  });

  it("fails rather than ship a release without the client", () => {
    expect(run({}).ok).toBe(false);
  });

  it("finds the client empty in git", () => {
    expect(readFileSync(BUILTIN, "utf8")).toContain('const CLIENT_ID = "";');
  });
});
