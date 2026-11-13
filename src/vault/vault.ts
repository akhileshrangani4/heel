import { randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import type { HeelDb, HeelTx } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { accounts, credentials, vaultKeys } from "../store/schema.ts";
import { KEY_BYTES, open, SealError, seal } from "./crypto.ts";
import type { MasterKey } from "./key.ts";
import { noRefreshers, type OAuthTokens, type RefresherLookup } from "./refresh.ts";
import { Secret } from "./secret.ts";

/** The master key version new credentials are sealed with. Rotation is not in v0.1. */
export const CURRENT_KEY_VERSION = 1;

/** Refresh this long before the provider's stated expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

const KEY_CHECK_PLAINTEXT = Buffer.from("heel vault key check", "utf8");

const OAuthPayloadSchema = z.strictObject({
  type: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().optional(),
  scope: z.string().optional(),
});

const StaticPayloadSchema = z.strictObject({
  type: z.literal("static"),
  /** An API key, personal access token, bot token, kubeconfig, … */
  value: z.string().min(1),
});

const CredentialPayloadSchema = z.discriminatedUnion("type", [
  OAuthPayloadSchema,
  StaticPayloadSchema,
]);

/** What `heel connect` hands the vault to store. */
export type CredentialPayload = z.output<typeof CredentialPayloadSchema>;
type OAuthPayload = z.output<typeof OAuthPayloadSchema>;

/** A decrypted credential. Every secret field is wrapped so it cannot be logged. */
export type Credential =
  | {
      type: "oauth";
      accessToken: Secret;
      refreshToken: Secret | null;
      expiresAt: Date | null;
      scope: string | null;
    }
  | { type: "static"; value: Secret };

export type VaultErrorCode =
  /** The configured master key is not the one this database was sealed with. */
  | "key_mismatch"
  /** The account has no stored credential. */
  | "no_credential"
  /** The stored credential failed to open or parse. */
  | "unreadable"
  /** Refresh failed or the grant was revoked; the owner must reconnect. */
  | "reconnect_required";

/** Messages name the account, never a credential value. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultError";
    this.code = code;
  }
}

export interface VaultOptions {
  refreshers?: RefresherLookup;
  now?: () => Date;
  refreshSkewMs?: number;
  /** Called once an account is marked `reconnect_required`, so its owner can be told (D4). */
  onReconnectRequired?: (accountId: string) => void;
}

/** Pure: the associated data that binds a credential's ciphertext to its row. */
function payloadContext(credentialId: string, accountId: string, keyVersion: number): string {
  return `heel/credential/v1\0${credentialId}\0${accountId}\0${keyVersion}`;
}

/** Pure: the associated data that binds a wrapped data key to its row. */
function dataKeyContext(credentialId: string, keyVersion: number): string {
  return `heel/data-key/v1\0${credentialId}\0${keyVersion}`;
}

function keyCheckContext(version: number): string {
  return `heel/key-check/v1\0${version}`;
}

/**
 * Pure: validates a payload without letting a validation error carry it.
 * Returns the paths of the fields that failed, never their values.
 */
function parsePayload(
  payload: unknown,
): { ok: true; payload: CredentialPayload } | { ok: false; fields: string } {
  const parsed = CredentialPayloadSchema.safeParse(payload);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
  return { ok: false, fields };
}

/** Pure: wraps a validated payload's secret fields. */
function toCredential(payload: CredentialPayload): Credential {
  if (payload.type === "static") return { type: "static", value: new Secret(payload.value) };
  return {
    type: "oauth",
    accessToken: new Secret(payload.accessToken),
    refreshToken: payload.refreshToken === undefined ? null : new Secret(payload.refreshToken),
    expiresAt: payload.expiresAt === undefined ? null : new Date(payload.expiresAt),
    scope: payload.scope ?? null,
  };
}

