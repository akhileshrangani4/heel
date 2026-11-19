import { describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import { SEND } from "../helpers/approvals.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/** The admin methods behind `heel tui` and `heel status` (1.12). Read-only. */
describe("approvals.list and activity.list", () => {
  it("list the day's requests in heel's words, with their page, and the newest audit rows", async () => {
    const h = humanPlaneHarness({ owner: oneRule("{ action: email.send }", "ask") });
    await h.call({ args: SEND });
    const handle = createAdminHandler({
      db: h.t.db,
      orgId: h.t.orgId,
      vault: null,
      version: "test",
      publicUrl: new URL("https://heel.example.com"),
      now: () => h.clock.now,
    });

    const approvals = await handle({ method: "approvals.list" });
    expect(approvals).toMatchObject({
      ok: true,
      result: [
        {
          agent: "inbox-bot",
          account: "gmail-work",
          status: "pending",
          summary: "inbox-bot wants to send an email on gmail-work",
          url: expect.stringMatching(/^https:\/\/heel\.example\.com\/approvals\/apr_/),
        },
      ],
    });

    const activity = await handle({ method: "activity.list", params: { limit: 10 } });
    expect(activity).toMatchObject({
      ok: true,
      result: [{ kind: "ask", account: "gmail-work", action: "email.send" }],
    });
    const first = (activity as { result: { id: number }[] }).result[0];
    // A live tail: nothing after the newest row.
    expect(
      await handle({ method: "activity.list", params: { afterId: first?.id ?? 0, limit: 10 } }),
    ).toEqual({
      ok: true,
      result: [],
    });
  });
});
