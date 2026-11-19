/**
 * Writes heel's built-in Google client (roadmap 1.14) into a release build,
 * from the HEEL_GOOGLE_CLIENT_ID and HEEL_GOOGLE_CLIENT_SECRET repository
 * secrets. They stay out of git: Google treats a desktop client's secret as
 * public, but secret scanners don't, and rotating it shouldn't need a commit.
 * A build from a checkout has no built-in client, so Gmail and Calendar then
 * need the operator's own `providers.google`.
 *
 * Release only, before `pnpm build`: `node scripts/inject-google-client.ts`.
 * It fails rather than ship a release without the client. The file to fill
 * can be named as the first argument (for its test).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file =
  process.argv[2] ?? join(import.meta.dirname, "..", "src", "definitions", "google", "builtin.ts");
const id = process.env["HEEL_GOOGLE_CLIENT_ID"] ?? "";
const secret = process.env["HEEL_GOOGLE_CLIENT_SECRET"] ?? "";

if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id) || !secret.startsWith("GOCSPX-")) {
  console.error(
    "inject-google-client: set HEEL_GOOGLE_CLIENT_ID and HEEL_GOOGLE_CLIENT_SECRET to heel's desktop client",
  );
  process.exit(1);
}
const source = readFileSync(file, "utf8");
const filled = source
  .replace('const CLIENT_ID = "";', `const CLIENT_ID = ${JSON.stringify(id)};`)
  .replace('const CLIENT_SECRET = "";', `const CLIENT_SECRET = ${JSON.stringify(secret)};`);
if (!filled.includes(JSON.stringify(id)) || !filled.includes(JSON.stringify(secret))) {
  console.error("inject-google-client: builtin.ts no longer has the empty constants to fill");
  process.exit(1);
}
writeFileSync(file, filled);
console.error("inject-google-client: heel's Google client is in this build");
