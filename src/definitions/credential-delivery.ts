import { z } from "zod";

/**
 * How a sandboxed program's credential reaches it (spec: CLI runner,
 * "Credential delivery"), for local MCP servers and for CLIs other than `gh`:
 *
 * - `proxy`: the account names credential hosts. The program gets an inert
 *   placeholder, and heel's egress proxy adds the credential on the wire.
 * - `env`: the program gets the credential itself, in its environment, where
 *   anything it runs can read it. Only when the operator chose it explicitly
 *   (`--credential-delivery env`), and heel warns about it at every startup.
 * - `refused`: the account would put the credential in the environment but
 *   never chose to. That was the default before heel could keep credentials
 *   out of the sandbox; such accounts' calls are now refused, with the fix.
 *
 * Null means no credential reaches a sandbox (no credential variable, and
 * no credential hosts).
 */
export type SandboxCredentialDelivery = "proxy" | "env" | "refused";

/** What `--credential-delivery` stores. Absent in accounts stored before it existed. */
export const CredentialDeliveryChoice = z.enum(["env", "proxy"]);
export type CredentialDeliveryChoice = z.output<typeof CredentialDeliveryChoice>;

/** The settings fields that decide delivery, as local MCP servers and CLIs store them. */
export interface DeliverySettings {
  credentialEnv: string | null;
  credentialHosts: readonly string[];
  credentialDelivery: CredentialDeliveryChoice | null;
}

/** Pure: how the credential would reach the sandbox with these settings. */
export function effectiveDelivery(settings: DeliverySettings): SandboxCredentialDelivery | null {
  if (settings.credentialHosts.length > 0) return "proxy";
  if (settings.credentialEnv === null) return null;
  return settings.credentialDelivery === "env" ? "env" : "refused";
}

/** What kind of sandboxed program holds the account's credential, for messages. */
export type SandboxedKind = "mcp" | "cli";

function programOf(kind: SandboxedKind): string {
  return kind === "mcp" ? "its local MCP server" : "its CLI";
}

/** The two commands that fix a refused account, as one sentence. */
export function deliveryFix(alias: string): string {
  return (
    `name the hosts it authenticates to, and heel adds the credential on the wire: ` +
    `heel account set ${alias} --credential-host <host> --credential-auth bearer|basic|header:<Name>. ` +
    `To keep the credential in the environment anyway: heel account set ${alias} --credential-delivery env`
  );
}

/**
 * Why a call on a refused account didn't run, and the fix. The agent sees
 * it; only the operator can apply it, so it says who to ask.
 */
export function deliveryRefusedMessage(alias: string, kind: SandboxedKind): string {
  return (
    `account "${alias}" would put its credential in ${programOf(kind)}'s environment, ` +
    `where anything the program runs can read it, so heel refuses its calls. ` +
    `heel's operator can fix it: ${deliveryFix(alias)}`
  );
}

/** A sandbox spec was asked for an account whose delivery is refused; normalization should have caught it. */
export class CredentialDeliveryRefused extends Error {
  override readonly name = "CredentialDeliveryRefused";
  constructor(alias: string, kind: SandboxedKind) {
    super(deliveryRefusedMessage(alias, kind));
  }
}
