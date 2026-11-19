/**
 * Which MCP client an agent is using, as the client names itself in
 * `initialize` (`clientInfo.name`, e.g. "claude-code"). Self-reported, so the
 * approval page shows it as a label and nothing ever decides on it.
 */

/** Names longer than this, or with other characters, are not recorded. */
const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._@/()+-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure: the client name an `initialize` request (or a batch holding one) carries, or null. */
export function clientNameFrom(body: unknown): string | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!isRecord(message) || message["method"] !== "initialize") continue;
    const params = message["params"];
    const info = isRecord(params) ? params["clientInfo"] : undefined;
    const name = isRecord(info) ? info["name"] : undefined;
    if (typeof name === "string" && CLIENT_NAME.test(name.trim())) return name.trim();
  }
  return null;
}
