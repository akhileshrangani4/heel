import { describe, expect, it } from "vitest";
import { RequestConnectionInput } from "../../src/requests/connection.ts";

const request = (alias: string) => RequestConnectionInput.safeParse({ service: "github", alias });

describe("the alias an agent asks for", () => {
  it("takes up to 32 characters", () => {
    expect(request(`a${"b".repeat(31)}`).success).toBe(true);
  });

  it("refuses 33 characters, with the limit in the message", () => {
    const result = request(`a${"b".repeat(32)}`);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("1–32");
  });
});
