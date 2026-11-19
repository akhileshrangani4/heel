import { describe, expect, it } from "vitest";
import { foldsFor, isFoldName, rememberFold } from "../../src/store/folds.ts";
import { testStore } from "../helpers/store.ts";

describe("remembered folds", () => {
  it("keeps the latest state per person, kind and section", () => {
    const t = testStore();
    const at = new Date("2026-11-19T00:00:00Z");
    rememberFold(
      t.db,
      { userId: t.ownerId, kind: "email.send", section: "cc:x.com", open: true },
      at,
    );
    rememberFold(
      t.db,
      { userId: t.ownerId, kind: "email.send", section: "cc:x.com", open: false },
      at,
    );
    rememberFold(t.db, { userId: t.ownerId, kind: "email.send", section: "args", open: true }, at);
    rememberFold(
      t.db,
      { userId: t.ownerId, kind: "github.merge", section: "args", open: false },
      at,
    );

    expect(foldsFor(t.db, t.ownerId, "email.send")).toEqual(
      new Map([
        ["cc:x.com", false],
        ["args", true],
      ]),
    );
    expect(foldsFor(t.db, t.ownerId, "github.merge")).toEqual(new Map([["args", false]]));
    expect(foldsFor(t.db, t.ownerId, "slack.post")).toEqual(new Map());
  });

  it("accepts only short, plain names", () => {
    expect(isFoldName("cc:vendor.com")).toBe(true);
    expect(isFoldName("stripe:create_refund")).toBe(true);
    expect(isFoldName("")).toBe(false);
    expect(isFoldName("<script>")).toBe(false);
    expect(isFoldName("x".repeat(121))).toBe(false);
  });
});
