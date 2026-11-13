import { type DestinationStream, type Logger, pino } from "pino";
import type { LogLevel } from "./config/schema.ts";

export type { Logger } from "pino";

/**
 * Field names that may hold a credential anywhere in a log object. Credential
 * values reach code as `Secret`s, which already print as a placeholder; this
 * list is the second layer for raw strings (I-02).
 */
const SECRET_KEYS = [
  "authorization",
  "Authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "clientSecret",
  "client_secret",
  "password",
  "secret",
  "masterKey",
] as const;

/** Pure: pino redact paths for each secret key at the top level and up to two levels deep. */
export function redactPaths(): string[] {
  return SECRET_KEYS.flatMap((key) => {
    const field = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
    return [field.slice(field.startsWith(".") ? 1 : 0), `*${field}`, `*.*${field}`];
  });
}

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: "heel" },
    redact: { paths: redactPaths(), censor: "[redacted by heel]" },
  };
  return destination ? pino(options, destination) : pino(options);
}
