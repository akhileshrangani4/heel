import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { textHash } from "../../src/proposals/edit.ts";
import { listRuleChanges } from "../../src/store/rule-changes.ts";
import {
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  PUBLIC_URL,
} from "../helpers/human-plane.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Roadmap 2.9, part 3: the rules file in the web app, words first. A change
 * is previewed in words, with its checks and a diff, and saved with a
 * passkey that signs the file's hash before and after.
 */

const RULES = `# my rules
rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: everything-else
    match: {}
    then: ask
`;

function setUp() {
  const home = tempDir("heel-rules-web-");
  const dir = rulesPaths(home).ownersDir;
  mkdirSync(dir);
  const file = join(dir, "owner.yaml");
  writeFileSync(file, RULES);
  const h = humanPlaneHarness({ rulesHome: home });
  return { h, file };
}

/** The text and hashes a preview page carries to its Save button. */
function saveOf(page: string) {
  const text = /<textarea name="text" hidden>([\s\S]*?)<\/textarea>/.exec(page)?.[1];
  const before = /data-before="([0-9a-f]+)"/.exec(page)?.[1];
  const after = /data-after="([0-9a-f]+)"/.exec(page)?.[1];
  if (text === undefined || before === undefined || after === undefined)
    throw new Error("no Save on the page");
  return {
    // A browser drops the one newline right after <textarea>, as heel's markup expects.
    text: text
      .replace(/^\n/, "")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
    before,
    after,
  };
}

function save(
  h: HumanPlaneHarness,
  as: Browser,
  s: { text: string; before: string; after: string },
) {
  return h.ceremony(as, { url: "/rules/challenge", body: s }, "/rules/confirm", { text: s.text });
}

describe("the rules page (2.9)", () => {
  it("shows each rule as a sentence, in order", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/rules", { as: owner })).text();
    expect(page).toContain("Your rules load, with no problems.");
    expect(page).toContain("Any of your agents may read anything");
    expect(page).toContain("Edit the file directly (YAML)");
  });

  it("changes a rule's decision from a menu: previewed in words, saved with a passkey, recorded", async () => {
    const { h, file } = setUp();
    const owner = await h.signIn(await h.enroll());
    const preview = await (
      await h.fetch(`/rules?op=decision&index=1&then=deny&csrf=${owner.csrf}`, { as: owner })
    ).text();
    expect(preview).toContain("Before you save");
    expect(preview).toContain("This rule will read: Any of your agents can&#39;t do anything");
    const done = await save(h, owner, saveOf(preview));
    expect(done.status).toBe(200);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("# my rules");
    expect(written).toMatch(/name: everything-else\n\s+match: \{\}\n\s+then: deny/);
    expect(listRuleChanges(h.t.db, h.t.orgId, null)[0]).toMatchObject({
      source: "web",
      file: "rules/owner.yaml",
    });
  });

  it("won't save a change to a file that changed since, or a text it wasn't signed for", async () => {
    const { h, file } = setUp();
    const owner = await h.signIn(await h.enroll());
    const s = saveOf(
      await (
        await h.fetch(`/rules?op=remove-rule&index=0&csrf=${owner.csrf}`, { as: owner })
      ).text(),
    );
    // Signed for one text, sent with another.
    const start = await h.fetch("/rules/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify(s),
    });
    const { challengeId, options } = (await start.json()) as {
      challengeId: string;
      options: never;
    };
    const forged = await h.fetch("/rules/confirm", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({
        challengeId,
        response: owner.authenticator.assert(options, PUBLIC_URL.origin),
        text: "rules:\n  - match: {}\n    then: allow\n",
      }),
    });
    expect([401, 409]).toContain(forged.status);
    // The file changed after the preview.
    writeFileSync(file, `${RULES}\n# edited by hand\n`);
    expect((await save(h, owner, s)).status).toBe(409);
    expect(readFileSync(file, "utf8")).toContain("edited by hand");
  });

  it("checks YAML edited directly and shows its problems, with no Save", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const checked = await h.fetch("/rules/check", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: owner.csrf,
        text: "rules:\n  - match: { acount: x }\n    then: allow\n",
      }).toString(),
    });
    const page = await checked.text();
    expect(page).toContain("This wouldn't load, so it can't be saved");
    expect(page).toContain("unknown match key");
    expect(page).not.toContain("Save with your passkey");
    expect(textHash("x")).toHaveLength(64);
  });

  it("shows a change from a link from elsewhere, but offers no Save", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (
      await h.fetch("/rules?op=decision&index=1&then=allow", { as: owner })
    ).text();
    expect(page).toContain("came from a link, not from your Rules page");
    expect(page).not.toContain("Save with your passkey");
  });

  it("names a broken alias as a problem rather than failing, and refuses an oversized text", async () => {
    const { h, file } = setUp();
    const owner = await h.signIn(await h.enroll());
    const checked = await h.fetch("/rules/check", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf, text: "rules: *x\n" }).toString(),
    });
    expect(checked.status).toBe(200);
    expect(await checked.text()).toContain("This wouldn't load");
    writeFileSync(file, "rules: *x\n");
    expect((await h.fetch("/rules", { as: owner })).status).toBe(200);
    writeFileSync(file, RULES);
    const big = `${RULES}${"# padding\n".repeat(40_000)}`;
    const refused = await h.fetch("/rules/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ text: big, before: textHash(RULES), after: textHash(big) }),
    });
    expect(refused.status).toBe(413);
  });
});
