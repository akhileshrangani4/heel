import { describe, expect, it } from "vitest";
import { type ExposureFacts, exposureWarnings } from "../../src/security/exposure.ts";

const SAFE: ExposureFacts = {
  listen: { agent: { host: "127.0.0.1", port: 7300 }, human: { host: "127.0.0.1", port: 7301 } },
  home: "/var/lib/heel",
  uid: 990,
  homeOwnerUid: 990,
  userHome: "/var/lib/heel-user",
};

const codes = (facts: ExposureFacts) => exposureWarnings(facts).map((w) => w.code);

describe("exposureWarnings", () => {
  it("says nothing for heel as its own user on loopback", () => {
    expect(codes(SAFE)).toEqual([]);
  });

  it("warns when either port listens beyond this machine", () => {
    expect(
      codes({
        ...SAFE,
        listen: { agent: { host: "0.0.0.0", port: 7300 }, human: { host: "::", port: 7301 } },
      }),
    ).toEqual(["agent_plane_exposed", "human_plane_exposed"]);
    expect(
      codes({ ...SAFE, listen: { ...SAFE.listen, agent: { host: "localhost", port: 1 } } }),
    ).toEqual([]);
  });

  it("warns when heel's files sit in the running user's own home", () => {
    expect(codes({ ...SAFE, home: "/Users/avi/.heel", userHome: "/Users/avi" })).toEqual([
      "same_user_as_agents",
    ]);
    // Not for root, another owner, or a home outside the user's own.
    expect(
      codes({ ...SAFE, uid: 0, homeOwnerUid: 0, home: "/root/.heel", userHome: "/root" }),
    ).toEqual([]);
    expect(
      codes({ ...SAFE, homeOwnerUid: 1, home: "/Users/avi/.heel", userHome: "/Users/avi" }),
    ).toEqual([]);
    expect(codes({ ...SAFE, home: "/Users/avi2/.heel", userHome: "/Users/avi" })).toEqual([]);
    expect(
      codes({ ...SAFE, uid: null, homeOwnerUid: null, home: "C:/h", userHome: "C:/" }),
    ).toEqual([]);
  });
});
