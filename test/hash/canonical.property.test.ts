import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CallIdentity, callHash } from "../../src/core/call-hash.ts";
import { canonicalJson } from "../../src/core/canonical.ts";

/**
 * The canonical call hash (spec: Call model, "Canonical call hash"):
 * `sha256(JCS({agentId, account, tool, args}))`. Two calls are "the same
 * call" for approvals exactly when this hash is equal.
 */

const BASE: CallIdentity = {
  agentId: "agt_inbox",
  account: "gmail-work",
  tool: "send",
  args: { to: ["bob@vendor.com"], subject: "Q3", body: { text: "hi", html: null } },
};

/** Rebuilds a JSON value with every object's keys inserted in a different order. */
function reorderKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item) => reorderKeys(item, seed));
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value);
  const shift = keys.length === 0 ? 0 : seed % keys.length;
  const order = [...keys.slice(shift), ...keys.slice(0, shift)].reverse();
  const out: Record<string, unknown> = {};
  for (const key of order) {
    // defineProperty, so a generated "__proto__" key stays an ordinary member.
    Object.defineProperty(out, key, {
      value: reorderKeys(Reflect.get(value, key), seed),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const json = fc.jsonValue({ maxDepth: 4 });
const args = fc.dictionary(fc.string({ maxLength: 8 }), json, { minKeys: 1, maxKeys: 6 });
const differentJson = (a: unknown) => json.filter((b) => canonicalJson(b) !== canonicalJson(a));

describe("canonical JSON (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 0, y: 1 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":1,"z":0}]},"b":1}',
    );
    // An astral character's lead surrogate (U+D83D) sorts before U+FB33.
    expect(canonicalJson({ "\ufb33": 1, "😀": 2, "€": 3, "1": 4, "\r": 5 })).toBe(
      // Escaped: editors normalize the literal U+FB33 to its decomposed form.
      '{"\\r":5,"1":4,"\u20ac":3,"\ud83d\ude00":2,"\ufb33":1}',
    );
  });

  it("writes numbers in their shortest ECMAScript form", () => {
    expect(canonicalJson([4.5, 4.5, 2e-3, 1e30, 1e-27, 100, -0])).toBe(
      "[4.5,4.5,0.002,1e+30,1e-27,100,0]",
    );
  });

  it("drops undefined members and writes undefined array slots as null, like JSON", () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it("refuses values JSON can't carry exactly instead of coercing them", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      new Date(0),
      new Map(),
      () => 1,
      "\ud800",
      { nested: [Symbol("x")] },
    ]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
  });

  it("reads back to the same canonical form", () => {
    fc.assert(
      fc.property(json, (value) => {
        const canonical = canonicalJson(value);
        expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
      }),
    );
  });
});

describe("call hash", () => {
  it("is the SHA-256 of the JCS envelope over agent, account, tool and args", () => {
    const envelope =
      '{"account":"gmail-work","agentId":"agt_inbox","args":{"body":{"html":null,"text":"hi"},"subject":"Q3","to":["bob@vendor.com"]},"tool":"send"}';

    expect(callHash(BASE)).toBe(createHash("sha256").update(envelope, "utf8").digest("hex"));
    expect(callHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("I-51: is stable when the keys of the arguments are reordered, at any depth", () => {
    fc.assert(
      fc.property(args, fc.nat(), (value, seed) => {
        expect(callHash({ ...BASE, args: reorderKeys(value, seed) })).toBe(
          callHash({ ...BASE, args: value }),
        );
      }),
    );
  });

  it("I-51: leaves the run id and every derived field out", () => {
    const call = {
      ...BASE,
      orgId: "org_1",
      ownerId: "usr_1",
      surface: "mcp" as const,
      provider: "gmail",
      items: 1,
    };

    expect(callHash({ ...call, runId: "run-1" } as CallIdentity)).toBe(callHash(BASE));
    expect(
      callHash({ ...call, runId: "run-2", action: "email.send", items: 3 } as CallIdentity),
    ).toBe(callHash(BASE));
  });

  it("I-51: hashes absent arguments the same as empty ones", () => {
    expect(callHash({ ...BASE, args: undefined })).toBe(callHash({ ...BASE, args: {} }));
  });

  it("I-52: changes when any one argument changes", () => {
    fc.assert(
      fc.property(
        args.chain((value) => {
          const keys = Object.keys(value);
          return fc.tuple(
            fc.constant(value),
            fc
              .constantFrom(...keys)
              .chain((key) => fc.tuple(fc.constant(key), differentJson(value[key]))),
          );
        }),
        ([value, [key, replacement]]) => {
          expect(callHash({ ...BASE, args: { ...value, [key]: replacement } })).not.toBe(
            callHash({ ...BASE, args: value }),
          );
        },
      ),
    );
  });

  it("I-52: changes when an argument is added or removed", () => {
    fc.assert(
      fc.property(args, fc.string({ maxLength: 8 }), json, (value, key, extra) => {
        fc.pre(!Object.hasOwn(value, key));
        const before = callHash({ ...BASE, args: value });
        expect(callHash({ ...BASE, args: { ...value, [key]: extra } })).not.toBe(before);
        const [first] = Object.keys(value);
        if (first === undefined) return;
        const { [first]: _dropped, ...fewer } = value;
        expect(callHash({ ...BASE, args: fewer })).not.toBe(before);
      }),
    );
  });

  it("I-52: changes with a nested value, an array's order, or a value's type", () => {
    const hashOf = (value: unknown) => callHash({ ...BASE, args: value });
    const base = hashOf({ to: ["a@x.com", "b@x.com"], n: 1, opts: { cc: [] } });

    for (const changed of [
      { to: ["b@x.com", "a@x.com"], n: 1, opts: { cc: [] } },
      { to: ["a@x.com", "b@x.com"], n: "1", opts: { cc: [] } },
      { to: ["a@x.com", "b@x.com"], n: 1, opts: { cc: [null] } },
      { to: ["a@x.com", "b@x.com"], n: 1, opts: { cc: {} } },
      { to: ["A@x.com", "b@x.com"], n: 1, opts: { cc: [] } },
    ]) {
      expect(hashOf(changed)).not.toBe(base);
    }
  });

  it("I-52: changes with the agent, the account or the tool", () => {
    const hashes = [
      BASE,
      { ...BASE, agentId: "agt_ci" },
      { ...BASE, account: "gmail-personal" },
      { ...BASE, tool: "reply" },
    ].map(callHash);

    expect(new Set(hashes).size).toBe(4);
  });

  it("I-52: equal canonical arguments, and only those, give equal hashes", () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        const same = canonicalJson(a) === canonicalJson(b);
        expect(callHash({ ...BASE, args: a }) === callHash({ ...BASE, args: b })).toBe(same);
      }),
    );
  });
});
