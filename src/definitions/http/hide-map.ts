import type { HideCandidate } from "../../core/hide.ts";

/**
 * `x-heel-hide` on an OpenAPI operation (D7b; spec: HTTP proxy, "Hiding on
 * an OpenAPI account"): where the email-shaped items are in the operation's
 * JSON response, and where each item keeps its `from`, `to`, `subject`,
 * `labels` and body. Paths are a small, strict JSONPath subset:
 *
 * - `$` is the root (the response for `items`, the item for the fields);
 * - `.name` and `['name']` step into an object;
 * - `[*]` takes every element of an array, `[n]` one element.
 *
 * `items` ends in `[*]` (a list of items) or is `$` (the response is one
 * item). Anything else is refused when the file is read, so a mapping that
 * can't be applied never silently hides nothing. Pure.
 */

export interface HideMapping {
  items: string;
  from?: string;
  to?: string;
  subject?: string;
  labels?: string;
  body?: string;
}

export class HideMappingError extends Error {
  override readonly name = "HideMappingError";
}

type Step = { key: string } | { index: number } | { all: true };

const FIELDS = ["from", "to", "subject", "labels", "body"] as const;

/** Parses a path into steps; throws on anything outside the subset. */
export function parsePath(path: string): Step[] {
  if (!path.startsWith("$")) throw new HideMappingError(`"${path}" must start with $`);
  const steps: Step[] = [];
  let rest = path.slice(1);
  while (rest !== "") {
    const dot = /^\.([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest);
    const quoted = /^\['([^'\\]{1,200})'\]/.exec(rest);
    const all = /^\[\*\]/.exec(rest);
    const index = /^\[(0|[1-9][0-9]{0,5})\]/.exec(rest);
    if (dot !== null) steps.push({ key: dot[1] as string });
    else if (quoted !== null) steps.push({ key: quoted[1] as string });
    else if (all !== null) steps.push({ all: true });
    else if (index !== null) steps.push({ index: Number(index[1]) });
    else throw new HideMappingError(`"${path}" isn't a path heel reads`);
    rest = rest.slice((dot ?? quoted ?? all ?? index)?.[0].length ?? rest.length);
  }
  return steps;
}

/** Checks an `x-heel-hide` value from the file and returns it typed. */
export function parseHideMapping(raw: unknown, where: string): HideMapping {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HideMappingError(`${where}: x-heel-hide must be a mapping`);
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== "items" && !(FIELDS as readonly string[]).includes(key)) {
      throw new HideMappingError(`${where}: x-heel-hide has no field "${key}"`);
    }
  }
  const mapping: Record<string, string> = {};
  for (const key of ["items", ...FIELDS]) {
    const path = value[key];
    if (path === undefined) continue;
    if (typeof path !== "string")
      throw new HideMappingError(`${where}: x-heel-hide.${key} must be a path`);
    try {
      parsePath(path);
    } catch (error) {
      throw new HideMappingError(`${where}: x-heel-hide.${key}: ${(error as Error).message}`);
    }
    mapping[key] = path;
  }
  const items = mapping["items"];
  if (items === undefined) throw new HideMappingError(`${where}: x-heel-hide needs items`);
  const steps = parsePath(items);
  if (steps.length > 0 && !("all" in (steps[steps.length - 1] as Step))) {
    throw new HideMappingError(`${where}: x-heel-hide.items must be $ or end in [*]`);
  }
  if (steps.slice(0, -1).some((s) => "all" in s)) {
    throw new HideMappingError(`${where}: x-heel-hide.items may use [*] only at the end`);
  }
  if (
    mapping["from"] === undefined &&
    mapping["to"] === undefined &&
    mapping["subject"] === undefined &&
    mapping["labels"] === undefined &&
    mapping["body"] === undefined
  ) {
    throw new HideMappingError(`${where}: x-heel-hide maps no field`);
  }
  return mapping as unknown as HideMapping;
}

/** Every value a path reaches; arrays reached by `[*]` are flattened. */
function select(root: unknown, steps: readonly Step[]): unknown[] {
  let nodes: unknown[] = [root];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const node of nodes) {
      if ("all" in step) {
        if (Array.isArray(node)) next.push(...node);
      } else if ("index" in step) {
        if (Array.isArray(node) && step.index < node.length) next.push(node[step.index]);
      } else if (typeof node === "object" && node !== null && !Array.isArray(node)) {
        if (Object.hasOwn(node, step.key)) next.push((node as Record<string, unknown>)[step.key]);
      }
    }
    nodes = next;
  }
  return nodes;
}

function strings(item: unknown, path: string | undefined): string[] {
  if (path === undefined) return [];
  return select(item, parsePath(path)).flatMap((v) =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [],
  );
}

/** One item as hiding sees it. `withBody` only when an entry uses `looks_like`. */
export function candidateOf(item: unknown, mapping: HideMapping, withBody: boolean): HideCandidate {
  const from = strings(item, mapping.from)[0] ?? null;
  const subject = strings(item, mapping.subject)[0] ?? null;
  const body = strings(item, mapping.body)[0];
  return {
    from: from?.toLowerCase() ?? null,
    to: strings(item, mapping.to).map((a) => a.toLowerCase()),
    subject,
    labels: strings(item, mapping.labels),
    // No body mapped, or none in this item: unreadable, so a looks_like entry hides it.
    ...(withBody && {
      body:
        body === undefined
          ? { body: "", bodyFormat: "text" as const, unreadable: "unparseable" as const }
          : { body, bodyFormat: "text" as const },
    }),
  };
}

export type Filtered =
  | { kind: "list"; value: unknown; hidden: number }
  /** The response is one item and it is hidden. */
  | { kind: "hidden_item" }
  /** The items path doesn't reach a list: the shape isn't what the file says. */
  | { kind: "unreadable" };

/** Removes hidden items from a response; nothing else in it changes. */
export function filterResponse(
  response: unknown,
  mapping: HideMapping,
  isHidden: (candidate: HideCandidate) => boolean,
  withBody: boolean,
): Filtered {
  const steps = parsePath(mapping.items);
  if (steps.length === 0) {
    return isHidden(candidateOf(response, mapping, withBody))
      ? { kind: "hidden_item" }
      : { kind: "list", value: response, hidden: 0 };
  }
  const parents = select(response, steps.slice(0, -1));
  if (parents.length !== 1 || !Array.isArray(parents[0])) return { kind: "unreadable" };
  const list = parents[0] as unknown[];
  const kept = list.filter((item) => !isHidden(candidateOf(item, mapping, withBody)));
  const hidden = list.length - kept.length;
  list.splice(0, list.length, ...kept);
  return { kind: "list", value: response, hidden };
}
