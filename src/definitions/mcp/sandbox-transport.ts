import type { Readable, Writable } from "node:stream";
import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/client";

/**
 * MCP's stdio transport (newline-delimited JSON-RPC) over a process heel
 * started in the sandbox. The SDK's own
 * `StdioClientTransport` spawns the process itself; heel must start it under
 * bubblewrap, so this transport only speaks over the pipes it's given.
 *
 * Nothing the server writes can throw out of a stream handler: an error
 * there is uncaught and would take all of heel down with this one server.
 */

/** The largest message heel reads from a local MCP server: 10 MB, the SDK's own default. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** The parts of a sandboxed process this transport needs (`SandboxProcess` has them). */
export interface StdioProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly done: Promise<unknown>;
  kill(): void;
}

/**
 * The server wrote a message larger than heel reads. The connection is
 * dropped: the rest of that message would otherwise be read as the start of
 * the next one, so nothing more from this process is trusted.
 */
export class MessageTooLargeError extends Error {
  readonly code = "message_too_large";
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`the MCP server sent a message larger than ${maxBytes} bytes`);
    this.name = "MessageTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class SandboxStdioTransport implements Transport {
  readonly #process: StdioProcess;
  readonly #buffer: ReadBuffer;
  readonly #maxMessageBytes: number;
  readonly #onStderr: (line: string) => void;
  /** Why heel dropped the connection, if it did; stdout is ignored from then on. */
  #failure: Error | null = null;
  #closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    process: StdioProcess,
    onStderr: (line: string) => void = () => {},
    maxMessageBytes = MAX_MESSAGE_BYTES,
  ) {
    this.#process = process;
    this.#onStderr = onStderr;
    this.#maxMessageBytes = maxMessageBytes;
    this.#buffer = new ReadBuffer({ maxBufferSize: maxMessageBytes });
  }

  /** Why heel dropped the connection, or null if it didn't. */
  get failure(): Error | null {
    return this.#failure;
  }

  async start(): Promise<void> {
    const { stdin, stdout, stderr, done } = this.#process;
    if (stdin === null)
      throw new Error("the sandboxed MCP server was started without a stdin pipe");
    stdin.on("error", (error: Error) => this.#report(error));
    stdout.on("error", (error: Error) => this.#report(error));
    stderr.on("error", (error: Error) => this.#report(error));
    stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    // A server's stderr is its log; it must be drained or the server blocks once the pipe fills.
    stderr.setEncoding("utf8");
    stderr.on("data", (text: string) => {
      for (const line of text.split("\n"))
        if (line.trim() !== "") this.#onStderr(line.slice(0, 500));
    });
    done.then(
      () => this.#close(),
      () => this.#close(),
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#failure !== null) throw this.#failure;
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

  #read(chunk: Buffer): void {
    if (this.#failure !== null) return;
    try {
      this.#buffer.append(chunk);
    } catch {
      this.#fail(new MessageTooLargeError(this.#maxMessageBytes));
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#buffer.readMessage();
      } catch (error) {
        this.#report(error);
        continue;
      }
      if (message === null) break;
      try {
        this.onmessage?.(message);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  /** Drops the connection: pending requests fail now, without waiting for the process to exit. */
  #fail(error: Error): void {
    this.#failure = error;
    this.#buffer.clear();
    this.#report(error);
    this.#process.kill();
    this.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.clear();
    try {
      this.onclose?.();
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    try {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // An error handler that throws has nowhere left to report to.
    }
  }
}
