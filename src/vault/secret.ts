import { inspect } from "node:util";

const REDACTED = "[redacted by heel]";

/**
 * A credential value that refuses to be printed. String conversion, JSON
 * serialization and `util.inspect` (which console and pino fall back to) all
 * yield a placeholder; only `reveal()` returns the value, so every place that
 * hands a credential to an upstream is greppable (I-02).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
