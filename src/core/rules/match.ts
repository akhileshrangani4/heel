import type { RE2JS } from "re2js";
import {
  type DomainPattern,
  domainMatches,
  domainOf,
  normalizeAddress,
  parseAddressList,
} from "./address.ts";
import { type FieldValue, MISSING } from "./facts.ts";

/**
 * The operators (spec: Rules, "How a match is decided"), compiled once at
 * load and applied to one field value per call. Pure.
 *
 * | Check         | single value               | list                        | empty list |
 * | equals        | exact                      | the set equals the set      | only []    |
 * | one_of        | in the set                 | every element in the set    | false      |
 * | any_of        | in the set                 | some element in the set     | false      |
 * | matches       | anchored RE2 match         | every element matches       | false      |
 * | any_domain_in | the address's domain       | some element's domain       | false      |
 * | all_domain_in | same as any_domain_in      | every element's domain      | false      |
 * | max           | number ≤ n                 | length ≤ n                  | true       |
 *
 * An absent field fails every check (I-18). "All" checks are false on an
 * empty list, so recipients that were never resolved can't pass vacuously.
 */

export type Scalar = string | number | boolean;

export type Check =
  /** A list operand compares as a set. */
  | { op: "equals"; value: Scalar | readonly Scalar[] }
  | { op: "one_of" | "any_of"; values: ReadonlySet<Scalar> }
  | { op: "matches"; source: string; regex: RE2JS }
  | { op: "any_domain_in" | "all_domain_in"; domains: readonly DomainPattern[] }
  | { op: "max"; n: number };

export interface Condition<F> {
  /** The key as written in the file, for messages. */
  key: string;
  field: F;
  /** The field holds email addresses: values are normalized before any check. */
  addresses: boolean;
  /**
   * ANDed. Empty when the key only carries a state check (`recipients:
   * { all_in_thread: true }`): the field must still be present.
   */
  checks: readonly Check[];
}

/**
 * `unparseable`: a value the check needs to read as an address isn't one.
 * The rule can't be decided, so the evaluator denies (spec: addresses that
 * fail to parse make the call a deny).
 */
export type Outcome = boolean | "unparseable";

/** ANDs outcomes: any false is false; otherwise any unparseable is unparseable. */
export function allOf(outcomes: Iterable<Outcome>): Outcome {
  let unparseable = false;
  for (const outcome of outcomes) {
    if (outcome === false) return false;
    if (outcome === "unparseable") unparseable = true;
  }
  return unparseable ? "unparseable" : true;
}

export function evalCondition<F>(condition: Condition<F>, raw: FieldValue): Outcome {
  if (raw.kind === "absent") return false;
  const value = condition.addresses ? normalizeAddresses(raw) : raw;
  if (value === null) return "unparseable";
  return allOf(condition.checks.map((check) => evalCheck(check, value)));
}

function normalizeAddresses(value: FieldValue): FieldValue | null {
  if (value.kind === "absent") return value;
  if (value.kind === "single") {
    const address = typeof value.value === "string" ? normalizeAddress(value.value) : null;
    return address === null ? null : { kind: "single", value: address };
  }
  const addresses: string[] = [];
  for (const element of value.values) {
    const address = typeof element === "string" ? normalizeAddress(element) : null;
    if (address === null) return null;
    addresses.push(address);
  }
  return { kind: "list", values: addresses };
}

export function evalCheck(check: Check, value: FieldValue): Outcome {
  if (value.kind === "absent") return false;
  switch (check.op) {
    case "equals":
      return equals(check.value, value);
    case "one_of": {
      const has = (v: unknown) => isScalar(v) && check.values.has(v);
      return value.kind === "single"
        ? has(value.value)
        : value.values.length > 0 && value.values.every(has);
    }
    case "any_of": {
      const has = (v: unknown) => isScalar(v) && check.values.has(v);
      return value.kind === "single" ? has(value.value) : value.values.some(has);
    }
    case "matches": {
      const test = (v: unknown) => typeof v === "string" && check.regex.matches(v);
      return value.kind === "single"
        ? test(value.value)
        : value.values.length > 0 && value.values.every(test);
    }
    case "any_domain_in":
    case "all_domain_in":
      return domainCheck(check.op, check.domains, value);
    case "max":
      return value.kind === "single"
        ? typeof value.value === "number" && value.value <= check.n
        : value.values.length <= check.n;
  }
}

function equals(operand: Scalar | readonly Scalar[], value: FieldValue): boolean {
  if (value.kind === "absent") return false;
  if (isList(operand)) {
    return value.kind === "list" && sameSet(value.values, operand);
  }
  return value.kind === "single" ? value.value === operand : sameSet(value.values, [operand]);
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isList(operand: Scalar | readonly Scalar[]): operand is readonly Scalar[] {
  return Array.isArray(operand);
}

function sameSet(values: readonly unknown[], operand: readonly Scalar[]): boolean {
  const left = new Set<unknown>(values);
  const right = new Set<unknown>(operand);
  if (left.size !== right.size) return false;
  for (const v of left) if (!right.has(v)) return false;
  return true;
}

/**
 * A single value may hold a header-style list (`a@x.com, b@y.com`); each
 * list element is read the same way. A value that isn't an address list is
 * unparseable; a list element whose path ran out (MISSING) has no domain.
 */
function domainCheck(
  op: "any_domain_in" | "all_domain_in",
  patterns: readonly DomainPattern[],
  value: Exclude<FieldValue, { kind: "absent" }>,
): Outcome {
  const elements = value.kind === "single" ? [value.value] : value.values;
  const inSet = (address: string) => patterns.some((p) => domainMatches(domainOf(address), p));
  let sawAny = false;
  let all = true;
  for (const element of elements) {
    if (element === MISSING) {
      all = false;
      continue;
    }
    const addresses = typeof element === "string" ? parseAddressList(element) : null;
    if (addresses === null) return "unparseable";
    for (const address of addresses) {
      if (inSet(address)) sawAny = true;
      else all = false;
    }
  }
  if (op === "any_domain_in") return sawAny;
  return elements.length > 0 && all;
}
