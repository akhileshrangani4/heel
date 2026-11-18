import { createHash } from "node:crypto";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) for the JSON values heel hashes:
 * rule content (standing approvals bind to it) and, from D3, the canonical
 * call hash. Object keys are sorted by UTF-16 code units and numbers use the
 * ECMAScript serialization, which is what `JSON.stringify` already produces
 * for finite numbers and strings.
 *
 * Anything JSON can't represent exactly (undefined at the top, NaN, bigint,
 * functions, class instances, lone surrogates) throws instead of being
 * coerced, so two different values can never share a hash by accident.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`JCS has no form for ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new TypeError("JCS strings must be well-formed Unicode");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((key) => Reflect.get(value, key) !== undefined)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(Reflect.get(value, key))}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`JCS cannot canonicalize a value of type ${typeof value}`);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Lower-case hex SHA-256 of a value's canonical JSON. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
