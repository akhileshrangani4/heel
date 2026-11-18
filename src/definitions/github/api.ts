import type { FetchFn } from "../sign-in.ts";

/**
 * The few GitHub REST reads heel makes itself, with the account's own token
 * (D11; spec: Built-in providers, "GitHub"): a pull request's head commit,
 * and whether the checks on a commit pass. Every answer heel can't read
 * plainly is an error, so the lookup is unavailable and the call is denied.
 */

import { GITHUB_API, GitHubNotFoundError } from "./client.ts";

export { GITHUB_API };

export class GitHubLookupError extends Error {
  override readonly name = "GitHubLookupError";
}

/** `owner/name` as heel stores it: lower-case, one slash, GitHub's own characters. */
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export interface PullHead {
  sha: string;
  state: "open" | "closed";
  merged: boolean;
}

/** Check-run conclusions that count as passing. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const MAX_PAGES = 10;

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

  /** The pull request's current head commit. */
  async pullHead(repo: string, number: number, signal: AbortSignal): Promise<PullHead> {
    if (!REPO.test(repo) || !Number.isSafeInteger(number) || number < 1) {
      throw new GitHubLookupError("not a pull request heel can look up");
    }
    const pull = (await this.#get(`/repos/${repo}/pulls/${number}`, signal)) as {
      head?: { sha?: unknown };
      state?: unknown;
      merged?: unknown;
    };
    const sha = pull.head?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GitHubLookupError("the pull request has no head commit heel can read");
    }
    if (pull.state !== "open" && pull.state !== "closed") {
      throw new GitHubLookupError("the pull request's state isn't readable");
    }
    return { sha, state: pull.state, merged: pull.merged === true };
  }

  /**
   * Whether every check on `sha` passes: each check run completed as
   * success, neutral or skipped, and the combined commit status, if the
   * commit has any statuses, is success. A commit with no checks at all
   * doesn't pass, so a merge right after a push, before CI has registered,
   * isn't let through. This is stricter than "required checks": a failing
   * optional check also fails it.
   */
  async checksPass(repo: string, sha: string, signal: AbortSignal): Promise<boolean> {
    if (!REPO.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GitHubLookupError("not a commit heel can look up");
    }
    let runs = 0;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new GitHubLookupError("too many check runs to read");
      const body = (await this.#get(
        `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
        signal,
      )) as { total_count?: unknown; check_runs?: unknown };
      if (!Array.isArray(body.check_runs) || typeof body.total_count !== "number") {
        throw new GitHubLookupError("the check runs aren't readable");
      }
      for (const run of body.check_runs as { status?: unknown; conclusion?: unknown }[]) {
        runs++;
        if (run.status !== "completed") return false;
        if (typeof run.conclusion !== "string" || !PASSING_CONCLUSIONS.has(run.conclusion)) {
          return false;
        }
      }
      if (runs >= body.total_count || body.check_runs.length === 0) break;
    }
    const combined = (await this.#get(`/repos/${repo}/commits/${sha}/status`, signal)) as {
      state?: unknown;
      total_count?: unknown;
    };
    if (typeof combined.total_count !== "number") {
      throw new GitHubLookupError("the commit status isn't readable");
    }
    if (combined.total_count > 0 && combined.state !== "success") return false;
    return runs + combined.total_count > 0;
  }
}
