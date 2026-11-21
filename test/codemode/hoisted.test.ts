import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { hoistedDependencies } from "../../src/codemode/install.ts";

/** A POSIX-style path in this OS's separators, so the same cases hold on Windows. */
const p = (path: string) => path.split("/").join(sep);
const monty = "@pydantic/monty/index.js";

describe("the dependencies code mode mounts", () => {
  it("finds the node_modules npm hoisted them to, beside the package", () => {
    expect(
      hoistedDependencies(p("/app/node_modules/useheel"), p(`/app/node_modules/${monty}`)),
    ).toBe(p("/app/node_modules"));
  });

  it("finds pnpm's store, from the real path pnpm installs heel at", () => {
    expect(
      hoistedDependencies(
        p("/app/node_modules/.pnpm/useheel@0.1.0/node_modules/useheel"),
        p(`/app/node_modules/.pnpm/@pydantic+monty@1.6.0/node_modules/${monty}`),
      ),
    ).toBe("/app/node_modules");
  });

  it("adds nothing when they're inside the install (a checkout, the image, a global install)", () => {
    const global = p("/usr/lib/node_modules/useheel");
    expect(hoistedDependencies(global, join(global, "node_modules", monty))).toBeNull();
    expect(
      hoistedDependencies(
        p("/opt/heel"),
        p(`/opt/heel/node_modules/.pnpm/@pydantic+monty@1.6.0/node_modules/${monty}`),
      ),
    ).toBeNull();
  });

  it("adds nothing when Monty isn't under that node_modules, or can't be found", () => {
    expect(
      hoistedDependencies(p("/app/node_modules/useheel"), p(`/elsewhere/node_modules/${monty}`)),
    ).toBeNull();
    expect(hoistedDependencies(p("/app/node_modules/useheel"), null)).toBeNull();
    expect(hoistedDependencies(p("/opt/heel"), p("/somewhere/monty.js"))).toBeNull();
  });

  it("finds a workspace's node_modules when heel's folder has none above it", () => {
    expect(hoistedDependencies(p("/ws/packages/heel"), p(`/ws/node_modules/${monty}`))).toBe(
      p("/ws/node_modules"),
    );
  });

  it("treats a directory named like ..foo as inside, not above", () => {
    expect(
      hoistedDependencies(p("/opt/heel"), p(`/opt/heel/..cache/node_modules/${monty}`)),
    ).toBeNull();
  });

  it("adds nothing from this checkout", () => {
    expect(hoistedDependencies(join(import.meta.dirname, "..", ".."))).toBeNull();
  });
});
