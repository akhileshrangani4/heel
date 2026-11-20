import type { CallToolResult, FetchLike } from "@modelcontextprotocol/client";
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { Logger } from "../../log.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Secret } from "../../vault/secret.ts";
import { type Vault, VaultError } from "../../vault/vault.ts";
import { type CappedFetch, cappedFetch } from "./capped-fetch.ts";
import { publicOnlyFetch } from "./public-only.ts";
import {
  MessageTooLargeError,
  SandboxStdioTransport,
  type StdioProcess,
} from "./sandbox-transport.ts";
import { type StdioUpstream, type UpstreamSettings, upstreamSettings } from "./settings.ts";
import { type UpstreamOAuthDeps, UpstreamOAuthProvider } from "./upstream-oauth.ts";

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
  /** What host names resolve to, for servers held to public hosts; DNS when absent. */
  resolveHost?: (host: string) => Promise<readonly string[]>;
  /**
   * Starts a local (stdio) MCP server in the sandbox. Absent when the host
   * can't run the sandbox: those accounts' calls are then denied.
   */
  /** Where OAuth upstreams keep their state (D5c); absent when the vault is closed. */
  oauth?: UpstreamOAuthDeps;
  launchStdio?: StdioLauncher;
  /**
   * Whether a pause covers the account (global, its owner, its alias or its
   * provider). A local server's credential is added at heel's egress proxy on
   * the server's own requests, between calls too, so the proxy asks before
   * each one. Absent: never paused.
   */
  paused?: (account: AccountRecord) => boolean;
  /**
   * The sandbox count code mode and `heel run` share. A running local server
   * is a sandbox too, so it holds a place in the count while it runs.
   */
  slots?: { holdServer(): () => void };
}

/**
 * Starts a local server. `credential` reads the account's credential afresh
 * each time it's called (an OAuth token is refreshed); null when it has none.
 */
export type StdioLauncher = (
  account: AccountRecord,
  upstream: StdioUpstream,
  credential: (() => Promise<string>) | null,
) => Promise<StdioProcess>;

interface Connection {
  client: Client;
  transport: Transport;
  /** A remote server's capped fetch, which remembers a reply it stopped reading. */
  capped?: CappedFetch;
}

