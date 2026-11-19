import { describe, expect, it } from "vitest";
import { cliPipeline } from "../helpers/cli-pipeline.ts";

/**
 * What runs is what the rules saw: a rule scoped to one repo must not let a
 * `gh` command act on another, whatever spelling of a URL or flag order the
 * agent picks.
 */

const ACME_WEB_ONLY = `rules:
  - match: { action: github.comment, repo: { one_of: [acme/web] } }
    then: allow
  - match: { action: github.read, repo: { one_of: [acme/web] } }
    then: allow
  - match: { action: github.pr.update, repo: { one_of: [acme/web] } }
    then: ask
  - match: { action: github.issue.update, repo: { one_of: [acme/web] } }
    then: allow
`;

/** URL spellings gh reads as github.com/evil/other that heel can't pin exactly. */
const FOREIGN_PULL_URLS = [
  "https://www.github.com/evil/other/pull/7",
  "https://evil.github.com/evil/other/pull/7",
  "https://github.com:443/evil/other/pull/7",
  "https://x@github.com/evil/other/pull/7",
  "https://WWW.GitHub.com/evil/other/pull/7",
  "http://www.github.com/evil/other/pull/7",
  "https://ghe.corp.example/evil/other/pull/7",
  "https://github.com/evil%2Fother/pull/7",
];

async function refused(argv: string[], reason = "unsupported") {
  const h = cliPipeline({ owner: ACME_WEB_ONLY });
  const answer = await h.run({ argv, cwd: h.repo });
  expect(answer, argv.join(" ")).toMatchObject({ status: 403, body: { reason } });
  expect(h.started).toEqual([]);
}

async function ran(argv: string[]) {
  const h = cliPipeline({ owner: ACME_WEB_ONLY });
  const answer = await h.run({ argv, cwd: h.repo });
  expect(answer.body["status"], argv.join(" ")).toBe("ran");
  expect(h.started).toHaveLength(1);
}

describe("gh: the repo rules check is the repo gh acts on", () => {
  it.each(FOREIGN_PULL_URLS)("refuses gh pr comment %s -R acme/web", async (url) => {
    await refused(["gh", "pr", "comment", url, "-R", "acme/web", "--body", "pwned"]);
  });

  it.each(FOREIGN_PULL_URLS)("refuses gh pr close %s -R acme/web, never asking", async (url) => {
    await refused(["gh", "pr", "close", url, "-R", "acme/web"]);
  });

  it.each(FOREIGN_PULL_URLS.map((url) => url.replace("/pull/", "/issues/")))(
    "refuses gh issue comment %s",
    async (url) => {
      await refused(["gh", "issue", "comment", url, "--body", "pwned"]);
    },
  );

  it("refuses a canonical URL whose repo isn't -R's", async () => {
    await refused([
      "gh",
      "pr",
      "comment",
      "https://github.com/evil/other/pull/7",
      "-R",
      "acme/web",
      "--body",
      "pwned",
    ]);
  });

  it("refuses a second issue URL on another repo", async () => {
    await refused([
      "gh",
      "issue",
      "edit",
      "https://github.com/acme/web/issues/5",
      "https://github.com/evil/other/issues/6",
      "--title",
      "x",
    ]);
    // gh takes the repo from whichever argument is a URL; so do the rules.
    await refused(
      ["gh", "issue", "edit", "5", "https://github.com/evil/other/issues/6"],
      "no_rule_matched",
    );
  });

  it("refuses an issue reference flag that reaches into another repo", async () => {
    await refused([
      "gh",
      "issue",
      "edit",
      "https://github.com/acme/web/issues/5",
      "--add-sub-issue",
      "https://github.com/evil/other/issues/6",
    ]);
    await refused([
      "gh",
      "issue",
      "close",
      "https://github.com/acme/web/issues/5",
      "--duplicate-of",
      "https://www.github.com/acme/web/issues/1",
    ]);
  });

  it("reads --json's field list as its value, not as the pull request", async () => {
    await refused([
      "gh",
      "pr",
      "view",
      "-R",
      "acme/web",
      "--json",
      "title",
      "https://github.com/other/repo/pull/1",
    ]);
    await ran(["gh", "pr", "view", "-R", "acme/web", "--json", "title", "7"]);
    await ran(["gh", "pr", "view", "-R", "acme/web", "--json=title,body", "7"]);
  });

  it("denies a comment whose repo heel can't see", async () => {
    // Without -R or a URL, gh reads the repo from the checkout's git remotes.
    await refused(["gh", "issue", "comment", "5", "--body", "hi"], "no_rule_matched");
  });

  it("still runs the URL spellings heel can pin", async () => {
    await ran([
      "gh",
      "pr",
      "comment",
      "https://github.com/acme/web/pull/7",
      "-R",
      "acme/web",
      "--body",
      "hi",
    ]);
    await ran(["gh", "pr", "comment", "HTTPS://GitHub.com/Acme/Web/pull/7/files", "--body", "hi"]);
    await ran(["gh", "issue", "comment", "https://github.com/acme/web/issues/5", "--body", "hi"]);
    await ran([
      "gh",
      "issue",
      "close",
      "https://github.com/acme/web/issues/5",
      "--duplicate-of",
      "https://github.com/acme/web/issues/1",
    ]);
  });
});
