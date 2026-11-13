import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_PIPELINE_TIMEOUTS } from "../../src/gateway/pipeline/pipeline.ts";
import { UpstreamError } from "../../src/gateway/pipeline/ports.ts";
import { oneRule, type PipelineHarness, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Fail-closed rows for the upstream (spec: Fail-closed behavior): an
 * upstream error, a timeout, and a connection that drops after the request
 * went out. The upstream here is a real HTTP server on loopback, killed
 * mid-exchange; the call may have taken effect, so its items stay counted,
 * its approval is consumed, and heel never retries it by itself.
 */

const SEND = { action: "email.send", recipients: ["bob@vendor.com"] };
const ALLOW_SENDS = oneRule("{ action: email.send }");

interface Upstream {
  url: string;
  /** Requests the server received in full. */
  received: number;
  close(): Promise<void>;
}

async function startUpstream(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Upstream> {
  const upstream = { url: "", received: 0, close: async () => {} };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstream.received += 1;
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  upstream.url = `http://127.0.0.1:${port}/send`;
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  onTestFinished(() => upstream.close());
  return upstream;
}

/** Points the fake definition's execute at a real server, as a provider definition would. */
function sendOver(h: PipelineHarness, upstream: Upstream): void {
  h.provider.upstream = {
    kind: "custom",
    run: async (call, signal) => {
      const response = await fetch(upstream.url, {
        method: "POST",
        body: JSON.stringify(call.args),
        headers: { "content-type": "application/json" },
        signal,
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new UpstreamError(response.status, body);
      return body;
    },
  };
}

describe("fail closed: the upstream", () => {
  it("uses the spec's deadlines: 60 s upstream, 5 s per state lookup", () => {
    expect(DEFAULT_PIPELINE_TIMEOUTS).toEqual({ upstreamMs: 60_000, stateCheckMs: 5_000 });
  });

  it("passes an upstream error through, and the call stays counted", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "backend unavailable" }));
    });
    sendOver(h, upstream);

    const result = await h.call({ args: SEND });

    expect(result).toEqual({
      status: "upstream_error",
      upstreamStatus: 500,
      body: { error: "backend unavailable" },
    });
    expect(upstream.received).toBe(1);
    expect(h.counts()).toHaveLength(1);
    expect(h.audit().map((row) => row.kind)).toEqual(["allow"]);
  });

  it("answers upstream_outcome_unknown when the upstream dies after the request went out", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    const upstream = await startUpstream((req) => req.socket.destroy());
    sendOver(h, upstream);

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "upstream_outcome_unknown" });
    // Sent once and never retried: the send may have gone out.
    expect(upstream.received).toBe(1);
    expect(h.counts()).toHaveLength(1);
  });

  it("treats an upstream that is already down as an unknown outcome too, still counted", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    const upstream = await startUpstream((_req, res) => res.end("{}"));
    sendOver(h, upstream);
    await upstream.close();

    const result = await h.call({ args: SEND });

    // heel can't tell every refused connection from a dropped one, so it never assumes "not sent".
    expect(result).toEqual({ status: "upstream_outcome_unknown" });
    expect(h.counts()).toHaveLength(1);
  });

  it("cuts an upstream that never answers at the upstream deadline, and keeps the items counted", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS, timeouts: { upstreamMs: 100 } });
    // Holds the request open without ever answering.
    const upstream = await startUpstream(() => {});
    sendOver(h, upstream);

    const started = performance.now();
    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "upstream_outcome_unknown" });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(upstream.received).toBe(1);
    expect(h.counts()).toHaveLength(1);
  });

  it("consumes the approval of a call whose upstream died, so re-sending it asks again", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.send }", "ask") });
    const upstream = await startUpstream((req) => req.socket.destroy());
    sendOver(h, upstream);
    const asked = await h.call({ args: SEND });
    if (asked.status !== "pending") throw new Error("expected pending");
    h.approvals.set(asked.approvalId, "approved");

    const rerun = await h.call({ args: SEND });
    const again = await h.call({ args: SEND });

    expect(rerun).toEqual({ status: "upstream_outcome_unknown" });
    expect(h.approvals.get(asked.approvalId).status).toBe("executed");
    expect(again.status).toBe("pending");
    expect(upstream.received).toBe(1);
    expect(h.counts()).toHaveLength(1);
  });
});
