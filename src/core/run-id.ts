/**
 * Run ids. An agent names its run so per-run
 * counts can group its calls. heel stores them as `(agent_id, run_id)`, so
 * two agents sending the same string never share a count.
 *
 * Each surface carries the id its own way; the pipeline parses whatever the
 * carrier held, so every surface treats a bad id the same: ignored and
 * logged, and the call goes on as if it had none (which never matches a
 * `per: run` condition, I-26).
 */

/** MCP: `params._meta["heel/runId"]`. */
export const RUN_ID_META_KEY = "heel/runId";
/** HTTP proxy: a request header. */
export const RUN_ID_HEADER = "Heel-Run-Id";
/** `heel run`: read by the client from its environment and forwarded in the request body. */
export const RUN_ID_ENV = "HEEL_RUN_ID";

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Per-run counts are kept this long after the run's last call, then deleted. */
export const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RunIdParse =
  | { kind: "absent" }
  | { kind: "valid"; runId: string }
  /** Never echo the value: it is agent-supplied and may be long or hostile. */
  | { kind: "invalid"; problem: "not_a_string" | "bad_format" };

/**
 * Pure: classifies a carrier's raw value. An empty string counts as absent
 * (an unset env var forwarded as `""`); anything else must be 1–128
 * characters from `[A-Za-z0-9._:-]`.
 */
export function parseRunId(raw: unknown): RunIdParse {
  if (raw === undefined || raw === null || raw === "") return { kind: "absent" };
  if (typeof raw !== "string") return { kind: "invalid", problem: "not_a_string" };
  return RUN_ID_PATTERN.test(raw)
    ? { kind: "valid", runId: raw }
    : { kind: "invalid", problem: "bad_format" };
}
