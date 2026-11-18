import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Definition, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { listedTools, type MailTool, mailDefinition } from "../mail/tool.ts";
import type { FetchFn } from "../sign-in.ts";
import { GitHubApi } from "./api.ts";
import { GitHubClient, GitHubNotFoundError, GitHubWriteRefused } from "./client.ts";

/**
 * The GitHub definition (D11; spec: Built-in providers, "GitHub"): heel's
 * own tools on GitHub's REST API, with the account's token.
 *
 * - `repo` is always set, lower-cased, so a rule on `acme/web` meets
 *   `Acme/Web`.
 * - Reads are `github.read`. Writes are `github.comment`,
 *   `github.issue.create`, `github.issue.update`, `github.pr.create`,
 *   `github.pr.update`, `github.push` and `github.merge`.
 * - `merge_pull_request` reads the head commit before rules run and merges
 *   with `sha` set to it, so GitHub refuses the merge if the head moved;
 *   `checks: passing` is read on that same commit. There is no tool for
 *   auto-merge or bypassing rules.
 * - A file write under `.github/workflows/` or `.github/actions/` is its
 *   own action, `github.workflow.push`, and persistence (I-70): a workflow
 *   can run on a schedule after heel is revoked, so a rule allowing
 *   `github.push` doesn't reach it. A merge whose files include one is
 *   `github.workflow.merge`, for the same reason. heel offers no tool
 *   for webhooks, deploy keys, collaborators, or Actions secrets and
 *   variables.
 */

export interface GitHubDeps {
  vault: Vault;
  fetch: FetchFn;
}

interface Box {
  client: GitHubClient;
  api: GitHubApi;
}

type GitHubTool = MailTool<Box>;
const tool = <S extends z.ZodType, P, R>(t: MailTool<Box, S, P, R>) => t as unknown as GitHubTool;

const Repo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "expected owner/name")
  .refine((r) => !r.split("/").some((part) => part === "." || part === ".."), "expected owner/name")
  .transform((r) => r.toLowerCase());
const Number_ = z.number().int().min(1).max(2_147_483_647);
const State = z.enum(["open", "closed", "all"]).default("open");
const Page = z.number().int().min(1).max(1_000).default(1);
const PerPage = z.number().int().min(1).max(100).default(30);
const Text = z.string().max(65_536);
const Title = z.string().min(1).max(256);
/** A branch, tag or commit, by git's ref rules: no `..`, `@{`, leading `-` or `.`, `.lock` ending. */
const Ref = z
  .string()
  .regex(/^[^\s~^:?*[\\]{1,255}$/, "expected a branch, tag or commit")
  .refine(
    (r) =>
      !r.includes("..") &&
      !r.includes("@{") &&
      !r.startsWith("-") &&
      !r.endsWith(".lock") &&
      !r.endsWith("/") &&
      !r.split("/").some((part) => part === "" || part.startsWith(".")),
    "expected a branch, tag or commit",
  );
/** A path in the repo: no leading slash, no `.` or `..` segments. */
const FilePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === ".."),
    "expected a path inside the repo",
  );

const read = (repo: string, targets?: string[]) => ({
  action: "github.read",
  repo,
  ...(targets === undefined ? {} : { targets }),
});
const pr = (repo: string, number: number) => `${repo}#${number}`;
const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** An issue or pull request as the agent reads it. */
function shownIssue(raw: unknown) {
  const i = raw as Record<string, unknown>;
  return {
    number: i["number"],
    title: i["title"],
    state: i["state"],
    body: i["body"] ?? null,
    author: (i["user"] as { login?: unknown } | null)?.login ?? null,
    labels: Array.isArray(i["labels"])
      ? (i["labels"] as { name?: unknown }[]).map((l) => l.name)
      : [],
    url: i["html_url"] ?? null,
    ...(i["head"] === undefined
      ? {}
      : {
          head: (i["head"] as { ref?: unknown; sha?: unknown }).ref ?? null,
          head_sha: (i["head"] as { sha?: unknown }).sha ?? null,
          base: (i["base"] as { ref?: unknown } | undefined)?.ref ?? null,
          draft: i["draft"] ?? false,
          merged: i["merged"] ?? null,
        }),
  };
}
const shownList = (raw: unknown) => (Array.isArray(raw) ? raw.map(shownIssue) : []);
const passThrough = async (_box: Box, result: unknown) => result;

