/**
 * A small local MCP server for tests, spoken over stdio. heel starts it the
 * way it starts any local server: as a plain child process in the
 * cross-platform tests, and under bubblewrap in the Linux e2e job.
 *
 * - `echo` returns its text.
 * - `token` returns the NOTES_TOKEN it was started with, so a test can show
 *   the credential arrived and that heel scrubs it from the result.
 * - `big` returns `bytes` characters of text on one line, for a response
 *   larger than heel reads.
 * - `request` fetches `url` with NOTES_TOKEN as a bearer token, through the
 *   environment's proxy, and returns the status and body.
 * - `sweep` returns everything the server can find: its environment and the
 *   files under /heel, its HOME, /tmp and its work directory.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

function sweep(dir: string, depth: number, into: Record<string, string>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory() && depth > 0) sweep(path, depth - 1, into);
      else if (stat.isFile()) into[path] = readFileSync(path, "utf8").slice(0, 1_000_000);
    } catch {
      // Unreadable; the sweep reports what it can.
    }
  }
}

async function request(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${process.env["NOTES_TOKEN"] ?? ""}` },
    });
    return `${response.status} ${await response.text()}`;
  } catch (error) {
    return `error: ${error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error)}`;
  }
}

serveStdio(() => {
  const server = new Server(
    { name: "local-notes", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "token", inputSchema: { type: "object" } },
      { name: "big", inputSchema: { type: "object", properties: { bytes: { type: "number" } } } },
      { name: "request", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
      { name: "sweep", inputSchema: { type: "object" } },
    ],
  }));
  server.setRequestHandler("tools/call", async (request_) => {
    const { name, arguments: args } = request_.params;
    let text: string;
    if (name === "token") text = `token: ${process.env["NOTES_TOKEN"] ?? "none"}`;
    else if (name === "big") text = "x".repeat(Number(args?.["bytes"] ?? 0));
    else if (name === "request") text = await request(String(args?.["url"] ?? ""));
    else if (name === "sweep") {
      const files: Record<string, string> = {};
      for (const dir of ["/heel", process.env["HOME"] ?? "/heel/home", "/tmp", process.cwd()]) {
        sweep(dir, 4, files);
      }
      text = JSON.stringify({ env: process.env, files });
    } else text = String(args?.["text"] ?? "");
    return { content: [{ type: "text", text }] };
  });
  return server;
});
