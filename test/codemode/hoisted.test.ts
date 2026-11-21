import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hoistedDependencies } from "../../src/codemode/install.ts";

const monty = "@pydantic/monty/index.js";

describe("the dependencies code mode mounts", () => {
  it("finds the node_modules npm hoisted them to, beside the package", () => {
    expect(hoistedDependencies("/app/node_modules/useheel", `/app/node_modules/${monty}`)).toBe(
      "/app/node_modules",
    );
  });

  it("finds pnpm's store, from the real path pnpm installs heel at", () => {
    expect(
      hoistedDependencies(
        "/app/node_modules/.pnpm/useheel@0.1.0/node_modules/useheel",
        `/app/node_modules/.pnpm/@pydantic+monty@1.6.0/node_modules/${monty}`,
      ),
    ).toBe("/app/node_modules");
  });

  it("adds nothing when they're inside the install (a checkout, the image, a global install)", () => {
    const global = "/usr/lib/node_modules/useheel";
    expect(hoistedDependencies(global, join(global, "node_modules", monty))).toBeNull();
    expect(
      hoistedDependencies(
        "/opt/heel",
        `/opt/heel/node_modules/.pnpm/@pydantic+monty@1.6.0/node_modules/${monty}`,
      ),
    ).toBeNull();
  });

  it("adds nothing when Monty isn't under that node_modules, or can't be found", () => {
    expect(
      hoistedDependencies("/app/node_modules/useheel", `/elsewhere/node_modules/${monty}`),
    ).toBeNull();
    expect(hoistedDependencies("/app/node_modules/useheel", null)).toBeNull();
    expect(hoistedDependencies("/opt/heel", "/somewhere/monty.js")).toBeNull();
  });

  it("treats a directory named like ..foo as inside, not above", () => {
    expect(hoistedDependencies("/opt/heel", `/opt/heel/..cache/node_modules/${monty}`)).toBeNull();
  });

  it("adds nothing from this checkout", () => {
    expect(hoistedDependencies(join(import.meta.dirname, "..", ".."))).toBeNull();
  });
});