const TOOLS: Record<string, GitHubTool> = {
  list_pull_requests: tool({
    description: "List pull requests in a repository.",
    args: z.strictObject({ repo: Repo, state: State, page: Page, per_page: PerPage }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo) }),
    run: (box, a, signal) =>
      box.client.get(`/repos/${a.repo}/pulls`, signal, {
        state: a.state,
        page: a.page,
        per_page: a.per_page,
      }),
    show: async (_box, result) => ({ pull_requests: shownList(result) }),
  }),

  get_pull_request: tool({
    description: "Read one pull request, with its head commit.",
    args: z.strictObject({ repo: Repo, number: Number_ }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo, [pr(args.repo, args.number)]) }),
    run: (box, a, signal) => box.client.get(`/repos/${a.repo}/pulls/${a.number}`, signal),
    show: async (_box, result) => shownIssue(result),
  }),

  list_pull_request_files: tool({
    description: "List the files a pull request changes, with their patches.",
    args: z.strictObject({ repo: Repo, number: Number_, page: Page, per_page: PerPage }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo, [pr(args.repo, args.number)]) }),
    run: (box, a, signal) =>
      box.client.get(`/repos/${a.repo}/pulls/${a.number}/files`, signal, {
        page: a.page,
        per_page: a.per_page,
      }),
    show: async (_box, result) => ({
      files: Array.isArray(result)
        ? (result as Record<string, unknown>[]).map((f) => ({
            filename: f["filename"],
            status: f["status"],
            additions: f["additions"],
            deletions: f["deletions"],
            patch: f["patch"] ?? null,
          }))
        : [],
    }),
  }),

  list_issues: tool({
    description: "List issues in a repository (pull requests are left out).",
    args: z.strictObject({ repo: Repo, state: State, page: Page, per_page: PerPage }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo) }),
    run: (box, a, signal) =>
      box.client.get(`/repos/${a.repo}/issues`, signal, {
        state: a.state,
        page: a.page,
        per_page: a.per_page,
      }),
    show: async (_box, result) => ({
      issues: shownList(
        Array.isArray(result)
          ? (result as Record<string, unknown>[]).filter((i) => i["pull_request"] === undefined)
          : [],
      ),
    }),
  }),

  get_issue: tool({
    description: "Read one issue.",
    args: z.strictObject({ repo: Repo, number: Number_ }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo, [pr(args.repo, args.number)]) }),
    run: (box, a, signal) => box.client.get(`/repos/${a.repo}/issues/${a.number}`, signal),
    show: async (_box, result) => shownIssue(result),
  }),

  get_file_contents: tool({
    description: "Read a file from a repository, as text.",
    args: z.strictObject({ repo: Repo, path: FilePath, ref: Ref.optional() }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo) }),
    run: (box, a, signal) =>
      box.client.request("GET", `/repos/${a.repo}/contents/${encode(a.path)}`, signal, {
        query: { ref: a.ref },
        accept: "application/vnd.github.raw+json",
      }),
    show: async (_box, result) => ({
      content: typeof result === "string" ? result : null,
    }),
  }),

  list_check_runs: tool({
    description: "List the check runs on a commit, branch or tag.",
    args: z.strictObject({ repo: Repo, ref: Ref, page: Page, per_page: PerPage }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, ...read(args.repo) }),
    run: (box, a, signal) =>
      box.client.get(`/repos/${a.repo}/commits/${encodeURIComponent(a.ref)}/check-runs`, signal, {
        page: a.page,
        per_page: a.per_page,
      }),
    show: async (_box, result) => {
      const runs = (result as { check_runs?: Record<string, unknown>[] }).check_runs ?? [];
      return {
        check_runs: runs.map((r) => ({
          name: r["name"],
          status: r["status"],
          conclusion: r["conclusion"] ?? null,
        })),
      };
    },
  }),

  create_issue: tool({
    description: "Open an issue.",
    args: z.strictObject({
      repo: Repo,
      title: Title,
      body: Text.optional(),
      labels: z.array(z.string().max(50)).max(20).optional(),
    }),
    readOnly: false,
    prepare: async (_box, args) => ({ args, repo: args.repo, action: "github.issue.create" }),
    run: (box, a, signal) =>
      box.client.request("POST", `/repos/${a.repo}/issues`, signal, {
        body: { title: a.title, body: a.body, labels: a.labels },
      }),
    show: async (_box, result) => shownIssue(result),
  }),

  update_issue: tool({
    description: "Change an issue's title, body, state or labels.",
    args: z.strictObject({
      repo: Repo,
      number: Number_,
      title: Title.optional(),
      body: Text.optional(),
      state: z.enum(["open", "closed"]).optional(),
      labels: z.array(z.string().max(50)).max(20).optional(),
    }),
    readOnly: false,
    prepare: async (_box, args) => ({
      args,
      repo: args.repo,
      action: "github.issue.update",
      targets: [pr(args.repo, args.number)],
    }),
    run: (box, { repo, number, ...change }, signal) =>
      box.client.request("PATCH", `/repos/${repo}/issues/${number}`, signal, { body: change }),
    show: async (_box, result) => shownIssue(result),
  }),

  add_comment: tool({
    description: "Comment on an issue or a pull request.",
    args: z.strictObject({ repo: Repo, number: Number_, body: Text.min(1) }),
    readOnly: false,
    prepare: async (_box, args) => ({
      args,
      repo: args.repo,
      action: "github.comment",
      targets: [pr(args.repo, args.number)],
    }),
    run: (box, a, signal) =>
      box.client.request("POST", `/repos/${a.repo}/issues/${a.number}/comments`, signal, {
        body: { body: a.body },
      }),
    show: async (_box, result) => ({
      id: (result as { id?: unknown }).id ?? null,
      url: (result as { html_url?: unknown }).html_url ?? null,
    }),
  }),

  create_pull_request: tool({
    description: "Open a pull request from a branch.",
    args: z.strictObject({
      repo: Repo,
      title: Title,
      head: Ref,
      base: Ref,
      body: Text.optional(),
      draft: z.boolean().default(false),
    }),
    readOnly: false,
    prepare: async (_box, args) => ({ args, repo: args.repo, action: "github.pr.create" }),
    run: (box, { repo, ...pull }, signal) =>
      box.client.request("POST", `/repos/${repo}/pulls`, signal, { body: pull }),
    show: async (_box, result) => shownIssue(result),
  }),

  update_pull_request: tool({
    description: "Change a pull request's title, body, state or base branch.",
    args: z.strictObject({
      repo: Repo,
      number: Number_,
      title: Title.optional(),
      body: Text.optional(),
      state: z.enum(["open", "closed"]).optional(),
      base: Ref.optional(),
    }),
    readOnly: false,
    prepare: async (_box, args) => ({
      args,
      repo: args.repo,
      action: "github.pr.update",
      targets: [pr(args.repo, args.number)],
    }),
    run: (box, { repo, number, ...change }, signal) =>
      box.client.request("PATCH", `/repos/${repo}/pulls/${number}`, signal, { body: change }),
    show: async (_box, result) => shownIssue(result),
  }),

  merge_pull_request: tool({
    description:
      "Merge a pull request at the head commit heel checked. If the head moves first, GitHub refuses the merge.",
    args: z.strictObject({
      repo: Repo,
      number: Number_,
      method: z.enum(["merge", "squash", "rebase"]).default("merge"),
      commit_title: z.string().max(256).optional(),
      commit_message: Text.optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _hiding, signal) => {
      const head = await box.api.pullHead(args.repo, args.number, signal);
      if (head.state !== "open" || head.merged) return { deny: "unsupported" };
      // Merging lands its files on the base branch: a workflow among them is persistence (I-70).
      const files = await box.api.pullFiles(args.repo, args.number, signal);
      const automation = files.some(isWorkflowPath);
      return {
        args: { ...args, sha: head.sha, base: head.base },
        repo: args.repo,
        // Its own action, so a rule allowing ordinary merges doesn't reach it.
        action: automation ? "github.workflow.merge" : "github.merge",
        targets: [pr(args.repo, args.number)],
        ...(automation ? { persistence: true } : {}),
      };
    },
    run: (box, a, signal) =>
      box.client.request("PUT", `/repos/${a.repo}/pulls/${a.number}/merge`, signal, {
        body: {
          sha: a.sha,
          merge_method: a.method,
          commit_title: a.commit_title,
          commit_message: a.commit_message,
        },
      }),
    show: passThrough,
  }),

  put_file: tool({
    description:
      "Create or replace a file on a branch, as one commit. `content` is the file's text; `sha` is the blob being replaced, when there is one.",
    args: z.strictObject({
      repo: Repo,
      path: FilePath,
      content: z.string().max(10 * 1024 * 1024),
      message: z.string().min(1).max(4_096),
      branch: Ref,
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
    }),
    readOnly: false,
    prepare: async (_box, args) => ({
      args,
      repo: args.repo,
      // A workflow can run on a schedule after heel is revoked (I-70).
      ...(isWorkflowPath(args.path)
        ? { action: "github.workflow.push", persistence: true }
        : { action: "github.push" }),
    }),
    run: (box, a, signal) =>
      box.client.request("PUT", `/repos/${a.repo}/contents/${encode(a.path)}`, signal, {
        body: {
          message: a.message,
          content: Buffer.from(a.content, "utf8").toString("base64"),
          branch: a.branch,
          ...(a.sha === undefined ? {} : { sha: a.sha }),
        },
      }),
    show: async (_box, result) => ({
      commit: (result as { commit?: { sha?: unknown } }).commit?.sha ?? null,
    }),
  }),
};

