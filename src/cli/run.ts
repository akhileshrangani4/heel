import { parseArgs } from "node:util";
import { RUN_ID_ENV } from "../core/run-id.ts";
import type { CliIo } from "./common.ts";
import { parseOrUsage, UsageError } from "./common.ts";

/**
 * `heel run [--account <alias>] [--reason <text>] [--json] -- <cmd> [args...]`.
 * Runs on the agent's side with only the agent's token: it posts the command
 * line and the current directory to heel's `/run` and never runs anything
 * itself.
 *
 * When the command ran, its output is written out and its own exit code
 * returned. When it didn't, one line `heel: {"status":...}` goes to stderr
 * and the exit code says why: 75 pending or busy (too
 * many commands and scripts running; send it again later), 77 denied or
 * expired, 69 paused, 70 a heel error, a sandbox limit or no sandbox, 64 a
 * usage error, here or in the request heel refused. With
 * `--json` the whole answer goes to stdout instead, and the exit codes stay.
 */

export const RUN_EXIT = {
  pending: 75,
  denied: 77,
  paused: 69,
  error: 70,
  usage: 64,
} as const;

export interface RunDeps {
  fetch: typeof fetch;
  cwd: () => string;
}

export async function runCommand(args: string[], io: CliIo, deps: RunDeps): Promise<number> {
  const split = args.indexOf("--");
  if (split === -1) throw new UsageError("heel run needs -- before the command");
  const { values } = parseOrUsage(() =>
    parseArgs({
      args: args.slice(0, split),
      options: {
        account: { type: "string" },
        reason: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    }),
  );
  const argv = args.slice(split + 1);
  if (argv.length === 0) throw new UsageError("missing the command after --");
  const token = io.env["HEEL_TOKEN"];
  const base = io.env["HEEL_URL"];
  if (token === undefined || token === "") throw new UsageError("HEEL_TOKEN isn't set");
  // `localhost:7300` parses as a URL with the scheme `localhost:`; only http(s) reaches heel.
  if (base === undefined || !/^https?:$/.test(URL.parse(base)?.protocol ?? "")) {
    throw new UsageError("HEEL_URL isn't an http:// or https:// URL");
  }
  const runId = io.env[RUN_ID_ENV];
  const body = {
    argv,
    cwd: deps.cwd(),
    ...(runId === undefined || runId === "" ? {} : { runId }),
    ...(values.account === undefined ? {} : { account: values.account }),
    ...(values.reason === undefined ? {} : { reason: values.reason }),
  };

  let answer: Record<string, unknown>;
  try {
    const response = await deps.fetch(new URL("run", base.endsWith("/") ? base : `${base}/`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    });
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    answer = parsed as Record<string, unknown>;
  } catch (error) {
    answer = { status: "error", detail: `couldn't reach heel: ${(error as Error).message}` };
  }

  const status = answer["status"];
  if (values.json === true) io.stdout.write(`${JSON.stringify(answer)}\n`);
  if (status === "ran") {
    if (values.json !== true) {
      io.stdout.write(String(answer["stdout"] ?? ""));
      io.stderr.write(String(answer["stderr"] ?? ""));
    }
    const code = answer["exitCode"];
    return typeof code === "number" && Number.isInteger(code) ? code : RUN_EXIT.error;
  }
  if (values.json !== true) io.stderr.write(`heel: ${JSON.stringify(answer)}\n`);
  // heel refused the request itself: the command line or the account choice, not a rule.
  const reason = answer["reason"];
  if (status === "denied" && (reason === "invalid_request" || reason === "account_ambiguous")) {
    return RUN_EXIT.usage;
  }
  switch (status) {
    case "pending":
    case "busy":
      return RUN_EXIT.pending;
    case "denied":
    case "expired":
      return RUN_EXIT.denied;
    case "paused":
      return RUN_EXIT.paused;
    default:
      return RUN_EXIT.error;
  }
}