/** Pure: the payload to store after a refresh; keeps the old refresh token unless rotated. */
function refreshedPayload(previous: OAuthPayload, tokens: OAuthTokens): OAuthPayload {
  const refreshToken = tokens.refreshToken ?? previous.refreshToken;
  const scope = tokens.scope ?? previous.scope;
  return {
    type: "oauth",
    accessToken: tokens.accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * Envelope-encrypted credential storage (I-02). Each credential is sealed with
 * its own random data key; the data key is sealed with the master key. Both
 * seals bind the row's identity, so a ciphertext copied onto another account
 * does not open. Plaintext exists only inside a call and only as `Secret`s.
 */
export class Vault {
  readonly #db: HeelDb;
  readonly #key: Buffer;
  readonly #refreshers: RefresherLookup;
  readonly #now: () => Date;
  readonly #skewMs: number;
  readonly #onReconnectRequired: (accountId: string) => void;
  /** One refresh in flight per account; concurrent callers share it. */
  readonly #inflight = new Map<string, Promise<Secret>>();

  private constructor(db: HeelDb, key: Buffer, options: VaultOptions) {
    this.#db = db;
    this.#key = key;
    this.#refreshers = options.refreshers ?? noRefreshers;
    this.#now = options.now ?? (() => new Date());
    this.#skewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.#onReconnectRequired = options.onReconnectRequired ?? (() => {});
  }

  /**
   * Opens the vault, proving the master key is the one this database was
   * sealed with. A first open records a key check; a database that already
   * holds credentials but no key check is treated as a mismatch, because
   * accepting an unverified key would only fail later, per call.
   */
  static open(db: HeelDb, masterKey: MasterKey, options: VaultOptions = {}): Vault {
    if (masterKey.bytes.length !== KEY_BYTES) {
      throw new VaultError("key_mismatch", `the master key must be ${KEY_BYTES} bytes`);
    }
    const vault = new Vault(db, masterKey.bytes, options);
    vault.#verifyKey();
    return vault;
  }

  #verifyKey(): void {
    const context = keyCheckContext(CURRENT_KEY_VERSION);
    this.#db.transaction((tx) => {
      const row = tx
        .select({ check: vaultKeys.check })
        .from(vaultKeys)
        .where(eq(vaultKeys.version, CURRENT_KEY_VERSION))
        .get();
      if (row) {
        let opened: Buffer;
        try {
          opened = open(this.#key, row.check, context);
        } catch (error) {
          throw new VaultError(
            "key_mismatch",
            "the master key does not match the one this database was sealed with",
            { cause: error },
          );
        }
        if (!opened.equals(KEY_CHECK_PLAINTEXT)) {
          throw new VaultError("key_mismatch", "the vault key check holds an unexpected value");
        }
        return;
      }
      const stored = tx.select({ n: count() }).from(credentials).get()?.n ?? 0;
      if (stored > 0) {
        throw new VaultError(
          "key_mismatch",
          "credentials exist but the vault key check is missing; refusing to trust this key",
        );
      }
      tx.insert(vaultKeys)
        .values({
          version: CURRENT_KEY_VERSION,
          check: seal(this.#key, KEY_CHECK_PLAINTEXT, context),
          createdAt: this.#now(),
        })
        .run();
    });
  }

  /**
   * Stores (or replaces) an account's credential and marks the account
   * active: storing a fresh credential is what reconnecting means.
   */
  put(accountId: string, payload: CredentialPayload): void {
    const parsed = parsePayload(payload);
    if (!parsed.ok) throw new TypeError(`invalid credential fields: ${parsed.fields}`);
    this.#db.transaction((tx) => {
      const account = tx
        .select({ orgId: accounts.orgId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) throw new VaultError("no_credential", `account ${accountId} does not exist`);
      this.#write(tx, account.orgId, accountId, parsed.payload);
      tx.update(accounts).set({ status: "active" }).where(eq(accounts.id, accountId)).run();
    });
  }

  /** Decrypts an account's credential. */
  get(accountId: string): Credential {
    return toCredential(this.#read(accountId));
  }

  /**
   * The secret to attach to an upstream request. For OAuth credentials this
   * refreshes ahead of expiry, or unconditionally with `force` (an executor's
   * one retry after a 401). A failed refresh marks the account
   * `reconnect_required` and every later call fails closed until the owner
   * reconnects.
   */
  async accessToken(accountId: string, options: { force?: boolean } = {}): Promise<Secret> {
    const account = this.#db
      .select({ provider: accounts.provider, status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();
    if (!account) throw new VaultError("no_credential", `account ${accountId} does not exist`);
    if (account.status === "reconnect_required") {
      throw new VaultError("reconnect_required", `account ${accountId} must be reconnected`);
    }
    const payload = this.#read(accountId);
    if (payload.type === "static") return new Secret(payload.value);
    const fresh =
      payload.expiresAt === undefined || payload.expiresAt - this.#skewMs > this.#now().getTime();
    if (fresh && !options.force) return new Secret(payload.accessToken);

    const pending = this.#inflight.get(accountId);
    if (pending) return pending;
    const refresh = this.#refresh(accountId, account.provider, payload).finally(() => {
      this.#inflight.delete(accountId);
    });
    this.#inflight.set(accountId, refresh);
    return refresh;
  }

  async #refresh(accountId: string, provider: string, previous: OAuthPayload): Promise<Secret> {
    const refresher = this.#refreshers(provider);
    if (!refresher || previous.refreshToken === undefined) {
      this.#markReconnectRequired(accountId);
      throw new VaultError(
        "reconnect_required",
        `account ${accountId}'s access token expired and cannot be refreshed`,
      );
    }
    let tokens: OAuthTokens;
    try {
      tokens = await refresher({
        accountId,
        provider,
        refreshToken: new Secret(previous.refreshToken),
      });
    } catch (error) {
      this.#markReconnectRequired(accountId);
      throw new VaultError("reconnect_required", `refreshing account ${accountId} failed`, {
        cause: error,
      });
    }
    const next = parsePayload(refreshedPayload(previous, tokens));
    if (!next.ok) {
      this.#markReconnectRequired(accountId);
      throw new VaultError(
        "reconnect_required",
        `refreshing account ${accountId} returned invalid fields: ${next.fields}`,
      );
    }
    // Persist before handing out the new token: a rotated refresh token that
    // was used but never stored would strand the account.
    this.#db.transaction((tx) => {
      const account = tx
        .select({ orgId: accounts.orgId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) throw new VaultError("no_credential", `account ${accountId} does not exist`);
      this.#write(tx, account.orgId, accountId, next.payload);
    });
    return new Secret(tokens.accessToken);
  }

  #markReconnectRequired(accountId: string): void {
    this.#db
      .update(accounts)
      .set({ status: "reconnect_required" })
      .where(eq(accounts.id, accountId))
      .run();
    this.#onReconnectRequired(accountId);
  }

  #write(tx: HeelTx, orgId: string, accountId: string, payload: CredentialPayload): void {
    const existing = tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.accountId, accountId))
      .get();
    const id = existing?.id ?? newId("credential");
    const keyVersion = CURRENT_KEY_VERSION;
    const dataKey = randomBytes(KEY_BYTES);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    try {
      const values = {
        keyVersion,
        wrappedKey: seal(this.#key, dataKey, dataKeyContext(id, keyVersion)),
        ciphertext: seal(dataKey, plaintext, payloadContext(id, accountId, keyVersion)),
        expiresAt:
          payload.type === "oauth" && payload.expiresAt !== undefined
            ? new Date(payload.expiresAt)
            : null,
        updatedAt: this.#now(),
      };
      if (existing) {
        tx.update(credentials).set(values).where(eq(credentials.id, id)).run();
      } else {
        tx.insert(credentials)
          .values({ id, orgId, accountId, createdAt: values.updatedAt, ...values })
          .run();
      }
    } finally {
      dataKey.fill(0);
      plaintext.fill(0);
    }
  }

  #read(accountId: string): CredentialPayload {
    const row = this.#db
      .select()
      .from(credentials)
      .where(eq(credentials.accountId, accountId))
      .get();
    if (!row) throw new VaultError("no_credential", `account ${accountId} has no credential`);
    let dataKey: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      dataKey = open(this.#key, row.wrappedKey, dataKeyContext(row.id, row.keyVersion));
      plaintext = open(dataKey, row.ciphertext, payloadContext(row.id, accountId, row.keyVersion));
      const parsed = parsePayload(JSON.parse(plaintext.toString("utf8")));
      if (!parsed.ok) {
        throw new VaultError(
          "unreadable",
          `account ${accountId}'s credential has invalid fields: ${parsed.fields}`,
        );
      }
      return parsed.payload;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      // SealError carries no detail; a JSON SyntaxError could quote plaintext.
      throw new VaultError(
        "unreadable",
        `account ${accountId}'s credential could not be decrypted`,
        error instanceof SealError ? { cause: error } : {},
      );
    } finally {
      dataKey?.fill(0);
      plaintext?.fill(0);
    }
  }
}