/** `.github/workflows/...`, compared the way GitHub resolves it (case-insensitively). */
/**
 * A path that becomes automation when it lands: workflows, and the composite
 * actions workflows run. Compared the way GitHub resolves it (ignoring case).
 */
export function isWorkflowPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith(".github/workflows/") || p.startsWith(".github/actions/");
}

/** `github.merge`, or a merge that lands automation (`github.workflow.merge`). */
export function isMergeAction(action: string | undefined): boolean {
  return action === "github.merge" || action === "github.workflow.merge";
}

export const GITHUB_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function githubDefinition(account: AccountRecord, deps: GitHubDeps): Definition {
  const token = async () => (await deps.vault.accessToken(account.id)).reveal();
  const box: Box = {
    client: new GitHubClient(deps.fetch, token),
    api: new GitHubApi(token, deps.fetch),
  };
  return mailDefinition({
    tools: TOOLS,
    listed: GITHUB_TOOLS,
    mailbox: box,
    errors: {
      isNotFound: (error) => error instanceof GitHubNotFoundError,
      refusal: (error) =>
        error instanceof GitHubWriteRefused ? new UpstreamError(error.status, error.body) : null,
    },
    stateCheck: async (check, b, call, signal) => {
      if (check !== "checks" || !isMergeAction(call.action) || call.repo === undefined) {
        return "fail";
      }
      const { sha, base } = call.args as { sha?: unknown; base?: unknown };
      if (typeof sha !== "string" || typeof base !== "string") return "fail";
      return (await b.api.checksPass(call.repo, sha, base, signal)) ? "pass" : "fail";
    },
  });
}
