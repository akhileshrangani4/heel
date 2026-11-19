import { describe, expect, it } from "vitest";
import { type ExposureFacts, exposureWarnings } from "../../src/security/exposure.ts";

const SAFE: ExposureFacts = {
  listen: { agent: { host: "127.0.0.1", port: 7300 }, human: { host: "127.0.0.1", port: 7301 } },
  home: "/var/lib/heel",
  uid: 990,
  homeOwnerUid: 990,
  userHome: "/var/lib/heel-user",
  container: false,
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
    // The OCI image: the heel user's home is HEEL_HOME itself.
    expect(codes({ ...SAFE, home: "/var/lib/heel", userHome: "/var/lib/heel" })).toEqual([]);
    expect(
      codes({ ...SAFE, uid: null, homeOwnerUid: null, home: "C:/h", userHome: "C:/" }),
    ).toEqual([]);
  });

  it("in heel's image, 0.0.0.0 gives one reminder about -p instead of two warnings", () => {
    const wildcard = {
      agent: { host: "0.0.0.0", port: 7300 },
      human: { host: "0.0.0.0", port: 7301 },
    };
    const warnings = exposureWarnings({ ...SAFE, container: true, listen: wildcard });
    expect(warnings.map((w) => [w.code, w.level])).toEqual([["container_ports", "info"]]);
    expect(warnings[0]?.message).toContain("-p 127.0.0.1:7300:7300");
    // A named address in a container still warns: that isn't the image's bind.
    expect(
      codes({
        ...SAFE,
        container: true,
        listen: { agent: { host: "10.0.0.5", port: 7300 }, human: SAFE.listen.human },
      }),
    ).toEqual(["agent_plane_exposed"]);
    // Loopback in a container says nothing.
    expect(codes({ ...SAFE, container: true })).toEqual([]);
  });
});
