import {
  KEY_HINTS,
  needsKey,
  REQUESTABLE_SERVICES,
  serviceLabel,
} from "../../requests/connection.ts";

/**
 * The services the connect dialog offers. The list comes from the services
 * heel can connect (`REQUESTABLE_SERVICES`, the same list agents may ask
 * for), so a service added there shows up here with no change to the page.
 * The extras below only make a row nicer (a short help line, where to get a
 * key, words to find it by); a service without any still appears, named by
 * `serviceLabel`. heel's definitions carry no category, so there are no group
 * headers beyond Other.
 */

export interface ServiceChoice {
  /** The `service` the connect ceremony sends. */
  value: string;
  name: string;
  /** What step 2 asks for: a key, a sign-in after, a server URL, or a command on heel's host. */
  need: "key" | "signin" | "mcp" | "cli";
  /** The name it gets unless you change it. */
  alias: string;
  /** One short line under the key field. */
  help?: string;
  /** Where to get the key; only pages we're sure of. */
  keyPage?: string;
  /** Other words to find it by ("mail" finds Gmail). */
  terms?: string;
}

interface Extras {
  alias?: string;
  help?: string;
  keyPage?: string;
  terms?: string;
}

const EXTRAS: Readonly<Record<string, Extras>> = {
  github: {
    help: "A fine-grained personal access token",
    keyPage: "https://github.com/settings/personal-access-tokens/new",
    terms: "code git repo pull request issues",
  },
  gmail: { terms: "mail email google inbox" },
  "google-calendar": { alias: "calendar", terms: "calendar events meetings google" },
  outlook: { terms: "mail email microsoft calendar office" },
  slack: {
    help: "A bot token (xoxb-…) from your Slack app",
    keyPage: "https://api.slack.com/apps",
    terms: "chat messages",
  },
  linear: { help: "A personal API key (lin_api_…)", terms: "issues tickets projects" },
  notion: { help: "An internal integration secret", terms: "docs notes wiki pages" },
  stripe: {
    help: "A restricted key (rk_…)",
    keyPage: "https://dashboard.stripe.com/apikeys",
    terms: "payments billing invoices",
  },
};

/** The generic options, always last, under Other. */
export const OTHER_CHOICES: readonly ServiceChoice[] = [
  { value: "mcp", name: "MCP server", need: "mcp", alias: "", terms: "remote server url any" },
  {
    value: "cli",
    name: "Any CLI (heel run)",
    need: "cli",
    alias: "",
    terms: "command terminal run gh",
  },
];

/** The first sentence of the hint `heel_request_connection` shows, as a fallback help line. */
function firstSentence(text: string | undefined): string | undefined {
  return text?.split(/\.\s|\s\(/)[0]?.replace(/\.$/, "");
}

/** The built-in services, in one stable alphabetical order. */
export function serviceChoices(): ServiceChoice[] {
  return REQUESTABLE_SERVICES.map((value): ServiceChoice => {
    const extra = EXTRAS[value] ?? {};
    const help = extra.help ?? firstSentence((KEY_HINTS as Record<string, string>)[value]);
    return {
      value,
      name: serviceLabel({ provider: value, alias: value }),
      need: needsKey(value) ? "key" : "signin",
      alias: extra.alias ?? value,
      ...(help === undefined ? {} : { help }),
      ...(extra.keyPage === undefined ? {} : { keyPage: extra.keyPage }),
      ...(extra.terms === undefined ? {} : { terms: extra.terms }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Past this many services the tiles become a one-column list: 8 tiles are
 * four rows of two on a phone, which fit under the search field with Other
 * still on screen at 390x844; a fifth row pushes Other below the fold.
 */
export const LIST_AFTER = 8;
