import { describe, expect, it } from "vitest";
import { oidcSignIn, passkeySignIn } from "../../src/web/ui/sign-in.ts";
import { dom, text } from "../helpers/dom.ts";

const SIGN_IN = { handler: "passkeySignIn" } as const;

describe("Sign-in screens", () => {
  it("OIDC starts the authorization flow by link and reminds that decisions need a passkey", () => {
    const doc = dom(
      oidcSignIn({
        providerName: "Acme SSO",
        startHref: "/auth/oidc/start",
        notice: { kind: "none" },
      }),
    );
    const link = doc.querySelector("a.btn");
    expect(link?.getAttribute("href")).toBe("/auth/oidc/start");
    expect(text(link)).toBe("Sign in with Acme SSO");
    expect(text(doc)).toContain("Every approve, deny or resume still asks for your passkey.");
  });

  it("I-56: passkey sign-in only starts the ceremony through the onSignIn prop", () => {
    const doc = dom(
      passkeySignIn({
        onSignIn: SIGN_IN,
        challengeId: "chl_1",
        enrolled: true,
        notice: { kind: "none" },
      }),
    );
    const b = doc.querySelector("button");
    expect(b?.getAttribute("type")).toBe("button");
    expect(b?.getAttribute("data-heel-ceremony")).toBe("sign-in");
    expect(b?.getAttribute("data-heel-handler")).toBe(SIGN_IN.handler);
    expect(b?.getAttribute("data-challenge-id")).toBe("chl_1");
    expect(doc.querySelector("form")).toBeNull();
  });

  it("I-58: with no passkey enrolled, enrollment is sent to the admin socket, never this page", () => {
    const doc = dom(
      passkeySignIn({
        onSignIn: SIGN_IN,
        challengeId: "chl_1",
        enrolled: false,
        notice: { kind: "none" },
      }),
    );
    expect(doc.querySelectorAll("button, form, input")).toHaveLength(0);
    expect(text(doc)).toContain("heel user enroll <user>");
  });

  it.each([
    [{ kind: "signed-out" }, "status", "You're signed out."],
    [{ kind: "session-expired" }, "status", "Your session ended."],
    [{ kind: "error", message: "IdP down" }, "alert", "IdP down"],
  ] as const)("shows the %o notice", (notice, role, words) => {
    for (const doc of [
      dom(oidcSignIn({ providerName: "Acme SSO", startHref: "/s", notice })),
      dom(passkeySignIn({ onSignIn: SIGN_IN, challengeId: "c", enrolled: true, notice })),
    ]) {
      expect(text(doc.querySelector(`[role=${role}]`))).toContain(words);
    }
  });

  it("escapes the provider name", () => {
    const doc = dom(
      oidcSignIn({ providerName: "<b>x</b>", startHref: "/s", notice: { kind: "none" } }),
    );
    expect(doc.querySelector("b")).toBeNull();
  });
});
