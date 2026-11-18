import type { CallToolResult, FetchLike } from "@modelcontextprotocol/client";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import type { Logger } from "../../log.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Secret } from "../../vault/secret.ts";
import { type Vault, VaultError } from "../../vault/vault.ts";

/**
 * Connections to the MCP servers that passthrough accounts point at (spec:
 * Upstream MCP servers). heel is an ordinary MCP client of each one: it
 * re-issues every call through the SDK with the arguments the pipeline
 * decided on, never forwarding the agent's raw request.
 *
 * One client per account, connected on first use and dropped after any
 * failure so the next call reconnects. The account's stored credential, if
 * it has one, goes upstream as a bearer token; the agent's own heel token
 * never does (MCP forbids token passthrough).
 */

/** At most this many `tools/list` pages are read from one upstream. */
const MAX_TOOL_PAGES = 20;

export interface UpstreamDeps {
  /** Null when the vault is closed: accounts with a credential then can't connect. */
  vault: Vault | null;
  log: Logger;
  /** Overrides `fetch` for every upstream request; tests reach in-process servers with it. */
  fetch?: FetchLike;
}

export class UpstreamPool {
  readonly #deps: UpstreamDeps;
  readonly #clients = new Map<string, Promise<Client>>();

  constructor(deps: UpstreamDeps) {
    this.#deps = deps;
  }

  /** Every tool the upstream lists now, read fresh: the list can change between calls. */
  async listTools(account: AccountRecord, signal: AbortSignal): Promise<Tool[]> {
    return this.#use(account, async (client) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await client.listTools(cursor === undefined ? {} : { cursor }, { signal });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      return tools;
    });
  }

  async callTool(
    account: AccountRecord,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    return this.#use(
      account,
      (client) => client.callTool({ name, arguments: args }, { signal }) as Promise<CallToolResult>,
    );
  }

  /** The account's credential, or null when it was connected without one. */
  async credential(account: AccountRecord): Promise<Secret | null> {
    if (this.#deps.vault === null) return null;
    try {
      return await this.#deps.vault.accessToken(account.id);
    } catch (error) {
      if (error instanceof VaultError && error.code === "no_credential") return null;
      throw error;
    }
  }

  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(clients.map(async (client) => (await client).close()));
  }

  /** Runs `work` on the account's client; any failure drops the client so the next use reconnects. */
  async #use<T>(account: AccountRecord, work: (client: Client) => Promise<T>): Promise<T> {
    let pending = this.#clients.get(account.id);
    if (pending === undefined) {
      pending = this.#connect(account);
      this.#clients.set(account.id, pending);
    }
    try {
      return await work(await pending);
    } catch (error) {
      if (this.#clients.get(account.id) === pending) this.#clients.delete(account.id);
      void pending.then((client) => client.close()).catch(() => {});
      throw error;
    }
  }

  async #connect(account: AccountRecord): Promise<Client> {
    const url = account.settings["url"];
    if (typeof url !== "string") throw new Error(`account ${account.alias} has no upstream URL`);
    const token = await this.credential(account);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      ...(token === null
        ? {}
        : { requestInit: { headers: { authorization: `Bearer ${token.reveal()}` } } }),
      ...(this.#deps.fetch === undefined ? {} : { fetch: this.#deps.fetch }),
    });
    const client = new Client({ name: "heel", version: "0.1.0" });
    await client.connect(transport);
    this.#deps.log.info({ account: account.alias }, "connected to upstream MCP server");
    return client;
  }
}
