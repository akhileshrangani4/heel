import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { lineDiff } from "../../drafting/draft.ts";
import {
  applyEdit,
  type RulesEdit,
  rulesCheck,
  rulesProblems,
  textHash,
  viewRules,
} from "../../proposals/edit.ts";
import { ownerRulesFile } from "../../proposals/rules.ts";
import { noticeRuleFiles, recordWebChange } from "../../store/rule-changes.ts";
import { users } from "../../store/schema.ts";
import { hasErrnoCode } from "../../util/errno.ts";
import {
  formField,
  type HumanPlaneDeps,
  jsonBody,
  passkeyChallenge,
  passkeyFailed,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  verifiedBinding,
  viewerOf,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { type RulesPreview, rulesEditorPage } from "../ui/rules-editor.ts";

/**
 * Your rules file in the web app, words first: each rule as a
 * sentence, a decision changed from a menu, a rule or hide entry removed,
 * and, behind a fold, the YAML itself. Any change is previewed (in words and
 * as a diff, with the file's checks) before a passkey saves it. The passkey
 * signs the file's hash before and after, so only that exact change is made
 * to that exact file.
 *
 * - `GET /rules` (with `?op=…` to preview a menu change), `POST /rules/check`
 *   to preview text edited directly.
 * - `POST /rules/challenge` then `POST /rules/confirm` save it.
 */

const MAX_RULES_BYTES = 256 * 1024;
const DECISIONS = new Set(["allow", "ask", "deny"]);

function editFromQuery(query: Record<string, string>): RulesEdit | null {
  const index = Number.parseInt(query["index"] ?? "", 10);
  if (!Number.isInteger(index) || index < 0) return null;
  if (query["op"] === "decision" && DECISIONS.has(query["then"] ?? "")) {
    return { kind: "decision", index, decision: query["then"] as "allow" | "ask" | "deny" };
  }
  if (query["op"] === "remove-rule") return { kind: "remove-rule", index };
  if (query["op"] === "remove-hide") return { kind: "remove-hide", index };
  return null;
}

export function rulesEditorRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  /** This person's own rules file: where it is, how the history names it, and its text. */
  function fileOf(session: SessionView) {
    const files = deps.ruleFiles;
    if (files === undefined) return null;
    const name = deps.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, session.userId))
      .get()?.name;
    const path = name === undefined ? null : ownerRulesFile(files.paths, name);
    if (path === null) return null;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
    }
    return { path, display: relative(files.paths.home, path), text };
  }

  function page(
    c: Context<SignedInEnv>,
    preview: RulesPreview | null,
    problem: string | null = null,
  ) {
    const session = c.get("session");
    const file = fileOf(session);
    return renderPage(c, {
      title: "Rules",
      viewer: viewerOf(session),
      current: "rules",
      body: rulesEditorPage({
        file:
          file === null
            ? null
            : { display: file.display, text: file.text, view: viewRules(file.text, file.display) },
        preview,
        problem,
        saved:
          "saved" in c.req.query() ? "live" : "saved-pending" in c.req.query() ? "pending" : null,
        csrfToken: session.csrfToken,
      }),
      script: clientScript(session.csrfToken),
    });
  }

  function previewOf(
    file: { text: string; display: string },
    edit: RulesEdit,
    /** Opened from this person's own Rules page (its CSRF token), so it may offer Save. */
    trusted: boolean,
  ): RulesPreview | string {
    const after = applyEdit(file.text, edit);
    if (!after.ok) return after.problem;
    if (Buffer.byteLength(after.text) > MAX_RULES_BYTES)
      return "That's larger than heel keeps a rules file.";
    return {
      edit,
      text: after.text,
      before: textHash(file.text),
      after: textHash(after.text),
      diff: lineDiff(file.text, after.text),
      ...rulesCheck(after.text, file.display),
      trusted,
      // toString can respace a file even when the decision is the same, so ask the rule too.
      unchanged:
        after.text === file.text ||
        (edit.kind === "decision" &&
          viewRules(file.text, file.display).rules[edit.index]?.decision === edit.decision),
      view: viewRules(after.text, file.display),
    };
  }

  app.get("/rules", signedIn, (c) => {
    const file = fileOf(c.get("session"));
    const edit = editFromQuery(c.req.query());
    if (file === null || edit === null) return page(c, null);
    // A link from anywhere else can show a change, but never offer to save it.
    const preview = previewOf(file, edit, c.req.query("csrf") === c.get("session").csrfToken);
    return typeof preview === "string" ? page(c, null, preview) : page(c, preview);
  });

  app.post("/rules/check", signedIn, requireCsrfField(), async (c) => {
    const file = fileOf(c.get("session"));
    if (file === null) return page(c, null);
    const text = ((await formField(c, "text")) ?? "").replace(/\r\n/g, "\n");
    const preview = previewOf(file, { kind: "replace", text }, true);
    return typeof preview === "string" ? page(c, null, preview) : page(c, preview);
  });

  app.post("/rules/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const file = fileOf(session);
    if (file === null)
      return c.json({ ok: false, message: "heel can't edit rules files here." }, 404);
    const text = stringField(body, "text") ?? "";
    if (Buffer.byteLength(text) > MAX_RULES_BYTES) {
      return c.json({ ok: false, message: "That's larger than heel keeps a rules file." }, 413);
    }
    if (stringField(body, "before") !== textHash(file.text)) {
      return c.json(
        { ok: false, message: "Your rules file changed since this page loaded. Reload it." },
        409,
      );
    }
    if (
      stringField(body, "after") !== textHash(text) ||
      rulesProblems(text, file.display) !== null
    ) {
      return c.json(
        { ok: false, message: "This change doesn't load as a rules file. Nothing was saved." },
        409,
      );
    }
    return passkeyChallenge(c, deps, "rules", {
      edit: "file",
      before: textHash(file.text),
      after: textHash(text),
    });
  });

  app.post("/rules/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const binding = await verifiedBinding(c, deps, "rules");
    if (binding === null) return passkeyFailed(c);
    const { edit, before, after } = binding;
    const file = fileOf(session);
    const text = stringField(body, "text") ?? "";
    // Only the signed change, to the signed file: the text must hash to what was signed.
    if (
      edit !== "file" ||
      file === null ||
      before !== textHash(file.text) ||
      after !== textHash(text)
    ) {
      return c.json(
        {
          ok: false,
          message: "Your rules file changed since you approved this. Nothing was saved.",
        },
        409,
      );
    }
    if (rulesProblems(text, file.display) !== null) {
      return c.json(
        { ok: false, message: "This change doesn't load as a rules file. Nothing was saved." },
        409,
      );
    }
    // Any edit made by hand since heel last looked gets its own entry, not folded into this one.
    if (deps.ruleFiles !== undefined) {
      noticeRuleFiles(deps.db, deps.orgId, deps.ruleFiles.paths, deps.now());
    }
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, text);
    // In the same synchronous step as the write, so the reload doesn't count it as made outside heel.
    recordWebChange(deps.db, {
      orgId: deps.orgId,
      userId: session.userId,
      file: file.display,
      before: file.text,
      after: text,
      now: deps.now(),
    });
    // Saved either way; whether heel is using it yet depends on every rules file loading.
    let live = false;
    try {
      live = deps.ruleFiles?.reload() !== false;
    } catch (error) {
      deps.log.error({ err: error }, "rules saved, but reloading them failed");
    }
    deps.log.warn({ file: file.display, by: session.userId }, "rules changed in the web app");
    return c.json({ ok: true, next: live ? "/rules?saved" : "/rules?saved-pending" });
  });

  return app;
}
