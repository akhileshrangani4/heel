import { randomBytes } from "node:crypto";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { adminCall } from "../../src/admin/client.ts";
import type { AdminRequest } from "../../src/admin/protocol.ts";
import { type HeelConfig, HeelConfigFileSchema, resolveConfig } from "../../src/config/schema.ts";
import { createLogger, type Logger } from "../../src/log.ts";
import { type PlaneState, type RunningHeel, startHeel } from "../../src/serve.ts";
import { encodeMasterKey } from "../../src/vault/key.ts";

/** Helpers for tests that boot a real `heel serve` on ephemeral ports. */

export const silent = createLogger("silent");

export function newKey(): string {
  return encodeMasterKey(randomBytes(32));
}

/** A config rooted in a temp dir; both planes bind an ephemeral port unless overridden. */
export function configIn(home: string, file: Record<string, unknown> = {}): HeelConfig {
  const parsed = HeelConfigFileSchema.parse({
    admin_socket: "run/admin.sock",
    listen: { agent: "127.0.0.1:0", human: "127.0.0.1:0" },
    ...file,
  });
  return resolveConfig(parsed, home, null);
}

export async function boot(
  config: HeelConfig,
  env: Record<string, string | undefined>,
  log: Logger = silent,
): Promise<RunningHeel> {
  const heel = await startHeel({ config, env, log, version: "test" });
  onTestFinished(() => heel.close());
  return heel;
}

export function urlOf(plane: PlaneState): string {
  if (plane.state !== "listening") throw new Error(`plane refused: ${plane.reason}`);
  return plane.url;
}

export async function addAgentToken(config: HeelConfig, name: string): Promise<string> {
  const response = await adminCall(config.adminSocketPath, {
    method: "agent.add",
    params: { name },
  });
  if (!response.ok) throw new Error(response.error.message);
  return z.object({ token: z.string() }).parse(response.result).token;
}

/** Sends one admin-socket request and returns its result, throwing on an error response. */
export async function adminOk(config: HeelConfig, request: AdminRequest): Promise<unknown> {
  const response = await adminCall(config.adminSocketPath, request);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}
