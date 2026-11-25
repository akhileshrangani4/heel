import type { FetchFn } from "../sign-in.ts";

/**
 * The few GitHub REST reads heel makes itself, with the account's own token:
 * a pull request's head commit,
 * and whether the checks on a commit pass. Every answer heel can't read
 * plainly is an error, so the lookup is unavailable and the call is denied.
 */

import { GITHUB_API, GitHubNotFoundError } from "./client.ts";

export { GITHUB_API };

export class GitHubLookupError extends Error {
  override readonly name = "GitHubLookupError";
}

/** `owner/name` as heel stores it: lower-case, one slash, GitHub's own characters. */
const REPO = /^(?!\.{1,2}\/)[a-z0-9_.-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/;

export interface PullHead {
  sha: string;
  /** The branch it merges into. */
  base: string;
  state: "open" | "closed";
  merged: boolean;
}

/** Check-run conclusions that count as passing. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const MAX_PAGES = 30;
const SHA = /^[0-9a-f]{40}$/;

export class GitHubApi {
  readonly #token: () => Promise<string>;
  readonly #fetch: FetchFn;

  constructor(token: () => Promise<string>, fetch: FetchFn) {
    this.#token = token;
    this.#fetch = fetch;
  }

  async #get(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetch(new URL(path, GITHUB_API), {
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal,
    });
    if (response.status === 404) throw new GitHubNotFoundError(`${path} not found`);
    if (!response.ok) throw new GitHubLookupError(`GitHub answered ${response.status} for ${path}`);
    return response.json();
  }

  /** Every item of a paged list, failing if the pages run out before the count does. */
  async #all<T>(
    path: string,
    pick: (body: unknown) => { items: T[]; total?: number } | null,
    signal: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new GitHubLookupError(`too many pages at ${path}`);
      const sep = path.includes("?") ? "&" : "?";
      const picked = pick(await this.#get(`${path}${sep}per_page=100&page=${page}`, signal));
      if (picked === null) throw new GitHubLookupError(`${path} isn't readable`);
      items.push(...picked.items);
      const done =
        picked.total === undefined ? picked.items.length < 100 : items.length >= picked.total;
      if (done) return items;
      if (picked.items.length === 0) throw new GitHubLookupError(`${path} ended before its count`);
    }
  }

  /** The pull request's current head commit and base branch. */
  async pullHead(repo: string, number: number, signal: AbortSignal): Promise<PullHead> {
    if (!REPO.test(repo) || !Number.isSafeInteger(number) || number < 1) {
      throw new GitHubLookupError("not a pull request heel can look up");
    }
    const pull = (await this.#get(`/repos/${repo}/pulls/${number}`, signal)) as {
      head?: { sha?: unknown };
      base?: { ref?: unknown };
      state?: unknown;
      merged?: unknown;
    };
    const sha = pull.head?.sha;
    const base = pull.base?.ref;
    if (typeof sha !== "string" || !SHA.test(sha) || typeof base !== "string" || base === "") {
      throw new GitHubLookupError("the pull request has no head or base heel can read");
    }
    if (pull.state !== "open" && pull.state !== "closed") {
      throw new GitHubLookupError("the pull request's state isn't readable");
    }
    return { sha, base, state: pull.state, merged: pull.merged === true };
  }

  /** Every file path the pull request changes (GitHub lists at most 3,000; more is refused). */
  async pullFiles(repo: string, number: number, signal: AbortSignal): Promise<string[]> {
    const files = await this.#all<{ filename?: unknown; previous_filename?: unknown }>(
      `/repos/${repo}/pulls/${number}/files`,
      (body) => (Array.isArray(body) ? { items: body } : null),
      signal,
    );
    if (files.length >= 3_000)
      throw new GitHubLookupError("the pull request changes too many files to read");
    return files.flatMap((f) =>
      [f.filename, f.previous_filename].filter((n): n is string => typeof n === "string"),
    );
  }

  /** The status check contexts the base branch's rules require; empty when none, or unreadable rules aren't there. */
  async #requiredContexts(repo: string, base: string, signal: AbortSignal): Promise<string[]> {
    const rules = await this.#get(
      `/repos/${repo}/rules/branches/${encodeURIComponent(base)}`,
      signal,
    );
    if (!Array.isArray(rules)) throw new GitHubLookupError("the branch rules aren't readable");
    const contexts: string[] = [];
    for (const rule of rules as {
      type?: unknown;
      parameters?: { required_status_checks?: unknown };
    }[]) {
      if (rule.type !== "required_status_checks") continue;
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks))
        throw new GitHubLookupError("a required-checks rule isn't readable");
      for (const check of checks as { context?: unknown }[]) {
        if (typeof check.context !== "string")
          throw new GitHubLookupError("a required check has no name");
        contexts.push(check.context);
      }
    }
    // Classic branch protection, where the token may read it; a 404 or 403 means none heel can see.
    try {
      const classic = (await this.#get(
        `/repos/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
        signal,
      )) as { contexts?: unknown; checks?: unknown };
      if (Array.isArray(classic.contexts)) {
        contexts.push(...classic.contexts.filter((c): c is string => typeof c === "string"));
      }
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError) && !/answered 403/.test(String(error)))
        throw error;
    }
    return [...new Set(contexts)];
  }

  /**
   * Whether the checks on `sha` pass:
   *
   * - every check run completed as success, neutral or skipped, and every
   *   commit status, if any, success;
   * - no check suite still running, queued with runs, or waiting for
   *   approval (a fork's Actions run);
   * - every check the base branch's rules require is present and passing,
   *   so a required check that hasn't reported yet fails it;
   * - at least one run or status actually succeeded: no checks, or only
   *   skipped ones, fail.
   *
   * Stricter than GitHub's own "required checks": a failing optional check
   * also fails it.
   */
  async checksPass(repo: string, sha: string, base: string, signal: AbortSignal): Promise<boolean> {
    if (!REPO.test(repo) || !SHA.test(sha))
      throw new GitHubLookupError("not a commit heel can look up");
    const runs = await this.#all<{ name?: unknown; status?: unknown; conclusion?: unknown }>(
      `/repos/${repo}/commits/${sha}/check-runs`,
      (body) => {
        const b = body as { total_count?: unknown; check_runs?: unknown };
        return Array.isArray(b.check_runs) && typeof b.total_count === "number"
          ? { items: b.check_runs, total: b.total_count }
          : null;
      },
      signal,
    );
    const suites = await this.#all<{
      status?: unknown;
      conclusion?: unknown;
      latest_check_runs_count?: unknown;
    }>(
      `/repos/${repo}/commits/${sha}/check-suites`,
      (body) => {
        const b = body as { total_count?: unknown; check_suites?: unknown };
        return Array.isArray(b.check_suites) && typeof b.total_count === "number"
          ? { items: b.check_suites, total: b.total_count }
          : null;
      },
      signal,
    );
    const combined = (await this.#get(`/repos/${repo}/commits/${sha}/status`, signal)) as {
      state?: unknown;
      total_count?: unknown;
      statuses?: unknown;
    };
    if (typeof combined.total_count !== "number" || !Array.isArray(combined.statuses)) {
      throw new GitHubLookupError("the commit status isn't readable");
    }
    const required = await this.#requiredContexts(repo, base, signal);

    for (const run of runs) {
      if (run.status !== "completed") return false;
      if (typeof run.conclusion !== "string" || !PASSING_CONCLUSIONS.has(run.conclusion))
        return false;
    }
    for (const suite of suites) {
      if (suite.conclusion === "action_required" || suite.status === "in_progress") return false;
      if (suite.status === "queued" && suite.latest_check_runs_count !== 0) return false;
    }
    if (combined.total_count > 0 && combined.state !== "success") return false;

    const statuses = combined.statuses as { context?: unknown; state?: unknown }[];
    const passing = new Set<string>([
      ...runs
        .filter((r) => r.conclusion === "success" || r.conclusion === "neutral")
        .map((r) => String(r.name)),
      ...statuses.filter((s) => s.state === "success").map((s) => String(s.context)),
    ]);
    if (!required.every((context) => passing.has(context))) return false;
    const succeeded =
      runs.some((r) => r.conclusion === "success") || statuses.some((s) => s.state === "success");
    return succeeded;
  }
}