export class UpstreamPool {
  readonly #deps: UpstreamDeps;
  readonly #clients = new Map<string, Promise<Connection>>();
  /** The settings each connection was started with; one whose account has changed is replaced. */
  readonly #startedWith = new WeakMap<Promise<Connection>, string>();

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
      // An OAuth upstream's tokens are refreshed by the SDK through its provider, not by the vault.
      const settings = upstreamSettings(account.settings);
      if (settings?.transport === "http" && settings.oauth) {
        const stored = this.#deps.vault.get(account.id);
        return stored.type === "oauth" ? stored.accessToken : null;
      }
      return await this.#deps.vault.accessToken(account.id);
    } catch (error) {
      if (error instanceof VaultError && error.code === "no_credential") return null;
      throw error;
    }
  }

  /** Stops the account's server, if one is running; the next call starts it again. */
  evict(accountId: string): void {
    const pending = this.#clients.get(accountId);
    if (pending === undefined) return;
    this.#clients.delete(accountId);
    void pending.then(({ client }) => client.close()).catch(() => {});
  }

  async close(): Promise<void> {
    const connections = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(connections.map(async (pending) => (await pending).client.close()));
  }

  /**
   * Runs `work` on the account's client. Any failure, or the connection
   * closing on its own, drops the client so the next use reconnects.
   */
  async #use<T>(account: AccountRecord, work: (client: Client) => Promise<T>): Promise<T> {
    let pending = this.#clients.get(account.id);
    if (
      pending !== undefined &&
      this.#startedWith.get(pending) !== JSON.stringify(account.settings)
    ) {
      // `heel account set` changed how it runs: the old process may hold what the new settings keep out.
      if (this.#clients.get(account.id) === pending) this.#clients.delete(account.id);
      void pending.then(({ client }) => client.close()).catch(() => {});
      pending = undefined;
    }
    if (pending === undefined) {
      const created = this.#connect(account, () => {
        if (this.#clients.get(account.id) === created) this.#clients.delete(account.id);
      });
      pending = created;
      this.#clients.set(account.id, pending);
      this.#startedWith.set(pending, JSON.stringify(account.settings));
    }
    try {
      return await work((await pending).client);
    } catch (error) {
      if (this.#clients.get(account.id) === pending) this.#clients.delete(account.id);
      void pending.then(({ client }) => client.close()).catch(() => {});
      throw (await this.#withheld(account, pending)) ?? error;
    }
  }

  /**
   * The error the agent gets when heel dropped the connection itself because
   * the server sent more than heel reads; null for any other failure.
   */
  async #withheld(
    account: AccountRecord,
    pending: Promise<Connection>,
  ): Promise<UpstreamError | null> {
    const failure = await pending.then(
      ({ transport, capped }) =>
        transport instanceof SandboxStdioTransport ? transport.failure : (capped?.failure ?? null),
      () => null,
    );
    if (!(failure instanceof MessageTooLargeError)) return null;
    const megabytes = Math.round(failure.maxBytes / (1024 * 1024));
    this.#deps.log.warn(
      { account: account.alias, maxBytes: failure.maxBytes },
      "upstream MCP server sent a message too large to read; stopped it, the next call starts it again",
    );
    return new UpstreamError(502, {
      error: `the MCP server answered with more than ${megabytes} MB; heel withheld the response and closed the connection, which opens again on the next call. The call may have taken effect.`,
    });
  }

  async #connect(account: AccountRecord, onClose: () => void): Promise<Connection> {
    const upstream = upstreamSettings(account.settings);
    if (upstream === null) throw new Error(`account ${account.alias} has no upstream settings`);
    const token = await this.credential(account);
    const client = new Client({ name: "heel", version: "0.1.0" });
    // A server that exits, or a connection heel drops, must not fail the next call too.
    // A local server is a sandbox: it takes a place in the shared count until it stops.
    const release =
      upstream.transport === "stdio" ? (this.#deps.slots?.holdServer() ?? (() => {})) : () => {};
    client.onclose = () => {
      release();
      onClose();
    };
    const capped =
      upstream.transport === "http" ? cappedFetch(this.#httpFetch(upstream)) : undefined;
    if (capped !== undefined) {
      capped.onExceeded = () => {
        void client.close().catch(() => {});
      };
    }
    let transport: Transport;
    try {
      transport = await this.#transport(account, upstream, token, capped);
      await client.connect(transport);
    } catch (error) {
      release();
      throw error;
    }
    this.#deps.log.info(
      { account: account.alias, transport: upstream.transport },
      "connected to upstream MCP server",
    );
    return { client, transport, ...(capped === undefined ? {} : { capped }) };
  }

  /** The fetch for a remote server: public hosts only, hop by hop, for one an agent asked for (roadmap 2.5). */
  #httpFetch(upstream: UpstreamSettings): FetchLike | undefined {
    if (upstream.transport !== "http" || !upstream.publicOnly) return this.#deps.fetch;
    return publicOnlyFetch(this.#deps.fetch ?? fetch, this.#deps.resolveHost);
  }

  async #transport(
    account: AccountRecord,
    upstream: UpstreamSettings,
    token: Secret | null,
    capped?: CappedFetch,
  ): Promise<Transport> {
    if (upstream.transport === "http") {
      // Every reply goes through the capped fetch: a remote server can't make heel read more
      // than MAX_MESSAGE_BYTES of one message, as a local one can't.
      const fetch = { fetch: (capped ?? cappedFetch(this.#httpFetch(upstream))).fetch };
      if (upstream.oauth) {
        // The SDK signs requests with the stored token and refreshes it when the server asks.
        const oauth = this.#deps.oauth;
        if (oauth === undefined)
          throw new Error("OAuth upstreams need the vault, which isn't open");
        return new StreamableHTTPClientTransport(new URL(upstream.url), {
          authProvider: new UpstreamOAuthProvider(oauth, account.id),
          ...fetch,
        });
      }
      return new StreamableHTTPClientTransport(new URL(upstream.url), {
        ...(token === null
          ? {}
          : { requestInit: { headers: { authorization: `Bearer ${token.reveal()}` } } }),
        ...fetch,
      });
    }
    const launch = this.#deps.launchStdio;
    if (launch === undefined) {
      throw new Error("local MCP servers need the sandbox, which isn't available on this host");
    }
    // Read per use, so the egress proxy injects a refreshed token and stops when it's revoked.
    const current = async (): Promise<string> => {
      if (this.#deps.paused?.(account) === true)
        throw new Error(`account ${account.alias} is paused`);
      const fresh = await this.credential(account);
      if (fresh === null) throw new Error(`account ${account.alias} has no credential`);
      return fresh.reveal();
    };
    const server = await launch(account, upstream, token === null ? null : current);
    return new SandboxStdioTransport(server, (line) =>
      this.#deps.log.info({ account: account.alias, stderr: line }, "upstream MCP server log"),
    );
  }
}
