import { connect } from "node:net";
import { hasErrnoCode } from "../util/errno.ts";
import {
  ADMIN_IDLE_TIMEOUT_MS,
  type AdminRequest,
  type AdminResponse,
  AdminResponseSchema,
  encodeAdminLine,
} from "./protocol.ts";

/** Why the CLI could not get an answer from `heel serve`. */
export type AdminClientFailure = "not_running" | "permission_denied" | "timeout" | "bad_response";

export class AdminClientError extends Error {
  override readonly name = "AdminClientError";
  readonly failure: AdminClientFailure;
  constructor(failure: AdminClientFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.failure = failure;
  }
}

/** Pure: a message a person can act on for a connect error. */
export function describeConnectError(path: string, error: unknown): AdminClientError {
  if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ECONNREFUSED")) {
    return new AdminClientError("not_running", `heel serve is not running (no socket at ${path})`, {
      cause: error,
    });
  }
  if (hasErrnoCode(error, "EACCES") || hasErrnoCode(error, "EPERM")) {
    return new AdminClientError(
      "permission_denied",
      `permission denied on ${path}; run this command as the heel user`,
      { cause: error },
    );
  }
  return new AdminClientError("not_running", `could not reach heel at ${path}`, { cause: error });
}

/** Sends one request over the admin socket and returns heel's response. */
export function adminCall(
  path: string,
  request: AdminRequest,
  timeoutMs: number = ADMIN_IDLE_TIMEOUT_MS,
): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      outcome();
    };
    const socket = connect(path, () => socket.write(encodeAdminLine(request)));
    socket.setTimeout(timeoutMs, () =>
      settle(() =>
        reject(new AdminClientError("timeout", `heel did not answer within ${timeoutMs} ms`)),
      ),
    );
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error) => settle(() => reject(describeConnectError(path, error))));
    socket.on("end", () =>
      settle(() => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (error) {
          reject(
            new AdminClientError("bad_response", "heel sent a response that is not JSON", {
              cause: error,
            }),
          );
          return;
        }
        const parsed = AdminResponseSchema.safeParse(json);
        if (parsed.success) resolve(parsed.data);
        else reject(new AdminClientError("bad_response", "heel sent a malformed response"));
      }),
    );
  });
}
