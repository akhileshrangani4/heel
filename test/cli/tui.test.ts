import { describe, expect, it } from "vitest";
import { handleKey, INITIAL_STATE, renderTui, type TuiData } from "../../src/cli/tui.ts";

/** `heel tui` (1.12): what it draws and what each key does, without a terminal. */

const NOW = new Date("2026-11-19T12:00:00Z");

const DATA: TuiData = {
  version: "0.2.0",
  approvals: [
    {
      id: "apr_1",
      agent: "inbox-bot",
      account: "gmail-work",
      status: "pending",
      summary: "inbox-bot wants to send an email from gmail-work to bob@vendor.com",
      reason: "Bob asked for the Q4 numbers.",
      createdAt: "2026-11-19T11:48:00Z",
      expiresAt: "2026-11-20T11:48:00Z",
      url: "http://localhost:7301/approvals/apr_1",
    },
  ],
  activity: [
    {
      id: 7,
      at: "2026-11-19T11:48:00Z",
      kind: "ask",
      mode: null,
      agentId: "agt_1",
      account: "gmail-work",
      action: "email.send",
      rule: "client-sends-ask",
      reason: null,
    },
  ],
  agents: [
    {
      id: "agt_1",
      name: "inbox-bot",
      owner: "owner",
      revokedAt: null,
      tokenExpiresAt: "2026-12-01T00:00:00Z",
      hasToken: true,
    },
  ],
  accounts: [{ alias: "gmail-work", provider: "gmail", owner: "owner", status: "active" }],
  pauses: [],
  error: null,
};

const screen = (state = INITIAL_STATE, data = DATA) =>
  renderTui(data, state, { columns: 100, rows: 16 }, NOW, false);

describe("heel tui", () => {
  it("draws the header, tabs, the request in heel's words, and the keys", () => {
    const text = screen();
    expect(text.split("\n")[0]).toBe(" heel ● running  v0.2.0   1 waiting · 1 agent · 1 account");
    expect(text).toContain("1 Requests (1)");
    expect(text).toContain(
      "PENDING   inbox-bot wants to send an email from gmail-work to bob@vendor.com",
    );
    expect(text).toContain("inbox-bot · gmail-work · 12 min ago · expires in 24 h");
    expect(text).toContain("“Bob asked for the Q4 numbers.”");
    expect(text).toContain("enter open in browser");
    // Exactly the terminal's size: no line wider, no more lines.
    const lines = text.split("\n");
    expect(lines).toHaveLength(16);
    expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(100);
  });

  it("Enter opens the selected request's page; a decision needs the passkey there", () => {
    expect(handleKey(INITIAL_STATE, "return", DATA).effect).toEqual({
      kind: "open",
      url: "http://localhost:7301/approvals/apr_1",
    });
  });

  it("p asks before pausing the request's agent; only y pauses", () => {
    const asked = handleKey(INITIAL_STATE, "p", DATA);
    expect(asked.effect).toBeNull();
    expect(asked.state.confirmPause).toBe("inbox-bot");
    expect(screen(asked.state)).toContain("Pause agent inbox-bot? Its calls stop at once.");
    expect(handleKey(asked.state, "y", DATA).effect).toEqual({ kind: "pause", agent: "inbox-bot" });
    const cancelled = handleKey(asked.state, "n", DATA);
    expect(cancelled.effect).toBeNull();
    expect(cancelled.state.message).toBe("Not paused.");
  });

  it("switches tabs with numbers, keeps the selection in range, and quits on q", () => {
    const activity = handleKey(INITIAL_STATE, "2", DATA).state;
    expect(screen(activity)).toContain("ask");
    expect(screen(activity)).toContain("client-sends-ask");
    expect(handleKey(activity, "down", DATA).state.selected).toBe(0);
    expect(screen(handleKey(INITIAL_STATE, "3", DATA).state)).toContain("token expires in 12 d");
    expect(handleKey(INITIAL_STATE, "q", DATA).effect).toEqual({ kind: "quit" });
  });

  it("says when heel can't be reached, and keeps showing what it had", () => {
    const text = screen(INITIAL_STATE, {
      ...DATA,
      error: "Can't reach heel at /run/heel/admin.sock",
    });
    expect(text).toContain("● not reachable");
    expect(text).toContain("Can't reach heel at /run/heel/admin.sock");
    expect(text).toContain("inbox-bot wants to send an email");
  });

  it("colours only when asked", () => {
    expect(screen()).not.toContain("\u001b[");
    expect(renderTui(DATA, INITIAL_STATE, { columns: 100, rows: 16 }, NOW, true)).toContain(
      "\u001b[33m",
    );
  });
});
