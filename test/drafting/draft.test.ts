import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, EXIT, main } from "../../src/cli/main.ts";
import { actionsFor, draftMessages, extractYaml, lineDiff } from "../../src/drafting/draft.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Rule drafting (D13b, I-17): the model sees only the description, the
 * schema, and account and action names; a draft is validated and shown,
 * never saved; and with the model stubbed out or unreachable, nothing else
 * changes.
 */

const DRAFT =
  "rules:\n  - match: { action: email.send, recipients: { all_domain_in: [acme.com] } }\n    then: allow\n";
const CURRENT = "rules:\n  - match: { action: email.send }\n    then: ask\n";

interface Sent {
  url: string;
  body: { model: string; messages: { role: string; content: string }[] };
  auth: string | null;
}

function setUp(answer: (sent: Sent) => Response | Promise<Response>, drafting = true) {
  const dir = tempDir("heel-draft-");
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", "alice.yaml"), CURRENT);
  writeFileSync(
    join(dir, "heel.yaml"),
    `admin_socket: ${join(dir, "missing.sock")}\n${
      drafting ? "drafting:\n  base_url: http://127.0.0.1:9/v1\n  model: test-model\n" : ""
    }`,
  );
  const sent: Sent[] = [];
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      env: { HEEL_HOME: dir, ...env },
      stdin: (async function* () {})(),
      stdout: { write: (t) => (stdout += t) },
      stderr: { write: (t) => (stderr += t) },
      fetch: async (input, init) => {
        const s: Sent = {
          url: input.toString(),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("authorization"),
        };
        sent.push(s);
        return answer(s);
      },
    };
    return { code: await main(argv, io), stdout, stderr };
  };
  return { dir, run, sent };
}

const reply = (content: string) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

describe("drafting a rule", () => {
  it("sends the model only the description, the schema, and account and action names", () => {
    const messages = draftMessages({
      description: "let the agent email anyone at acme",
      schema: '{"title":"heel rules"}',
      accounts: [{ alias: "gmail-work", provider: "gmail" }],
      actions: actionsFor(["gmail"]),
    });
    const text = JSON.stringify(messages);
    expect(text).toContain("let the agent email anyone at acme");
    expect(text).toContain('{\\"title\\":\\"heel rules\\"}');
    expect(text).toContain("gmail-work (gmail)");
    expect(text).toContain("email.send");
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("prints a valid draft and its diff, and saves nothing", async () => {
    const h = setUp(() => reply(`\`\`\`yaml\n${DRAFT}\`\`\``));
    const before = readdirSync(join(h.dir, "rules"));
    const result = await h.run(
      ["rules", "draft", "allow", "email", "to", "acme", "--user", "alice"],
      {
        HEEL_DRAFTING_API_KEY: "draft-test-key",
      },
    );
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Draft for rules/alice.yaml:");
    expect(result.stdout).toContain("- rules:".replace("- ", "  "));
    expect(result.stdout).toContain("+   - match: { action: email.send, recipients:");
    expect(result.stdout).toContain("Not saved.");
    expect(readFileSync(join(h.dir, "rules", "alice.yaml"), "utf8")).toBe(CURRENT);
    expect(readdirSync(join(h.dir, "rules"))).toEqual(before);
    expect(h.sent[0]?.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(h.sent[0]?.auth).toBe("Bearer draft-test-key");
    expect(h.sent[0]?.body.model).toBe("test-model");
  });

  it("refuses a draft that isn't a valid rules file", async () => {
    const h = setUp(() => reply("rules:\n  - match: { nonsense: true }\n    then: maybe\n"));
    const result = await h.run(["rules", "draft", "anything", "--user", "alice"]);
    expect(result.code).toBe(EXIT.dataErr);
    expect(result.stderr).toContain("isn't a valid rules file");
  });

  it("runs cases against the draft", async () => {
    const h = setUp(() => reply(DRAFT));
    const cases = join(h.dir, "cases.yaml");
    writeFileSync(
      cases,
      "cases:\n  - name: acme\n    call: { agent: bot, account: gmail-work, action: email.send, recipients: [bob@acme.com] }\n    expect: { decision: allow }\n",
    );
    const result = await h.run(["rules", "draft", "x", "--user", "alice", "--cases", cases]);
    expect(result.stdout).toContain("Cases against the draft:");
    expect(result.code).toBe(EXIT.ok);
  });

  it("says the model is unreachable and changes nothing", async () => {
    const h = setUp(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await h.run(["rules", "draft", "x", "--user", "alice"]);
    expect(result.code).toBe(EXIT.unavailable);
    expect(result.stderr).toContain("isn't reachable");
    expect(readFileSync(join(h.dir, "rules", "alice.yaml"), "utf8")).toBe(CURRENT);
  });

  it("is off without a drafting section, and sends nothing", async () => {
    const h = setUp(() => reply(DRAFT), false);
    const result = await h.run(["rules", "draft", "x", "--user", "alice"]);
    expect(result.code).toBe(EXIT.config);
    expect(result.stderr).toContain("drafting is off");
    expect(h.sent).toEqual([]);
  });
});

describe("drafting helpers", () => {
  it("take the YAML out of a fenced answer", () => {
    expect(extractYaml("Here:\n```yaml\nrules: []\n```\nDone.")).toBe("rules: []\n");
    expect(extractYaml("rules: []")).toBe("rules: []\n");
  });

  it("diff two files line by line", () => {
    expect(lineDiff("a\nb\n", "a\nc\n")).toBe("  a\n- b\n+ c\n");
  });

  it("list the actions of the person's providers only", () => {
    expect(actionsFor(["slack"])).toEqual([
      "slack.delete",
      "slack.post",
      "slack.read",
      "slack.schedule",
      "slack.update",
    ]);
    expect(actionsFor([])).toEqual([]);
  });
});
