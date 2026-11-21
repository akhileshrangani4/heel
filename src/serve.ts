import { statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { JevAdapter } from "./adapters/jev.ts";
import { createAdminHandler } from "./admin/handlers.ts";
import { startAdminServer } from "./admin/server.ts";
import { SiemSink } from "./audit/siem.ts";
import { CodemodeHost, HostedCodeWorker } from "./codemode/hosted.ts";
import { SandboxedCodeWorker } from "./codemode/sandboxed.ts";
import type { CodeWorker } from "./codemode/worker.ts";
import { rulesPaths } from "./config/rules.ts";
import { type ReloadOutcome, RulesHolder, watchRules } from "./config/rules-reload.ts";
import type { OidcConfig } from "./config/schema.ts";
import { type HeelConfig, humanPlaneUrlProblem, type ListenAddress } from "./config/schema.ts";
import { formatYamlIssue } from "./config/yaml.ts";
import { builtInGoogleClient } from "./definitions/google/builtin.ts";
import {
  GOOGLE_CLIENT_SECRET_ENV,
  type GoogleClient,
  googleRefresher,
} from "./definitions/google/oauth.ts";
import { sandboxLauncher } from "./definitions/mcp/launch.ts";
import { UpstreamPool } from "./definitions/mcp/upstream.ts";
import { UpstreamSignIns } from "./definitions/mcp/upstream-oauth.ts";
import {
  MICROSOFT_CLIENT_SECRET_ENV,
  type MicrosoftClient,
  microsoftRefresher,
} from "./definitions/microsoft/oauth.ts";
import { definitionRegistry } from "./definitions/registry.ts";
import { expiringTokens, listAgents, workRootsOf } from "./gateway/agents.ts";
import { createAgentApp } from "./gateway/app.ts";
import { runApprovalHints } from "./gateway/approval-hints.ts";
import { createMcpSurface } from "./gateway/mcp/server.ts";
import { createPipeline } from "./gateway/pipeline/pipeline.ts";
import type { ApprovalAdapter } from "./gateway/pipeline/ports.ts";
import { defaultTotalSandboxes, SandboxSlots } from "./gateway/sandbox-slots.ts";
import type { Logger } from "./log.ts";
import { defaultLooksLikeJudge, HideCounts } from "./lookslike/judge.ts";
import { logAdminAlerts } from "./notify/admin-alerts.ts";
import { Notifier } from "./notify/notifier.ts";
import { notifySetup } from "./notify/setup.ts";
import { probeSandbox, startSandboxed } from "./runner/index.ts";
import {
  credentialDeliveryWarnings,
  type ExposureFacts,
  exposureWarnings,
  type SandboxedAccount,
} from "./security/exposure.ts";
import { SqliteApprovalStore } from "./store/approvals.ts";
import { type HeelDb, openStore } from "./store/db.ts";
import { ensureInstall, ensureLocalOwner } from "./store/install.ts";
import { SqlitePauseStore } from "./store/pauses.ts";
import { OidcClient, oidcSettings } from "./teams/oidc.ts";
import { isCliProvider, listAccounts } from "./vault/connect.ts";
import { loadMasterKey, MasterKeyError } from "./vault/key.ts";
import type { RefresherLookup } from "./vault/refresh.ts";
import { loadSecret } from "./vault/secret-file.ts";
import { Vault, VaultError } from "./vault/vault.ts";
import { createHumanApp } from "./web/app.ts";
import { Passkeys, relyingPartyFor } from "./web/passkeys.ts";

export type PlaneState = { state: "listening"; url: string } | { state: "refused"; reason: string };

export interface RunningHeel {
  planes: {
    agent: PlaneState;
    human: PlaneState;
    admin: { state: "listening"; path: string };
  };
  /** The rule set in force, swapped atomically on every valid edit. */
  rules: RulesHolder;
  /** `heel serve --watch`: owner-rule and default-deny outcomes are logged, then run (I-71). */
  watch: boolean;
  /** Stops every listener, then closes the store. Safe to call more than once. */
  close(): Promise<void>;
}

export interface StartOptions {
  config: HeelConfig;
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  version: string;
  /** Global watch mode (`heel serve --watch`). */
  watch?: boolean;
  /** How long the rules watcher waits for an editor to finish writing. */
  rulesDebounceMs?: number;
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
/** heel's install directory (the repo root): mounted read-only into the code-mode worker. */
const INSTALL_DIR = fileURLToPath(new URL("..", import.meta.url));

function loadProviderClients(
  config: HeelConfig,
  env: Readonly<Record<string, string | undefined>>,
): { google: GoogleClient | null; microsoft: MicrosoftClient | null } {
  const { google, microsoft } = config.providers;
  return {
    google:
      google === null
        ? null
        : {
            clientId: google.clientId,
            clientSecret: loadSecret(env, GOOGLE_CLIENT_SECRET_ENV, google.clientSecretFile),
            redirectUri: google.redirectUri,
          },
    microsoft:
      microsoft === null
        ? null
        : {
            clientId: microsoft.clientId,
            clientSecret: loadSecret(env, MICROSOFT_CLIENT_SECRET_ENV, microsoft.clientSecretFile),
            redirectUri: microsoft.redirectUri,
            tenant: microsoft.tenant,
          },
  };
}

/** HEEL_TYPESAFE_API_KEY, or the key file, for the Jev approval adapter. */
export const TYPESAFE_API_KEY_ENV = "HEEL_TYPESAFE_API_KEY";

/**
 * The approval adapters from heel.yaml (`adapters.approval`). Like a
 * provider client, a configured adapter whose key is missing stops the boot.
 */
function loadApprovalAdapters(
  config: HeelConfig,
  env: Readonly<Record<string, string | undefined>>,
): ApprovalAdapter[] {
  return config.adapters.approval.map(
    (adapter) =>
      new JevAdapter({
        model: adapter.model,
        apiKey: loadSecret(
          env,
          TYPESAFE_API_KEY_ENV,
          adapter.apiKeyFile ?? join(config.home, "typesafe-api-key"),
        ).reveal(),
      }),
  );
}

function openVault(
  db: HeelDb,
  options: Pick<StartOptions, "config" | "env" | "log">,
  now: () => Date,
  refreshers: RefresherLookup,
): VaultOpening {
  try {
    const key = loadMasterKey(options.env, options.config.vault.keyFile);
    const vault = Vault.open(db, key, {
      now,
      refreshers,
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

/** Logs a rules load: what loaded and its warnings, or why the edit was refused. */
function logRulesOutcome(log: Logger, outcome: ReloadOutcome): void {
  if (outcome.ok) {
    const { files, warnings } = outcome.loaded;
    log.info({ files: files.map((file) => file.file) }, "rules loaded");
    if (files.length === 0) {
      log.warn(
        { code: "no_rules" },
        "no rules files, so every call is denied. Write rules in $HEEL_HOME/rules/<user>.yaml (docs/rules.md); heel loads them without a restart",
      );
    }
    for (const warning of warnings)
      log.warn({ warning: formatYamlIssue(warning) }, "rules warning");
    return;
  }
  const issues = outcome.error.issues.map(formatYamlIssue);
  if (outcome.heldOwners.length > 0) {
    log.error(
      { issues, heldOwners: outcome.heldOwners },
      "rules invalid; those owners' last valid rules keep deciding, and every other edit applied",
    );
  } else if (outcome.keptLastGood) {
    log.error({ issues }, "rules invalid; the last valid set keeps deciding");
  } else {
    log.error({ issues }, "rules invalid; every call is denied until they are fixed");
  }
}

/**
 * Loads the rules and watches them for edits. Invalid rules at boot don't
 * stop heel: every call is denied, and the human plane stays up so people
 * can fix the file and pause agents (spec: Fail-closed behavior).
 */
function startRules(
  options: Pick<StartOptions, "config" | "log" | "rulesDebounceMs">,
  closers: Closer[],
): RulesHolder {
  const { config, log } = options;
  const rules = new RulesHolder(rulesPaths(config.home));
  logRulesOutcome(log, rules.reload());
  try {
    const watcher = watchRules(rules, {
      onReload: (outcome) => logRulesOutcome(log, outcome),
      onError: (err) =>
        log.error({ err }, "rules watcher failed; edits may not load until heel restarts"),
      ...(options.rulesDebounceMs === undefined ? {} : { debounceMs: options.rulesDebounceMs }),
    });
    closers.push(() => watcher.close());
  } catch (err) {
    log.error({ err, home: config.home }, "rules hot reload unavailable; restart heel after edits");
  }
  return rules;
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

/** Accounts whose credential a sandboxed program uses, for `credentialDeliveryWarnings`. */
function sandboxedAccounts(db: HeelDb, orgId: string): SandboxedAccount[] {
  return listAccounts(db, orgId)
    .filter((account) => account.credentialDelivery !== null)
    .map((account) => ({
      alias: account.alias,
      kind: isCliProvider(account.provider) ? "cli" : "mcp",
      delivery: account.credentialDelivery,
    }));
}

/**
 * Pure: a `public_url` on this machine whose port isn't the one the approval
 * page listens on. Approval links, passkeys and sign-in callbacks would all
 * point at the wrong port. Behind a proxy or tunnel the ports differ on
 * purpose, so only loopback URLs are checked.
 */
export function publicUrlPortProblem(
  config: Pick<HeelConfig, "publicUrl" | "listen">,
): string | null {
  const url = config.publicUrl;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port === config.listen.human.port || config.listen.human.port === 0) return null;
  return (
    `public_url is ${url.origin}, but the approval page listens on port ${config.listen.human.port}, ` +
    `so approval links and passkey sign-in would go to the wrong port. Set public_url to ` +
    `http://localhost:${config.listen.human.port}, or remove it: unset, it follows listen.human`
  );
}

/** What `exposureWarnings` needs to know about this process and its home. */
function exposureFacts(config: HeelConfig): ExposureFacts {
  let homeOwnerUid: number | null = null;
  try {
    homeOwnerUid = statSync(config.home).uid;
  } catch {
    // A home that doesn't exist yet is created later, by this user.
    homeOwnerUid = process.getuid?.() ?? null;
  }
  return {
    listen: config.listen,
    home: resolve(config.home),
    uid: process.getuid?.() ?? null,
    homeOwnerUid,
    userHome: homedir(),
    container: process.env["HEEL_CONTAINER"] === "1",
  };
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

    for (const warning of [
      ...exposureWarnings(exposureFacts(config)),
      ...credentialDeliveryWarnings(sandboxedAccounts(store.db, orgId)),
    ]) {
      if (warning.level === "info") log.info({ code: warning.code }, warning.message);
      else log.warn({ code: warning.code }, warning.message);
    }
    for (const token of expiringTokens(listAgents(store.db, orgId), now())) {
      const when = token.expiresAt.toISOString().slice(0, 10);
      log.warn(
        { code: "token_expiring", agent: token.name, expiresAt: token.expiresAt.toISOString() },
        token.expiresAt.getTime() <= now().getTime()
          ? `agent "${token.name}"'s token expired on ${when}; its calls are refused. Issue a new one: heel agent rotate ${token.name}`
          : `agent "${token.name}"'s token expires on ${when}. Issue a new one before then: heel agent rotate ${token.name}`,
      );
    }

    const rules = startRules(options, closers);
    const watch = options.watch ?? false;
    if (watch) log.warn("watch mode: owner-rule and default-deny outcomes are logged, then run");

    // The operator's own OAuth clients sign built-in mail accounts in and
    // refresh their tokens: Google for Gmail (D9a-1), Microsoft for Outlook
    // (D9b). A configured client whose secret is missing stops the boot,
    // rather than letting every account of that provider lapse.
    const providerClients = loadProviderClients(config, options.env);
    // heel's own Google client (roadmap 1.14), for when heel.yaml names none.
    const builtInGoogle = builtInGoogleClient();
    const approvalAdapters = loadApprovalAdapters(config, options.env);
    const refreshers: RefresherLookup = (provider, clientId) => {
      if (provider === "gmail" || provider === "google-calendar") {
        // Tokens refresh with the client that issued them. Tokens without a
        // recorded client predate the built-in one, so they're the operator's.
        if (builtInGoogle !== null && clientId === builtInGoogle.clientId) {
          return googleRefresher(
            { fetch, now },
            { ...builtInGoogle, redirectUri: new URL("http://127.0.0.1") },
          );
        }
        const own = providerClients.google;
        if (own !== null && (clientId === undefined || clientId === own.clientId)) {
          return googleRefresher({ fetch, now }, own);
        }
        return undefined;
      }
      if (provider === "outlook" && providerClients.microsoft !== null) {
        return microsoftRefresher({ fetch, now }, providerClients.microsoft);
      }
      return undefined;
    };
    const opening = openVault(store.db, options, now, refreshers);
    const vault = opening.ok ? opening.vault : null;

    let evictLocalServer: (accountId: string) => void = () => {};
    const admin = await startAdminServer({
      path: config.adminSocketPath,
      handle: createAdminHandler({
        db: store.db,
        orgId,
        vault,
        background: options.env["HEEL_BACKGROUND"] === "1",
        version,
        publicUrl: config.publicUrl,
        home: config.home,
        now,
        // The pool exists only once the agent plane is up; until then nothing is running to stop.
        onAccountConfigured: (accountId) => evictLocalServer(accountId),
        signIns: {
          google: providerClients.google !== null || builtInGoogle !== null,
          microsoft: providerClients.microsoft !== null,
        },
      }),
      log,
    });
    closers.push(() => admin.close());

    // Sign-ins to remote MCP servers that want OAuth (D5c), shared by the
    // Connections page and the upstream pool.
    const upstreamSignIns = new UpstreamSignIns();

    // Approval notifications (D4d). The pipeline below hands each new request
    // to `notifier.approvalRequested`.
    const notify = notifySetup(config.notify, options.env);
    const notifier = new Notifier({
      db: store.db,
      orgId,
      log,
      publicUrl: config.publicUrl,
      senders: notify.senders,
      now,
    });
    notifier.start();
    closers.push(() => notifier.stop());
    log.info({ channels: [...notifier.channels] }, "notifications ready");

    // Messages hidden from agents, by reason; `uncertain` is the fail-closed
    // count (I-44). Shown on the Activity page (A5).
    const hideCounts = new HideCounts();

    const portProblem = publicUrlPortProblem(config);
    if (portProblem !== null) log.warn({ code: "public_url_port" }, portProblem);

    let human: PlaneState;
    const urlProblem = humanPlaneUrlProblem(config.publicUrl);
    if (urlProblem) {
      human = { state: "refused", reason: urlProblem };
      log.error({ reason: urlProblem }, "human plane refused");
    } else {
      const humanApp = createHumanApp({
        db: store.db,
        orgId,
        hintAdapters: approvalAdapters.map((adapter) => adapter.name),
        log,
        publicUrl: config.publicUrl,
        passkeys: new Passkeys(store.db, relyingPartyFor(config.publicUrl)),
        approvals: new SqliteApprovalStore(),
        pauses: new SqlitePauseStore(),
        rules,
        ruleFiles: { paths: rules.paths, reload: () => logRulesOutcome(log, rules.reload()) },
        vapidPublicKey: notify.vapidPublicKey,
        agentPublicUrl: config.agentPublicUrl,
        upstreamOAuth: vault === null ? null : { signIns: upstreamSignIns, vault },
        watchFallback: watch,
        providerClients,
        builtInGoogle,
        oidc: teamSignIn(config.oidc, options.env, now),
        hiddenCounts: () => hideCounts.snapshot(),
        now,
      });
      const server = await listenHttp(humanApp.fetch, config.listen.human);
      closers.push(() => closeHttp(server));
      human = { state: "listening", url: boundUrl(server) };
      log.info({ url: human.url }, "human plane listening");
    }

    let agent: PlaneState;
    if (!opening.ok) {
      agent = { state: "refused", reason: `vault unavailable: ${opening.reason}` };
      log.error({ reason: agent.reason }, "agent plane refused");
    } else {
      // The decision pipeline (D3) with the D4 stores, and the MCP surface (D5a).
      // Local (stdio) MCP servers run in the sandbox; without it their calls are denied.
      const sandbox = await probeSandbox();
      if (!sandbox.ok) {
        log.warn({ reason: sandbox.reason }, `sandbox unavailable: ${sandbox.detail}`);
      }
      const pauseStore = new SqlitePauseStore();
      // One count for code mode, `heel run` and local MCP servers: each is a sandbox.
      const slots = new SandboxSlots({
        perAgent: config.sandboxes.perAgent,
        total: config.sandboxes.total ?? defaultTotalSandboxes(),
      });
      const upstream = new UpstreamPool({
        vault: opening.vault,
        log,
        slots,
        // A pooled server's requests between calls: covered by global, owner, account or provider pauses.
        paused: (account) =>
          pauseStore.find(store.db, {
            orgId: account.orgId,
            agentId: "",
            ownerId: account.ownerId,
            account: account.alias,
            provider: account.provider,
          }) !== null,
        oauth: { db: store.db, vault: opening.vault, publicUrl: config.publicUrl, now },
        ...(sandbox.ok && {
          launchStdio: sandboxLauncher({
            host: sandbox.host,
            home: config.home,
            start: startSandboxed,
            log,
          }),
        }),
      });
      evictLocalServer = (accountId) => upstream.evict(accountId);
      closers.push(() => upstream.close());
      const looksLike = defaultLooksLikeJudge((error) =>
        log.error(
          { error },
          "looks_like model didn't load; every message a looks_like entry covers is hidden",
        ),
      );
      const definitions = definitionRegistry({
        upstream,
        gmail: { vault: opening.vault, fetch },
        outlook: { vault: opening.vault, fetch },
        googleCalendar: { vault: opening.vault, fetch },
        slack: { vault: opening.vault, fetch },
        notion: { vault: opening.vault, fetch },
        stripe: { vault: opening.vault, fetch },
        linear: { vault: opening.vault, fetch },
        http: { vault: opening.vault, fetch },
        github: { vault: opening.vault, fetch },
        // `heel run` (D8b): every command runs in the sandbox, so without it each is denied.
        cli: {
          vault: opening.vault,
          sandbox: sandbox.ok ? sandbox.host : null,
          start: startSandboxed,
          workRoots: (agentId) => workRootsOf(store.db, agentId),
          fetch,
          paused: (target) => pauseStore.find(store.db, target) !== null,
        },
      });
      const pipeline = createPipeline({
        db: store.db,
        rules,
        definitions,
        pauses: new SqlitePauseStore(),
        approvals: new SqliteApprovalStore(),
        log,
        alerts: logAdminAlerts(log),
        watch,
        now,
        onApprovalRequested: (approvalId) => {
          // Advice for the approval page: started after the agent has its
          // answer, never awaited, and it can't change the request.
          setImmediate(() => {
            void runApprovalHints(
              { db: store.db, orgId, adapters: approvalAdapters, log, now },
              approvalId,
            ).catch((error) => log.error({ error, approvalId }, "approval hints failed"));
          });
          notifier.approvalRequested(approvalId);
        },
        looksLike,
        onHidden: (reason) => hideCounts.record(reason),
      });
      // Code mode everywhere, and heel never loads Monty itself: each script in its own
      // worker under bubblewrap where that runs (D6b), otherwise on one locked-down helper
      // running Monty as WebAssembly.
      let codeWorker: () => CodeWorker;
      let closeHelper: Closer | null = null;
      if (sandbox.ok) {
        const host = sandbox.host;
        codeWorker = () => new SandboxedCodeWorker({ host, installDir: INSTALL_DIR });
      } else {
        // Making the handle starts nothing: the helper process starts on the first script.
        const helper = new CodemodeHost({ installDir: INSTALL_DIR });
        closeHelper = () => helper.close();
        codeWorker = () => new HostedCodeWorker(helper);
      }
      const mcp = createMcpSurface({
        db: store.db,
        pipeline,
        definitions,
        log,
        version,
        now,
        slots,
        // Tell the owner a proposal is waiting, the same way as a request (roadmap 2.1).
        onRuleProposal: (proposalId) => notifier.ruleProposed(proposalId),
        onAgentRequest: (requestId) => notifier.agentRequested(requestId),
        codeWorker,
      });
      closers.push(() => mcp.close());
      const app = createAgentApp({
        http: { db: store.db, pipeline, log },
        db: store.db,
        log,
        now,
        mcp,
        run: { pipeline, sandbox: sandbox.ok, slots },
        hosts: [config.listen.agent.host],
        oauth:
          config.agentPublicUrl === null
            ? null
            : { agentPublicUrl: config.agentPublicUrl, authorizationServer: config.publicUrl },
      });
      const server = await listenHttp(app.fetch, config.listen.agent);
      closers.push(() => closeHttp(server));
      // Registered last, so it runs first: a script still running gets its last step while
      // its client can still read the result, with the calls that already ran.
      if (closeHelper !== null) closers.push(closeHelper);
      agent = { state: "listening", url: boundUrl(server) };
      log.info({ url: agent.url }, "agent plane listening");
    }

    // The SIEM sink only reads the audit log on its own timer, so its state
    // never reaches a decision (spec: Fail-closed behavior).
    if (config.audit.siem) {
      const siem = new SiemSink({
        db: store.db,
        orgId,
        config: config.audit.siem,
        env: options.env,
        log,
        alerts: logAdminAlerts(log),
        now,
      });
      siem.start();
      closers.push(() => siem.close());
      log.info({ sink: config.audit.siem.url.href }, "SIEM sink started");
    }

    let closing: Promise<void> | null = null;
    return {
      planes: { agent, human, admin: { state: "listening", path: admin.path } },
      rules,
      watch,
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

/**
 * Team sign-in (D13b): the IdP client is discovered on first use, so heel
 * starts even while the IdP is unreachable; a failed discovery is retried on
 * the next sign-in. The client secret is read here, at boot, so a missing or
 * loosely permissioned secret file stops `heel serve` instead of quietly
 * signing in as a public client.
 */
function teamSignIn(
  config: OidcConfig | null,
  env: Readonly<Record<string, string | undefined>>,
  now: () => Date,
): { client: () => Promise<OidcClient>; name: string } | null {
  if (config === null) return null;
  const settings = oidcSettings(config, env);
  let client: Promise<OidcClient> | null = null;
  return {
    name: config.issuer.hostname,
    client: () => {
      client ??= OidcClient.discover(settings, { now }).catch((error: unknown) => {
        client = null;
        throw error;
      });
      return client;
    },
  };
}
