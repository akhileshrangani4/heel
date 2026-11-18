import { parse } from "yaml";

/**
 * The parts of an OpenAPI 3.0 or 3.1 file heel uses for an HTTP account
 * (D7a; spec: HTTP proxy, "Other APIs"): each operation's method and path
 * template, its `operationId`, and the `x-heel-action` and `x-heel-kind`
 * extensions that name what it does. Everything else in the file is
 * ignored. Pure.
 */

export const HTTP_METHODS = [
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface Operation {
  method: HttpMethod;
  /** As written in the file, e.g. `/repos/{owner}/{repo}/pulls`. */
  template: string;
  operationId?: string;
  /** From `x-heel-action`; absent means rules match on method and path only. */
  action?: string;
  /** From `x-heel-kind`. Only an explicit `read` makes a call `kind: read` (I-20). */
  kind?: "read" | "write";
}

export class OpenApiError extends Error {
  override readonly name = "OpenApiError";
}

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Parses an OpenAPI document (YAML or JSON) into its operations. */
export function parseOpenApi(text: string): Operation[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    throw new OpenApiError("the OpenAPI file isn't valid YAML or JSON");
  }
  if (typeof doc !== "object" || doc === null) throw new OpenApiError("the OpenAPI file is empty");
  const version = (doc as Record<string, unknown>)["openapi"];
  if (typeof version !== "string" || !/^3\.[01]\.\d+$/.test(version)) {
    throw new OpenApiError("heel reads OpenAPI 3.0 and 3.1 files");
  }
  const paths = (doc as Record<string, unknown>)["paths"];
  if (typeof paths !== "object" || paths === null)
    throw new OpenApiError("the OpenAPI file has no paths");
  const operations: Operation[] = [];
  for (const [template, item] of Object.entries(paths)) {
    if (!template.startsWith("/") || typeof item !== "object" || item === null) continue;
    for (const [key, op] of Object.entries(item as Record<string, unknown>)) {
      const method = key.toUpperCase();
      if (
        !(HTTP_METHODS as readonly string[]).includes(method) ||
        typeof op !== "object" ||
        op === null
      ) {
        continue;
      }
      const o = op as Record<string, unknown>;
      const action = o["x-heel-action"];
      const kind = o["x-heel-kind"];
      if (action !== undefined && (typeof action !== "string" || !ACTION.test(action))) {
        throw new OpenApiError(`${method} ${template}: x-heel-action must look like service.verb`);
      }
      if (kind !== undefined && kind !== "read" && kind !== "write") {
        throw new OpenApiError(`${method} ${template}: x-heel-kind must be read or write`);
      }
      operations.push({
        method: method as HttpMethod,
        template,
        ...(typeof o["operationId"] === "string" ? { operationId: o["operationId"] } : {}),
        ...(typeof action === "string" ? { action } : {}),
        ...(kind === "read" || kind === "write" ? { kind } : {}),
      });
    }
  }
  return operations;
}

/** Whether a template segment is one `{param}`. */
const isParam = (part: string) => /^\{[^/{}]+\}$/.test(part);

/**
 * Which segments of `path` a template matches literally, from the left, or
 * null when it doesn't match. `fold` compares literals ignoring case.
 */
function literalMask(template: string, path: string, fold: boolean): boolean[] | null {
  const parts = template.split("/").slice(1);
  const segments = path.split("/").slice(1);
  if (parts.length !== segments.length) return null;
  const mask: boolean[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const segment = segments[i] as string;
    if (isParam(part)) {
      if (segment === "") return null;
      mask.push(false);
    } else if (fold ? part.toLowerCase() === segment.toLowerCase() : part === segment) {
      mask.push(true);
    } else {
      return null;
    }
  }
  return mask;
}

/** Earlier literal segments win: `/a/b/{y}` beats `/a/{x}/c` for `/a/b/c`. */
function moreSpecific(a: boolean[], b: boolean[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] === true;
  }
  return false;
}

/**
 * The operation a request is, or null. A `{param}` matches exactly one
 * non-empty segment. When several templates match, the one whose literal
 * segments come first wins, so `/users/me` beats `/users/{id}` and the
 * choice never depends on the order of the file.
 */
export function matchOperation(
  operations: readonly Operation[],
  method: string,
  path: string,
): Operation | null {
  let best: { op: Operation; mask: boolean[] } | null = null;
  for (const op of operations) {
    if (op.method !== method) continue;
    const mask = literalMask(op.template, path, false);
    if (mask !== null && (best === null || moreSpecific(mask, best.mask))) best = { op, mask };
  }
  return best?.op ?? null;
}

/**
 * Whether a request would match a template only when case is ignored
 * (`/Tickets/42` for `/tickets/{id}`). Many servers route it the same way,
 * so it would run as an operation its rules never saw; heel refuses it.
 */
export function matchesOnlyIgnoringCase(
  operations: readonly Operation[],
  method: string,
  path: string,
): boolean {
  if (matchOperation(operations, method, path) !== null) return false;
  return operations.some(
    (op) => op.method === method && literalMask(op.template, path, true) !== null,
  );
}
