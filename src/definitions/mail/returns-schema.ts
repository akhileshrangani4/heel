/**
 * A built-in tool's `returns` (keys only: `{"issues": [{"number", ...}, ...],
 * "next"}`) as the JSON Schema MCP lists as its `outputSchema` (code mode
 * round 2, C5), so a client's own code mode can rely on a result's shape.
 *
 * The schema is deliberately loose: an object, its keys described, none
 * required, others allowed. A result always fits it, so a client that
 * checks results never rejects one, and heel's own answers (a denial, an
 * ask) are error results, which clients don't check against it. A `returns`
 * that doesn't start with an object, or that doesn't parse, gives no schema.
 */

type Schema = Record<string, unknown>;

/** Pure: the schema for `returns`, or null. */
export function returnsSchema(returns: string): Schema | null {
  const start = returns.indexOf("{");
  // Only a returns that is an object from the start: "GitHub's answer as it came" has none.
  if (start < 0 || returns.slice(0, start).trim().endsWith("as it came")) return null;
  const parser = new Parser(returns, start);
  try {
    const schema = parser.value();
    return schema["type"] === "object" ? schema : null;
  } catch {
    return null;
  }
}

class Parser {
  #text: string;
  #at: number;

  constructor(text: string, at: number) {
    this.#text = text;
    this.#at = at;
  }

  #skip(): void {
    while (this.#at < this.#text.length && /\s/.test(this.#text[this.#at] ?? "")) this.#at += 1;
  }

  #peek(): string {
    this.#skip();
    return this.#text[this.#at] ?? "";
  }

  #expect(char: string): void {
    if (this.#peek() !== char) throw new Error(`expected ${char} at ${this.#at}`);
    this.#at += 1;
  }

  #key(): string {
    this.#expect('"');
    const end = this.#text.indexOf('"', this.#at);
    if (end < 0) throw new Error("unterminated key");
    const key = this.#text.slice(this.#at, end);
    this.#at = end + 1;
    return key;
  }

  value(): Schema {
    const next = this.#peek();
    if (next === "{") return this.#object();
    if (next === "[") return this.#array();
    if (this.#text.startsWith("str", this.#at)) {
      this.#at += 3;
      return { type: "string" };
    }
    throw new Error(`unexpected ${next} at ${this.#at}`);
  }

  #object(): Schema {
    this.#expect("{");
    const properties: Record<string, Schema> = {};
    while (this.#peek() !== "}") {
      const key = this.#key();
      if (this.#peek() === ":") {
        this.#at += 1;
        properties[key] = this.value();
      } else {
        properties[key] = {};
      }
      if (this.#peek() === ",") this.#at += 1;
    }
    this.#expect("}");
    return { type: "object", properties };
  }

  #array(): Schema {
    this.#expect("[");
    const items = this.value();
    // `, ...` after the first item says "more of the same".
    if (this.#peek() === ",") {
      this.#at += 1;
      this.#skip();
      if (this.#text.startsWith("...", this.#at)) this.#at += 3;
    }
    this.#expect("]");
    return { type: "array", items };
  }
}
