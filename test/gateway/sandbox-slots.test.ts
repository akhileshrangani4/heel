import { describe, expect, it } from "vitest";
import { defaultTotalSandboxes, SandboxSlots } from "../../src/gateway/sandbox-slots.ts";

const GIB = 1024 * 1024 * 1024;

describe("sandbox slots", () => {
  it("holds each agent to its own limit, and everyone to the total", () => {
    const slots = new SandboxSlots({ perAgent: 2, total: 3 });
    const a1 = slots.tryAcquire("agt_a");
    const a2 = slots.tryAcquire("agt_a");
    expect([a1.ok, a2.ok]).toEqual([true, true]);
    expect(slots.tryAcquire("agt_a")).toMatchObject({ ok: false, limit: "agent" });
    expect(slots.tryAcquire("agt_b").ok).toBe(true);
    expect(slots.tryAcquire("agt_c")).toMatchObject({ ok: false, limit: "total" });
    expect(slots.inUse()).toBe(3);
    expect(slots.inUse("agt_a")).toBe(2);
  });

  it("gives a slot back once, however often it's released", () => {
    const slots = new SandboxSlots({ perAgent: 1, total: 1 });
    const first = slots.tryAcquire("agt_a");
    if (!first.ok) throw new Error("expected a slot");
    first.release();
    first.release();
    expect(slots.inUse()).toBe(0);
    const second = slots.tryAcquire("agt_a");
    expect(second.ok).toBe(true);
    // A second release of the first slot must not free the second one.
    first.release();
    expect(slots.inUse("agt_a")).toBe(1);
    expect(slots.tryAcquire("agt_b")).toMatchObject({ ok: false, limit: "total" });
  });

  it("defaults the total to one per GiB of memory less one, between 2 and 16", () => {
    expect(defaultTotalSandboxes(1 * GIB)).toBe(2);
    expect(defaultTotalSandboxes(7.7 * GIB)).toBe(6);
    expect(defaultTotalSandboxes(16 * GIB)).toBe(15);
    expect(defaultTotalSandboxes(64 * GIB)).toBe(16);
  });
});
