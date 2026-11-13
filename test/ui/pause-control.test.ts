import { describe, expect, it } from "vitest";
import { type PauseControlProps, pauseControl } from "../../src/web/ui/pause-control.ts";
import { ACTIVE_PAUSES, PAUSE_ACCOUNTS, PAUSE_AGENTS } from "../../src/web/ui/preview/fixtures.ts";
import { dom, text, type UiDocument } from "../helpers/dom.ts";

const RESUME = { handler: "resumePause" } as const;
const FORM = { action: "/pause", csrfToken: "tok-123" } as const;

function render(over: Partial<PauseControlProps> = {}): UiDocument {
  return dom(
    pauseControl({
      outcome: { kind: "none" },
      load: {
        ok: true,
        active: [],
        agents: PAUSE_AGENTS,
        accounts: PAUSE_ACCOUNTS,
        canPauseAll: true,
      },
      pauseForm: FORM,
      onResume: RESUME,
      ...over,
    }),
  );
}

describe("PauseControl", () => {
  it("pauses in one tap: a plain CSRF form per target, with no passkey ceremony", () => {
    const doc = render();
    const forms = [...doc.querySelectorAll("form")];
    // Global, two agents, three accounts.
    expect(forms).toHaveLength(1 + PAUSE_AGENTS.length + PAUSE_ACCOUNTS.length);
    for (const form of forms) {
      expect(form.getAttribute("method")).toBe("post");
      expect(form.getAttribute("action")).toBe("/pause");
      expect(form.querySelector("input[name=csrf]")?.getAttribute("value")).toBe("tok-123");
      expect(form.querySelector("button[type=submit]")).not.toBeNull();
      expect(form.querySelector("[data-heel-ceremony]")).toBeNull();
    }
    expect(text(doc)).toContain("No passkey is needed to stop calls.");
  });

  it("I-56: resume only starts the passkey ceremony through the onResume prop, and says so", () => {
    const doc = render({
      load: {
        ok: true,
        active: ACTIVE_PAUSES,
        agents: PAUSE_AGENTS,
        accounts: PAUSE_ACCOUNTS,
        canPauseAll: true,
      },
    });
    const resumes = [...doc.querySelectorAll("button[data-heel-ceremony]")];
    expect(resumes).toHaveLength(ACTIVE_PAUSES.length);
    for (const b of resumes) {
      expect(b.getAttribute("data-heel-ceremony")).toBe("resume");
      expect(b.getAttribute("data-heel-handler")).toBe(RESUME.handler);
      expect(b.getAttribute("type")).toBe("button");
      expect(b.closest("form")).toBeNull();
      expect(text(doc.getElementById(b.getAttribute("aria-describedby") ?? ""))).toBe(
        "Passkey required to resume.",
      );
    }
    expect([...doc.querySelectorAll("form")].map((f) => f.getAttribute("action"))).not.toContain(
      "/resume",
    );
  });

  it("does not offer to pause what is already paused", () => {
    const doc = render({
      load: {
        ok: true,
        active: ACTIVE_PAUSES,
        agents: PAUSE_AGENTS,
        accounts: PAUSE_ACCOUNTS,
        canPauseAll: true,
      },
    });
    const targets = [...doc.querySelectorAll("form input[name=target]")].map((i) =>
      i.getAttribute("value"),
    );
    expect(targets).not.toContain("inbox-bot");
    expect(targets).not.toContain("gmail-personal");
    expect(targets).toContain("ci-bot");
  });

  it("a member without global rights gets no pause-everything control", () => {
    const doc = render({
      load: { ok: true, active: [], agents: ["inbox-bot"], accounts: [], canPauseAll: false },
    });
    expect(
      [...doc.querySelectorAll("form input[name=scope]")].map((i) => i.getAttribute("value")),
    ).toEqual(["agent"]);
  });

  it.each([
    [{ kind: "paused", scope: "agent", target: "inbox-bot" }, "status", "Paused agent inbox-bot"],
    [
      { kind: "resumed", scope: "account", target: "gmail-work" },
      "status",
      "Resumed account gmail-work after your passkey check",
    ],
    [
      { kind: "resume-refused", scope: "agent", target: "inbox-bot", reason: "nope" },
      "alert",
      "agent inbox-bot is still paused",
    ],
    [
      { kind: "challenge-expired", scope: "global", target: null },
      "status",
      "took too long and expired",
    ],
  ] as const)("shows the outcome %#", (outcome, role, words) => {
    const doc = render({ outcome });
    expect(text(doc.querySelector(`[role=${role}]`))).toContain(words);
  });

  it("still offers pause-everything when pause state can't be loaded", () => {
    const doc = render({ load: { ok: false, message: "db down" } });
    expect(text(doc.querySelector("[role=alert]"))).toContain("db down");
    expect(doc.querySelector("form input[name=scope]")?.getAttribute("value")).toBe("global");
  });
});
