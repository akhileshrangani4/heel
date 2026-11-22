import { describe, expect, it } from "vitest";
import type { Call } from "../../src/core/call.ts";
import { type DecidedCall, summarizeDecisions } from "../../src/core/learning.ts";

const NOW = new Date("2026-11-22T12:00:00Z");

function decided(at: string, decision: "approved" | "denied", call: Partial<Call>): DecidedCall {
  return {
    agentName: "claude-code",
    decision,
    at: new Date(at),
    askedBy: null,
    call: {
      orgId: "org",
      agentId: "agt",
      ownerId: "usr",
      surface: "mcp",
      account: "gmail",
      provider: "gmail",
      tool: "send_email",
      args: { body: "private words" },
      items: 1,
      ...call,
    },
  };
}

describe("summarizing an agent's decided requests (2.10)", () => {
  it("groups by account, action and shape, counts decisions and days, and leaves contents out", () => {
    const send = { action: "email.send", recipients: ["a@work.com", "b@Work.com"] };
    const groups = summarizeDecisions(
      [
        decided("2026-11-20T10:00:00Z", "approved", send),
        decided("2026-11-21T10:00:00Z", "approved", { ...send, recipients: ["c@corp.io"] }),
        decided("2026-11-21T11:00:00Z", "denied", send),
        decided("2026-11-21T12:00:00Z", "approved", {
          account: "github",
          provider: "github",
          tool: "create_issue",
          action: "github.issue.create",
          repo: "acme/web",
        }),
        // Older than 30 days: forgotten.
        decided("2026-10-01T10:00:00Z", "approved", send),
      ],
      NOW,
    );
    expect(groups).toEqual([
      {
        account: "gmail",
        action: "email.send",
        recipient_domains: ["corp.io", "work.com"],
        approved: 2,
        denied: 1,
        days: 2,
        last_decided: "2026-11-21T11:00:00.000Z",
      },
      {
        account: "github",
        action: "github.issue.create",
        repo: "acme/web",
        approved: 1,
        denied: 0,
        days: 1,
        last_decided: "2026-11-21T12:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(groups)).not.toContain("private words");
  });
});
