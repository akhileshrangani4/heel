/**
 * What an operator has to set up before a built-in account can sign in:
 * Gmail and Google Calendar need their own Google OAuth client
 * (`providers.google`), Outlook a Microsoft app registration
 * (`providers.microsoft`). Without one, the account can be added but its
 * owner has no way to sign it in, so the CLI and the Connections page say
 * what to set and where the steps are.
 */

/** heel's published docs. */
export const DOCS_URL = "https://useheel.dev/docs";

export interface SignInSetup {
  /** The provider whose client is missing, e.g. "Google". */
  label: string;
  /** The heel.yaml key that configures it. */
  configKey: string;
  /** Where the steps are. */
  docsUrl: string;
}

const GOOGLE: SignInSetup = {
  label: "Google",
  configKey: "providers.google",
  docsUrl: `${DOCS_URL}/connect#google-sign-in`,
};

const MICROSOFT: SignInSetup = {
  label: "Microsoft",
  configKey: "providers.microsoft",
  docsUrl: `${DOCS_URL}/configuration`,
};

/** Which client a provider's accounts sign in through, or null for one that doesn't sign in. */
export function signInSetupFor(provider: string): SignInSetup | null {
  if (provider === "gmail" || provider === "google-calendar") return GOOGLE;
  if (provider === "outlook") return MICROSOFT;
  return null;
}

/** Which of the operator's sign-in clients heel started with. */
export interface ConfiguredSignIns {
  google: boolean;
  microsoft: boolean;
}

/**
 * Pure: the setup still missing for a provider's accounts to sign in, or
 * null when nothing is (the client is configured, or the provider doesn't
 * sign in this way).
 */
export function missingSignInSetup(
  provider: string,
  configured: ConfiguredSignIns,
): SignInSetup | null {
  const setup = signInSetupFor(provider);
  if (setup === GOOGLE && !configured.google) return setup;
  if (setup === MICROSOFT && !configured.microsoft) return setup;
  return null;
}
