import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLogLine, lastLines, logFileOf } from "../../src/cli/background.ts";
import { tempDir } from "../helpers/store.ts";

/** `heel logs`: heel's JSON log as lines a person reads. */

describe("heel logs", () => {
  it("shows the time, level and message, then the other fields", () => {
    const at = new Date(2026, 10, 19, 18, 37, 36).getTime();
    const line = JSON.stringify({
      level: 40,
      time: at,
      service: "heel",
      msg: "notifications ready",
      channels: ["web_push"],
      code: "same_user_as_agents",
    });
    expect(formatLogLine(line)).toBe(
      '2026-11-19 18:37:36  WARN   notifications ready  channels=["web_push"] code=same_user_as_agents',
    );
  });

  it("leaves a line that isn't a JSON object as it is", () => {
    expect(formatLogLine("heel is running.")).toBe("heel is running.");
    expect(formatLogLine("  Approve requests:   open http://localhost:7301")).toBe(
      "  Approve requests:   open http://localhost:7301",
    );
    expect(formatLogLine("[1,2]")).toBe("[1,2]");
  });

  it("reads the last lines from the end of the log, and nothing when there is none", () => {
    const home = tempDir("heel-logs-");
    const file = logFileOf({ home });
    expect(file).toBe(join(home, "logs", "heel.log"));
    expect(lastLines(file, 5)).toEqual([]);

    const plain = join(home, "plain.log");
    writeFileSync(plain, "");
    for (let i = 1; i <= 100; i++) appendFileSync(plain, `line ${i}\n`);
    expect(lastLines(plain, 3)).toEqual(["line 98", "line 99", "line 100"]);
    expect(lastLines(plain, 0)).toEqual([]);
  });
});
