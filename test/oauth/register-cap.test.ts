import { describe, expect, it } from "vitest";
import { MAX_UNUSED_CLIENTS, OAuthError, registerClient } from "../../src/oauth/store.ts";
import { oauthClients } from "../../src/store/schema.ts";
import { testStore } from "../helpers/store.ts";

/**
 * With heel on the public internet (a Cloudflare tunnel, 2.7), anyone can
 * register an OAuth client. Unused ones are capped and cleared after a day.
 */
describe("registering OAuth clients", () => {
  it("caps clients nobody has used, and clears them after a day", () => {
    const t = testStore();
    const now = new Date("2026-11-22T12:00:00Z");
    const register = (at: Date) =>
      registerClient(t.db, {
        orgId: t.orgId,
        name: "scanner",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        now: at,
      });
    for (let i = 0; i < MAX_UNUSED_CLIENTS; i++) register(now);
    expect(() => register(now)).toThrow(OAuthError);
    // A day later the unused ones are gone, and registering works again.
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    register(later);
    expect(t.db.select().from(oauthClients).all()).toHaveLength(1);
  });
});
