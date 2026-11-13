import { describe, expect, it } from "vitest";
import {
  hasCodeToken,
  isCodeToken,
  isTokenLike,
  maskDates,
  matchLooksLikePatterns,
  PATTERNS,
} from "../../src/core/lookslike/patterns.ts";
import { prepareMessage } from "../../src/core/lookslike/text.ts";
import type { LooksLikeMessage } from "../../src/core/lookslike/types.ts";
import { FAKE_TOKEN } from "./helpers.ts";

function hits(subject: string, body: string, bodyFormat: LooksLikeMessage["bodyFormat"] = "text") {
  return matchLooksLikePatterns(
    prepareMessage({ subject, from: "Example <no-reply@example.com>", body, bodyFormat }),
  );
}

describe("looks_like patterns: one positive per pattern", () => {
  // Each case is built to reach its pattern first, so the reported id is the
  // pattern under test rather than an earlier one in PATTERNS order.
  const cases: Array<{ id: string; category: string; subject: string; body: string }> = [
    {
      id: "reset_phrase",
      category: "password_reset",
      subject: "Account help",
      body: "We received a request to reset your password.",
    },
    {
      id: "reset_code",
      category: "password_reset",
      subject: "Account help",
      body: "Use recovery code 7K2P9X to continue.",
    },
    {
      id: "password_link_phrase",
      category: "password_reset",
      subject: "Account help",
      body: "Click the button below to change your password.",
    },
    {
      id: "reset_url",
      category: "password_reset",
      subject: "Account help",
      body: "Continue here: https://app.example.com/users/password/edit",
    },
    {
      id: "wicg_otc",
      category: "login_code",
      subject: "Welcome",
      body: "Thanks for joining.\n\n@app.example.com #482913",
    },
    {
      id: "login_code",
      category: "login_code",
      subject: "Welcome",
      body: "Your verification code is 482913.",
    },
    {
      id: "code_with_auth_context",
      category: "login_code",
      subject: "Welcome",
      body: "Enter this code to sign in: 482913",
    },
    {
      id: "sign_in_link_phrase",
      category: "login_code",
      subject: "Welcome",
      body: "Click the link below to sign in.\nhttps://app.example.com/welcome",
    },
    {
      id: "verify_phrase",
      category: "login_code",
      subject: "Welcome",
      body: "Please confirm your email address: https://app.example.com/welcome",
    },
    {
      id: "magic_url",
      category: "login_code",
      subject: "Welcome",
      body: "Continue: https://app.example.com/magic/abc",
    },
    {
      id: "auth_url_with_token",
      category: "login_code",
      subject: "Welcome",
      body: `Open https://app.example.com/auth/callback/${FAKE_TOKEN}`,
    },
    {
      id: "token_param_with_auth_context",
      category: "login_code",
      subject: "Welcome",
      body: `Your login is ready: https://app.example.com/go?token=${FAKE_TOKEN}`,
    },
  ];

  it("covers every pattern in PATTERNS", () => {
    expect(new Set(cases.map((c) => c.id))).toEqual(new Set(PATTERNS.map((p) => p.id)));
  });

  for (const c of cases) {
    it(`${c.id} hits ${c.category}`, () => {
      expect(hits(c.subject, c.body)).toMatchObject({ [c.category]: c.id });
    });
  }
});

describe("looks_like patterns: ordinary mail", () => {
  it("does not hit a plain note", () => {
    expect(hits("Lunch", "Lunch on Friday? Let's meet at noon by the lobby.")).toEqual({});
  });

  it("does not read the year in a date as a code", () => {
    expect(hits("Reminder", "Your verification code expired on Nov 13, 2026.")).toEqual({});
  });

  it("does not read a currency amount as a code", () => {
    expect(hits("Receipt", "Your access code purchase of $12.50 is complete.")).toEqual({});
  });

  it("ignores token links on unsubscribe pages", () => {
    const body =
      "Log in to read more of this week's issue.\n" +
      `https://news.example.com/unsubscribe?token=${FAKE_TOKEN}`;
    expect(hits("Weekly digest", body)).toEqual({});
  });

  it("needs an auth word before a bare `code` counts", () => {
    expect(hits("Release", "The code freeze starts at 482913 build.")).toEqual({});
  });
});

describe("looks_like patterns: evasion", () => {
  it("reads keywords split by zero-width characters", () => {
    expect(hits("Account help", "Reset your pass\u200bword here.")).toMatchObject({
      password_reset: "reset_phrase",
    });
  });

  it("reads full-width letters as ASCII", () => {
    expect(hits("Account help", "\uff32\uff45\uff53\uff45\uff54 your password")).toMatchObject({
      password_reset: "reset_phrase",
    });
  });

  it("reads hrefs from HTML bodies", () => {
    const html = '<p>Hello</p><a href="https://app.example.com/reset/abc">Continue</a>';
    expect(hits("Account help", html, "html")).toMatchObject({ password_reset: "reset_url" });
  });

  it("reads a code split into two digit groups", () => {
    expect(hits("Welcome", "Your verification code is 482 913.")).toMatchObject({
      login_code: "login_code",
    });
  });
});

describe("looks_like pattern helpers", () => {
  it("maskDates blanks dates and copyright years without moving indices", () => {
    const text = "Sent Nov 13, 2026 · © 2019-2026 Acme · 2026-11-13";
    const masked = maskDates(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toMatch(/20\d\d/);
    expect(maskDates("Your code is 2019")).toBe("Your code is 2019");
  });

  it.each([
    ["482913", true],
    ["2019", true],
    ["123-456", true],
    ["A1B2C3", true],
    ["QWERTZ", true],
    ["X7K-29P", true],
    ["hello", false],
    ["Friday", false],
    ["$12.50", false],
    ["ABC", false],
    ["release-2", false],
  ])("isCodeToken(%s) is %s", (token, expected) => {
    expect(isCodeToken(token)).toBe(expected);
  });

  it("hasCodeToken trims punctuation and joins split digit groups", () => {
    expect(hasCodeToken('is "482913".')).toBe(true);
    expect(hasCodeToken("is 482 913")).toBe(true);
    expect(hasCodeToken("call me at noon")).toBe(false);
  });

  it("isTokenLike wants long mixed strings, not slugs", () => {
    expect(isTokenLike(FAKE_TOKEN)).toBe(true);
    expect(isTokenLike(FAKE_TOKEN.slice(0, 15))).toBe(false);
    expect(isTokenLike("short1")).toBe(false);
    expect(isTokenLike("confirm-password-reset")).toBe(false);
  });
});
