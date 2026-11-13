import { describe, expect, it } from "vitest";
import { exitStatus, parseRelayArgs, RELAY_FAILURE_EXIT } from "../../src/runner/relay.ts";

describe("parseRelayArgs", () => {
  it("reads the socket, the port and the command to run", () => {
    expect(
      parseRelayArgs([
        "--socket",
        "/heel/run/egress.sock",
        "--port",
        "3128",
        "--",
        "/usr/bin/gh",
        "pr",
        "view",
      ]),
    ).toEqual({
      socket: "/heel/run/egress.sock",
      port: 3128,
      command: ["/usr/bin/gh", "pr", "view"],
    });
  });

  it.each([
    ["no separator", ["--socket", "/s", "--port", "3128", "/usr/bin/gh"]],
    ["options out of order", ["--port", "3128", "--socket", "/s", "--", "/usr/bin/gh"]],
    ["a relative socket", ["--socket", "s", "--port", "3128", "--", "/usr/bin/gh"]],
    ["a bad port", ["--socket", "/s", "--port", "0", "--", "/usr/bin/gh"]],
    ["a port that isn't a number", ["--socket", "/s", "--port", "x", "--", "/usr/bin/gh"]],
    ["no command", ["--socket", "/s", "--port", "3128", "--"]],
    ["a command found on PATH", ["--socket", "/s", "--port", "3128", "--", "gh"]],
  ])("rejects %s", (_name, argv) => {
    expect(parseRelayArgs(argv)).toBeUndefined();
  });
});

describe("exitStatus", () => {
  it("passes an exit code through and reports a signal as 128 + n", () => {
    expect(exitStatus(3, null)).toBe(3);
    expect(exitStatus(null, "SIGKILL")).toBe(137);
    expect(exitStatus(null, null)).toBe(RELAY_FAILURE_EXIT);
  });
});
