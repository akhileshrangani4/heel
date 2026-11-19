import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createMasterKeyFile } from "../vault/key.ts";

/**
 * `heel init` (roadmap 1.12): everything a first `heel serve` needs, in one
 * place, without overwriting anything that's already there: the home
 * directory, the master key, a small heel.yaml, and starter rules. It ends
 * with the next commands to run.
 */

export const STARTER_CONFIG = `# heel's settings. Every key: https://useheel.dev/docs/running#configuration
listen:
  # Where agents connect (MCP, the HTTP proxy, heel run).
  agent: 127.0.0.1:7300
  # The approval page. public_url follows this port unless you set it.
  human: 127.0.0.1:7301
`;

export const STARTER_RULES = `# Your rules. The first rule that matches decides; nothing matching is denied.
# Every key and many recipes: https://useheel.dev/docs/rules-reference
rules:
  # Reads run: anything a built-in service marks as read-only.
  - name: reads
    match: { kind: read }
    then: allow

  # Everything else waits for you to approve it with your passkey.
  - name: everything-else-asks
    match: {}
    then: ask
`;

export interface InitStep {
  what: string;
  done: "created" | "kept";
}

/** Pure where it can be: does each step in `home`, returning what it did. */
export function initHome(home: string): InitStep[] {
  const steps: InitStep[] = [];
  const existed = existsSync(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  steps.push({ what: home, done: existed ? "kept" : "created" });

  const key = join(home, "master.key");
  if (existsSync(key)) steps.push({ what: key, done: "kept" });
  else {
    createMasterKeyFile(key);
    steps.push({ what: key, done: "created" });
  }

  const config = join(home, "heel.yaml");
  if (existsSync(config)) steps.push({ what: config, done: "kept" });
  else {
    writeFileSync(config, STARTER_CONFIG, { mode: 0o600, flag: "wx" });
    steps.push({ what: config, done: "created" });
  }

  const rulesDir = join(home, "rules");
  const hasRules =
    existsSync(join(home, "org-rules.yaml")) ||
    (existsSync(rulesDir) && readdirSync(rulesDir).some((f) => f.endsWith(".yaml")));
  const rules = join(rulesDir, "owner.yaml");
  if (hasRules) steps.push({ what: rulesDir, done: "kept" });
  else {
    mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
    writeFileSync(rules, STARTER_RULES, { mode: 0o600, flag: "wx" });
    steps.push({ what: rules, done: "created" });
  }
  return steps;
}

/** Pure: what `heel init` prints after the steps. */
export function initSummary(
  home: string,
  steps: readonly InitStep[],
  homeFromEnv: boolean,
): string {
  const lines = [
    "",
    ...steps.map((s) => `  ${s.done === "created" ? "created" : "kept   "}  ${s.what}`),
    "",
  ];
  if (steps.some((s) => s.what.endsWith("master.key") && s.done === "created")) {
    lines.push(
      "Back up master.key somewhere safe, off this machine. Without it, the credentials heel stores can't be read.",
      "",
    );
  }
  lines.push("Next:");
  let n = 1;
  if (!homeFromEnv) {
    lines.push(
      `  ${n++}. Tell heel where its home is (add this to your shell profile too):`,
      `       export HEEL_HOME=${home}`,
    );
  }
  lines.push(
    `  ${n++}. Start heel:                        heel serve`,
    `  ${n++}. In another terminal, enroll your passkey: heel user enroll owner`,
    "       and open the link it prints.",
    `  ${n++}. Add an agent and copy its token:   heel agent add my-agent`,
    `  ${n++}. Connect an account, for example:   heel connect github --as github --credential-stdin < token.txt`,
    "",
    "Watch it all live with heel tui. Your rules are in rules/owner.yaml: reads run, everything else asks you.",
    "",
  );
  return lines.join("\n");
}

/** Where heel's home goes: --home, then HEEL_HOME, then ~/.heel. */
export function chooseHome(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const raw = flag ?? env["HEEL_HOME"] ?? join(homedir(), ".heel");
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Asks once before writing, unless told yes. False means the person said no. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
