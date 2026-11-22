import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/definitions/github/client.ts";
import { LinearClient } from "../../src/definitions/linear/client.ts";
import { NotionClient } from "../../src/definitions/notion/client.ts";
import { SlackClient } from "../../src/definitions/slack/client.ts";
import { StripeClient } from "../../src/definitions/stripe/client.ts";
import { decisionFor } from "../../src/gateway/mcp/results.ts";
import { CredentialRejectedError, UpstreamError } from "../../src/gateway/pipeline/ports.ts";
import { oneRule, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * A key the service turns down (wrong, expired, revoked) is an answer, not
 * an unknown outcome: nothing ran. The Nov 21 setup dry run connected
 * placeholder keys, and the agent got "upstream outcome unknown" with
 * nothing in heel's log, so it guessed at whitespace and a heel bug.
 *
 * The answers below are what each service sent a bogus key on Nov 21 2026:
 * GitHub, Notion and Stripe 401; Slack 200 with ok: false and invalid_auth;
 * Linear 401 with AUTHENTICATION_ERROR.
 */

const token = async (): Promise<string> => "bad-key";
const signal = new AbortController().signal;

function answering(status: number, body: unknown) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("a rejected key", () => {
  it("is CredentialRejectedError from every key-holding client, for reads and writes", async () => {
    const github = new GitHubClient(answering(401, { message: "Bad credentials" }), token);
    await expect(github.request("GET", "/user", signal)).rejects.toThrow(CredentialRejectedError);
    await expect(github.request("POST", "/repos/a/b/issues", signal, { body: {} })).rejects.toThrow(
      CredentialRejectedError,
    );

    const notion = new NotionClient(answering(401, { code: "unauthorized" }), token);
    await expect(notion.request("GET", "/v1/users/me", signal)).rejects.toThrow(
      CredentialRejectedError,
    );

    const stripe = new StripeClient(
      answering(401, { error: { type: "invalid_request_error" } }),
      token,
    );
    await expect(stripe.request("GET", "/v1/balance", {}, signal)).rejects.toThrow(
      CredentialRejectedError,
    );

    // Slack answers 200 with ok: false.
    for (const error of ["invalid_auth", "token_revoked", "not_authed"]) {
      const slack = new SlackClient(answering(200, { ok: false, error }), token);
      await expect(slack.call("auth.test", {}, signal)).rejects.toThrow(CredentialRejectedError);
    }

    // Linear answers 401 with an authentication error in its GraphQL errors (checked
    // against the live API, Nov 21 2026); a 400 carrying the same error counts too.
    const linear401 = new LinearClient(
      answering(401, {
        errors: [
          {
            message: "Authentication required, not authenticated",
            extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR" },
          },
        ],
      }),
      token,
    );
    await expect(linear401.request("{ viewer { id } }", {}, signal)).rejects.toThrow(
      CredentialRejectedError,
    );
    const linear = new LinearClient(
      answering(400, {
        errors: [
          { message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } },
        ],
      }),
      token,
    );
    await expect(linear.request("{ viewer { id } }", {}, signal)).rejects.toThrow(
      CredentialRejectedError,
    );
  });

  it("leaves other errors as they were", async () => {
    const github = new GitHubClient(answering(403, { message: "Resource not accessible" }), token);
    const error = await github.request("GET", "/repos/a/b", signal).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(CredentialRejectedError);

    const linear = new LinearClient(answering(400, { errors: [{ message: "bad query" }] }), token);
    const other = await linear.request("{ x }", {}, signal).catch((e: unknown) => e);
    expect(other).not.toBeInstanceOf(CredentialRejectedError);
  });

  it("reaches the agent as an upstream error that names the account and what to do", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.send }") });
    h.provider.upstream = {
      kind: "custom",
      run: async () => {
        throw new CredentialRejectedError("GitHub");
      },
    };

    const result = await h.call({ args: { action: "email.send", recipients: ["bob@vendor.com"] } });

    expect(result).toMatchObject({ status: "upstream_error", upstreamStatus: 401 });
    if (result.status !== "upstream_error") throw new Error("unreachable");
    expect(result.message).toBe(
      "GitHub rejected the key heel holds for gmail-work (wrong, expired or revoked), so nothing ran. " +
        "Your owner can replace it on heel's Connections page.",
    );
    expect(decisionFor(result, { tool: "send", account: "gmail-work", native: true }).message).toBe(
      result.message,
    );

    // Any other upstream error keeps heel's generic line.
    const plain = decisionFor(
      { status: "upstream_error", upstreamStatus: 500, body: {} },
      { tool: "send", account: "gmail-work", native: true },
    );
    expect(plain.message).toBe("gmail-work answered send on gmail-work with an error.");
    expect(new CredentialRejectedError("x")).toBeInstanceOf(UpstreamError);
  });
});
