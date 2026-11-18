/**
 * A small local MCP server for tests, spoken over stdio. heel starts it the
 * way it starts any local server: as a plain child process in the
 * cross-platform tests, and under bubblewrap in the Linux e2e job.
 *
 * - `echo` returns its text.
 * - `token` returns the NOTES_TOKEN it was started with, so a test can show
 *   the credential arrived and that heel scrubs it from the result.
 */
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
  const server = new Server(
    { name: "local-notes", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "token", inputSchema: { type: "object" } },
    ],
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const text =
      request.params.name === "token"
        ? `token: ${process.env["NOTES_TOKEN"] ?? "none"}`
        : String(request.params.arguments?.["text"] ?? "");
    return { content: [{ type: "text", text }] };
  });
  return server;
});
