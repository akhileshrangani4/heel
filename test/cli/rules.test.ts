import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { renderRulesJsonSchema } from "../../src/core/rules/schema.ts";
import { tempDir } from "../helpers/store.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "rules", "readme");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function heel(argv: string[], home: string): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    env: { HEEL_HOME: home },
    stdin: (async function* () {})(),
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

/** A HEEL_HOME holding the given rules files, keyed by path relative to it. */
function home(files: Record<string, string>): string {
  const dir = tempDir("heel-rules-cli-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const allowSends = "rules:\n  - match: { action: email.send }\n    then: allow\n";

describe("heel rules check", () => {
  it("summarizes each valid file and exits 0", async () => {
    const dir = home({
      "org-rules.yaml":
        "rules:\n  - match: { recipients: { any_domain_in: [rival.com] } }\n    then: deny\n",
      "rules/alice.yaml": allowSends,
    });
    const result = await heel(["rules", "check"], dir);
    expect(result).toEqual({
      code: EXIT.ok,
      stdout:
        "ok    org-rules.yaml (org): 1 rule, 0 hide entries\nok    rules/alice.yaml (user alice): 1 rule, 0 hide entries\n",
      stderr: "",
    });
  });

  it("says every call is denied when there are no rules files", async () => {
    const result = await heel(["rules", "check"], home({}));
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toBe("No rules files: every call is denied.\n");
  });

  it("prints warnings without failing", async () => {
    const dir = home({
      "rules/alice.yaml":
        "rules:\n  - match: { action: email.remove, items: { over: 20, per: run } }\n    then: ask\n",
    });
    const result = await heel(["rules", "check"], dir);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/\nwarn {2}.*rules\/alice\.yaml:2:/);
  });

  it("I-12: reports an org allow with its file and line and exits 65", async () => {
    const dir = home({ "org-rules.yaml": "rules:\n  - match: {}\n    then: allow\n" });
    const result = await heel(["rules", "check"], dir);
    expect(result.code).toBe(EXIT.dataErr);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("heel: rules are invalid (1 problem):\n");
    expect(result.stderr).toContain(`${join(dir, "org-rules.yaml")}:3:`);
    expect(result.stderr).toContain("org rules can only deny or ask (I-12)");
  });

  it("reports malformed YAML with its file and line and exits 65", async () => {
    const dir = home({
      "rules/alice.yaml": "rules:\n  - match: { action: email.send\n    then: allow\n",
    });
    const result = await heel(["rules", "check"], dir);
    expect(result.code).toBe(EXIT.dataErr);
    expect(result.stderr).toMatch(new RegExp(`${join(dir, "rules", "alice\\.yaml")}:\\d+:\\d+`));
  });
});

describe("heel rules test", () => {
  it("runs the README cases against the README rules and exits 0", async () => {
    const dir = home({
      "rules/owner.yaml": readFileSync(join(FIXTURE, "rules", "owner.yaml"), "utf8"),
    });
    const result = await heel(["rules", "test", join(FIXTURE, "cases.yaml")], dir);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("ok    personal account never emails a client: deny by rule 2");
    expect(result.stdout).toContain("ok    21st removal this run asks: ask by rule 5");
    expect(result.stdout).toContain(
      "ok    merge with red checks falls through to deny: deny by default",
    );
    expect(result.stdout.endsWith("\n\n3 passed, 0 failed\n")).toBe(true);
  });

  it("exits 1 when a case's expectation doesn't hold", async () => {
    const dir = home({ "rules/alice.yaml": allowSends });
    const cases = join(dir, "cases.yaml");
    writeFileSync(
      cases,
      "cases:\n  - name: sends ask\n    call: { agent: a, account: gmail-work, action: email.send }\n    expect: { decision: ask }\n",
    );
    const result = await heel(["rules", "test", cases], dir);
    expect(result.code).toBe(EXIT.failed);
    expect(result.stdout).toContain(
      "FAIL  sends ask\n        expected: ask\n        got:      allow by rule 1",
    );
    expect(result.stdout).toContain("0 passed, 1 failed\n");
  });

  it("exits 1 and counts a case it can't run separately", async () => {
    const dir = home({
      "rules/alice.yaml":
        "rules:\n  - match: { action: github.merge, checks: passing }\n    then: allow\n",
    });
    const cases = join(dir, "cases.yaml");
    writeFileSync(
      cases,
      "cases:\n  - name: merge\n    call: { agent: a, account: github, action: github.merge }\n    expect: { decision: allow }\n",
    );
    const result = await heel(["rules", "test", cases], dir);
    expect(result.code).toBe(EXIT.failed);
    expect(result.stdout).toContain("ERROR merge: the call reaches rule 1");
    expect(result.stdout).toContain("0 passed, 0 failed, 1 could not run\n");
  });

  it("reports an invalid cases file with its file and line and exits 65", async () => {
    const dir = home({ "rules/alice.yaml": allowSends });
    const cases = join(dir, "cases.yaml");
    writeFileSync(
      cases,
      "cases:\n  - name: x\n    call: { agent: a, account: b }\n    expect: { decision: maybe }\n",
    );
    const result = await heel(["rules", "test", cases], dir);
    expect(result.code).toBe(EXIT.dataErr);
    expect(result.stderr).toContain("heel: cases file is invalid (1 problem):\n");
    expect(result.stderr).toContain(`${cases}:4:`);
  });

  it("exits 65 for a missing cases file or an unknown --user", async () => {
    const dir = home({ "rules/alice.yaml": allowSends });
    const missing = await heel(["rules", "test", join(dir, "nope.yaml")], dir);
    expect(missing.code).toBe(EXIT.dataErr);
    expect(missing.stderr).toBe(`heel: cases file not found: ${join(dir, "nope.yaml")}\n`);
    const cases = join(dir, "cases.yaml");
    writeFileSync(
      cases,
      "cases:\n  - name: x\n    call: { agent: a, account: b }\n    expect: { decision: deny }\n",
    );
    const unknown = await heel(["rules", "test", cases, "--user", "bob"], dir);
    expect(unknown.code).toBe(EXIT.dataErr);
    expect(unknown.stderr).toBe('heel: no rules file for user "bob" (rules/bob.yaml)\n');
  });

  it("exits 65 without running cases when the rules are invalid", async () => {
    const dir = home({ "rules/alice.yaml": "rules: [" });
    const result = await heel(["rules", "test", join(FIXTURE, "cases.yaml")], dir);
    expect(result.code).toBe(EXIT.dataErr);
    expect(result.stdout).toBe("");
  });
});

describe("heel rules schema", () => {
  it("prints the JSON Schema", async () => {
    const result = await heel(["rules", "schema"], home({}));
    expect(result).toEqual({ code: EXIT.ok, stdout: renderRulesJsonSchema(), stderr: "" });
  });
});

describe("heel rules usage", () => {
  it("exits 64 for a missing or unknown subcommand, or --user outside test", async () => {
    for (const argv of [["rules"], ["rules", "lint"], ["rules", "check", "--user", "alice"]]) {
      const result = await heel(argv, home({}));
      expect(result.code).toBe(EXIT.usage);
    }
  });
});
