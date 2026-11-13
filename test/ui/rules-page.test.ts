import { describe, expect, it } from "vitest";
import {
  DRAFT_DIFF,
  DRAFT_PROMPT,
  FAILING_TESTS,
  PASSING_TESTS,
  WATCH_ENTRIES,
} from "../../src/web/ui/preview/fixtures.ts";
import { type RulesPageProps, rulesPage } from "../../src/web/ui/rules-page.ts";
import { dom, text, type UiDocument } from "../helpers/dom.ts";

const VALID = { state: "valid", loadedAt: new Date("2026-11-13T13:00:00Z") } as const;
const ERRORS = [
  { file: "rules/alice.yaml", line: 18, column: 7, message: "unknown key `recipient`" },
];

function render(load: RulesPageProps["load"]): UiDocument {
  return dom(
    rulesPage({
      file: "rules/alice.yaml",
      load,
      draftForm: { action: "/rules/draft", csrfToken: "t" },
      saveForm: { action: "/rules/save", csrfToken: "t" },
    }),
  );
}

const ok = (over: Partial<Extract<RulesPageProps["load"], { ok: true }>>) =>
  render({ ok: true, validity: VALID, watch: [], drafting: { state: "idle" }, ...over });

describe("RulesPage", () => {
  it("locates every validation error by file, line and column", () => {
    const doc = ok({
      validity: { state: "invalid-reload", errors: ERRORS, lastGoodAt: VALID.loadedAt },
    });
    expect(text(doc)).toContain("rules/alice.yaml:18:7");
    expect(text(doc)).toContain("unknown key `recipient`");
  });

  it("says the last good set keeps deciding after an invalid reload, and everything is denied at boot", () => {
    const reload = text(
      ok({ validity: { state: "invalid-reload", errors: ERRORS, lastGoodAt: VALID.loadedAt } }),
    );
    expect(reload).toContain("keep deciding until the file is fixed");
    const boot = ok({ validity: { state: "invalid-boot", errors: ERRORS } });
    expect(text(boot.querySelector("[role=alert]"))).toContain("every call is denied");
  });

  it("lists watch-mode records with what would have been decided and by which source", () => {
    const doc = ok({ watch: WATCH_ENTRIES });
    const rows = [...doc.querySelectorAll("table")].find((t) =>
      /records?, newest first/.test(text(t.querySelector("caption"))),
    );
    expect(rows?.querySelectorAll("tbody tr")).toHaveLength(WATCH_ENTRIES.length);
    const page = text(doc);
    expect(page).toContain("default deny");
    expect(page).toContain("global watch");
    expect(page).toContain("watch rule");
  });

  it("shows the draft as a diff whose changes are announced in words, plus the rules test results", () => {
    const doc = ok({
      drafting: { state: "ready", prompt: DRAFT_PROMPT, diff: DRAFT_DIFF, tests: FAILING_TESTS },
    });
    const lines = [...doc.querySelectorAll("ol.diff li")];
    expect(lines).toHaveLength(DRAFT_DIFF.length);
    // Diff lines are pre-wrap: any template whitespace inside <li> would render as blank lines.
    for (const line of lines) expect(line.textContent).not.toContain("\n");
    expect(lines.filter((l) => l.getAttribute("data-op") === "add")).toHaveLength(
      DRAFT_DIFF.filter((d) => d.op === "add").length,
    );
    expect(text(doc)).toContain("merge with red checks falls through to deny");
    expect(text(doc)).toContain("allow (merge-any)");
    expect(doc.querySelector("textarea[name=prompt]")?.textContent).toBe(DRAFT_PROMPT);
  });

  it("I-17: a draft is saved only through an explicit save form", () => {
    const doc = ok({
      drafting: { state: "ready", prompt: DRAFT_PROMPT, diff: DRAFT_DIFF, tests: PASSING_TESTS },
    });
    const save = [...doc.querySelectorAll("form")].find(
      (f) => f.getAttribute("action") === "/rules/save",
    );
    expect(save?.querySelector("button[type=submit]")).not.toBeNull();
    expect(text(doc)).toContain("Nothing is saved until you save it.");
  });

  it("I-17: drafting off and drafting unreachable leave the rules untouched", () => {
    expect(text(ok({ drafting: { state: "off" } }))).toContain("Rules still work as written.");
    const failed = ok({ drafting: { state: "error", prompt: DRAFT_PROMPT, message: "timeout" } });
    expect(text(failed)).toContain("couldn't be reached");
    expect([...failed.querySelectorAll("form")].map((f) => f.getAttribute("action"))).not.toContain(
      "/rules/save",
    );
  });

  it("shows a load-error alert", () => {
    expect(text(render({ ok: false, message: "db down" }).querySelector("[role=alert]"))).toContain(
      "db down",
    );
  });
});
