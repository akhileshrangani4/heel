import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hoistedDependencies } from "../../src/codemode/sandboxed.ts";

describe("the dependencies code mode mounts", () => {
  const install = "/app/node_modules/@akhileshrangani4/heel";

  it("finds the node_modules npm hoisted them to, above the package", () => {
    expect(hoistedDependencies(install, "/app/node_modules/@pydantic/monty/index.js")).toBe(
      "/app/node_modules",
    );
  });

  it("adds nothing when they're inside the install (a checkout, the image, a global install)", () => {
    expect(
      hoistedDependencies(install, join(install, "node_modules/@pydantic/monty/index.js")),
    ).toBeNull();
    expect(
      hoistedDependencies(
        "/opt/heel",
        "/opt/heel/node_modules/.pnpm/@pydantic+monty@1.6.0/node_modules/@pydantic/monty/index.js",
      ),
    ).toBeNull();
  });

  it("adds nothing when Monty can't be found", () => {
    expect(hoistedDependencies(install, null)).toBeNull();
    expect(hoistedDependencies(install, "/somewhere/monty.js")).toBeNull();
  });

  it("finds them from this checkout without mounting anything extra", () => {
    expect(hoistedDependencies(join(import.meta.dirname, "..", ".."))).toBeNull();
  });
});
