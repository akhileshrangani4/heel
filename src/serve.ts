import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createAdminHandler } from "./admin/handlers.ts";
import { startAdminServer } from "./admin/server.ts";
import { type HeelConfig, humanPlaneUrlProblem, type ListenAddress } from "./config/schema.ts";
import { createAgentApp } from "./gateway/app.ts";
import type { Logger } from "./log.ts";
import { type HeelDb, openStore } from "./store/db.ts";
import { ensureInstall, ensureLocalOwner } from "./store/install.ts";
import { loadMasterKey, MasterKeyError } from "./vault/key.ts";
import { Vault, VaultError } from "./vault/vault.ts";
import { createHumanApp } from "./web/app.ts";

export type PlaneState = { state: "listening"; url: string } | { state: "refused"; reason: string };

export interface RunningHeel {
  planes: {
    agent: PlaneState;
    human: PlaneState;
    admin: { state: "listening"; path: string };
  };
  /** Stops every listener, then closes the store. Safe to call more than once. */
  close(): Promise<void>;
}

export interface StartOptions {
  config: HeelConfig;
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  version: string;
  now?: () => Date;
}

type FetchCallback = Parameters<typeof getRequestListener>[0];
type Closer = () => void | Promise<void>;
type VaultOpening = { ok: true; vault: Vault } | { ok: false; reason: string };

/** Pure: the URL a TCP listener answers on, with IPv6 hosts bracketed. */
export function listenerUrl(address: Pick<AddressInfo, "address" | "family" | "port">): string {
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

/**
 * Loads the master key and proves it against the database. A missing,
 * malformed or wrong key leaves the vault closed, and the caller keeps the
 * agent plane down (spec: Fail-closed behavior). Anything else is a fault in
 * heel or the host and aborts the boot.
 */
function openVault(
  db: HeelDb,
  options: Pick<StartOptions, "config" | "env" | "log">,
  now: () => Date,
): VaultOpening {
  try {
    const key = loadMasterKey(options.env, options.config.vault.keyFile);
    const vault = Vault.open(db, key, {
      now,
      onReconnectRequired: (accountId) =>
        options.log.warn({ accountId }, "account needs reconnecting; its calls are denied"),
    });
    options.log.info({ source: key.source }, "vault open");
    return { ok: true, vault };
  } catch (error) {
    if (error instanceof MasterKeyError || error instanceof VaultError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

function listenHttp(fetch: FetchCallback, address: ListenAddress): Promise<Server> {
  const server = createServer(getRequestListener(fetch));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function boundUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("an HTTP listener has no TCP address after binding");
  }
  return listenerUrl(address);
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Drop idle keep-alive connections, or close() waits for their timeout.
    server.closeAllConnections();
  });
}

/** Runs closers newest first; every one runs even when an earlier one throws. */
async function runClosers(closers: Closer[]): Promise<void> {
  const errors: unknown[] = [];
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "heel did not shut down cleanly");
}

/**
 * `heel serve`: opens the store and vault, then binds the admin socket, the
 * human plane and the agent plane (spec: Architecture).
 *
 * The admin socket binds first, so a second heel on the same install stops
 * before it touches a TCP port. A plane that can't run safely is refused
 * while the others start: with no usable master key the agent plane stays
 * down, and a non-https public URL keeps the human plane down. A listener
 * that fails to bind aborts the whole boot.
 */
export async function startHeel(options: StartOptions): Promise<RunningHeel> {
  const { config, log, version } = options;
  const now = options.now ?? (() => new Date());
  const store = openStore(config.databasePath);
  const closers: Closer[] = [() => store.close()];

  try {
    const { orgId } = ensureInstall(store.db, now());
    // Single-user install: OIDC sign-in (D13) creates users instead.
    ensureLocalOwner(store.db, orgId, now());

    const opening = openVault(store.db, options, now);
    const vault = opening.ok ? opening.vault : null;

    const admin = await startAdminServer({
      path: config.adminSocketPath,
      handle: createAdminHandler({ db: store.db, orgId, vault, version, now }),
      log,
    });
    closers.push(() => admin.close());

    let human: PlaneState;
    const urlProblem = humanPlaneUrlProblem(config.publicUrl);
    if (urlProblem) {
      human = { state: "refused", reason: urlProblem };
      log.error({ reason: urlProblem }, "human plane refused");
    } else {
      const server = await listenHttp(createHumanApp({ log }).fetch, config.listen.human);
      closers.push(() => closeHttp(server));
      human = { state: "listening", url: boundUrl(server) };
      log.info({ url: human.url }, "human plane listening");
    }

    let agent: PlaneState;
    if (!opening.ok) {
      agent = { state: "refused", reason: `vault unavailable: ${opening.reason}` };
      log.error({ reason: agent.reason }, "agent plane refused");
    } else {
      const app = createAgentApp({ db: store.db, log });
      const server = await listenHttp(app.fetch, config.listen.agent);
      closers.push(() => closeHttp(server));
      agent = { state: "listening", url: boundUrl(server) };
      log.info({ url: agent.url }, "agent plane listening");
    }

    let closing: Promise<void> | null = null;
    return {
      planes: { agent, human, admin: { state: "listening", path: admin.path } },
      close: () => {
        closing ??= runClosers(closers);
        return closing;
      },
    };
  } catch (error) {
    try {
      await runClosers(closers);
    } catch (cleanupError) {
      log.error({ err: cleanupError }, "cleanup after a failed boot also failed");
    }
    throw error;
  }
}
