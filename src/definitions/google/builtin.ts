import { Secret } from "../../vault/secret.ts";

/**
 * heel's own Google OAuth client (roadmap 1.14): a "Desktop app" client in
 * heel's Google Cloud project, so Gmail and Google Calendar sign in with no
 * setup. Google treats a desktop client's secret as public (installed apps
 * can't keep one), and PKCE protects every sign-in, so both values ship in
 * the package. It sends people back to a loopback address on heel's own
 * host (see web/loopback.ts), never to `public_url`.
 *
 * Empty until heel's project is set up: then heel needs the operator's own
 * client, as before. An operator's `providers.google` always wins.
 */
const CLIENT_ID = "";
const CLIENT_SECRET = "";

export interface BuiltInGoogleClient {
  clientId: string;
  clientSecret: Secret;
}

/** heel's built-in Google client, or null where this build has none. */
export function builtInGoogleClient(
  values: { clientId: string; clientSecret: string } = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  },
): BuiltInGoogleClient | null {
  if (values.clientId === "" || values.clientSecret === "") return null;
  return { clientId: values.clientId, clientSecret: new Secret(values.clientSecret) };
}
