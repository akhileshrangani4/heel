import type { Readable, Writable } from "node:stream";
import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/client";

/**
 * MCP's stdio transport (newline-delimited JSON-RPC) over a process heel
 * started in the sandbox (spec: Upstream MCP servers, N-8). The SDK's own
 * `StdioClientTransport` spawns the process itself; heel must start it under
 * bubblewrap, so this transport only speaks over the pipes it's given.
 */

/** The parts of a sandboxed process this transport needs (`SandboxProcess` has them). */
export interface StdioProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly done: Promise<unknown>;
  kill(): void;
}

export class SandboxStdioTransport implements Transport {
  readonly #process: StdioProcess;
  readonly #buffer = new ReadBuffer();
  readonly #onStderr: (line: string) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(process: StdioProcess, onStderr: (line: string) => void = () => {}) {
    this.#process = process;
    this.#onStderr = onStderr;
  }

  async start(): Promise<void> {
    const { stdin, stdout, stderr, done } = this.#process;
    if (stdin === null)
      throw new Error("the sandboxed MCP server was started without a stdin pipe");
    stdin.on("error", (error: Error) => this.onerror?.(error));
    stdout.on("data", (chunk: Buffer) => {
      this.#buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.#buffer.readMessage();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    // A server's stderr is its log; it must be drained or the server blocks once the pipe fills.
    stderr.setEncoding("utf8");
    stderr.on("data", (text: string) => {
      for (const line of text.split("\n"))
        if (line.trim() !== "") this.#onStderr(line.slice(0, 500));
    });
    void done.finally(() => {
      this.#buffer.clear();
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#process.stdin;
    if (stdin === null || stdin.destroyed) throw new Error("the sandboxed MCP server has exited");
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.#process.kill();
    await this.#process.done.catch(() => {});
  }
}
