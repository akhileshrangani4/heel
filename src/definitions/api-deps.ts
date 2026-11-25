import type { AccountRecord } from "../store/directory.ts";
import type { Vault } from "../vault/vault.ts";
import type { FetchFn } from "./sign-in.ts";

/** What a built-in service's definition calls its API with. */
export interface ApiDeps {
  vault: Vault;
  fetch: FetchFn;
}

/** The account's credential, read from the vault for one upstream request. */
export async function accountToken(
  deps: { vault: Vault },
  account: AccountRecord,
): Promise<string> {
  return (await deps.vault.accessToken(account.id)).reveal();
}
