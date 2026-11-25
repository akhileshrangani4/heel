import { describe, expect, it } from "vitest";
import { GOOGLE_CALENDAR_TOOLS } from "../../src/definitions/calendar/google.ts";
import type { CliDeps } from "../../src/definitions/cli/definition.ts";
import { GITHUB_TOOLS } from "../../src/definitions/github/definition.ts";
import { GMAIL_TOOLS } from "../../src/definitions/gmail/definition.ts";
import { LINEAR_TOOLS } from "../../src/definitions/linear/definition.ts";
import type { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { NOTION_TOOLS } from "../../src/definitions/notion/definition.ts";
import { OUTLOOK_TOOLS } from "../../src/definitions/outlook/definition.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { SLACK_TOOLS } from "../../src/definitions/slack/definition.ts";
import { STRIPE_TOOLS } from "../../src/definitions/stripe/definition.ts";
import type { Definition } from "../../src/gateway/pipeline/ports.ts";
import type { SandboxHost } from "../../src/runner/plan.ts";
import type { AccountRecord } from "../../src/store/directory.ts";
import type { Vault } from "../../src/vault/vault.ts";

/**
 * Which definition the registry hands back for each provider, under every
 * combination of the deps it was built with. Building a definition never
 * reads a credential.
 */

let tokenReads = 0;
const vault = {
  accessToken: () => {
    tokenReads += 1;
    throw new Error("building a definition must not read a credential");
  },
} as unknown as Vault;
const fetch = (() => Promise.reject(new Error("no network"))) as typeof globalThis.fetch;
const api = { vault, fetch };
const upstream = {
  listTools: () => Promise.resolve([{ name: "upstream_tool" }]),
} as unknown as UpstreamPool;
const cli: CliDeps = {
  vault,
  sandbox: {} as SandboxHost,
  start: () => Promise.reject(new Error("no sandbox")),
  workRoots: () => [],
  fetch,
};

const SERVICE_KEYS = [
  "gmail",
  "outlook",
  "googleCalendar",
  "notion",
  "stripe",
  "linear",
  "slack",
  "http",
  "github",
  "cli",
] as const;
type ServiceKey = (typeof SERVICE_KEYS)[number];
type RegistryDeps = Parameters<typeof definitionRegistry>[0];

function depsWith(present: readonly ServiceKey[], nulls: readonly ServiceKey[] = []): RegistryDeps {
  const deps: Record<string, unknown> = { upstream, gmail: null };
  for (const key of present) deps[key] = key === "cli" ? cli : api;
  for (const key of nulls) deps[key] = null;
  return deps as unknown as RegistryDeps;
}

function account(provider: string, settings: Record<string, unknown> = {}): AccountRecord {
  return {
    id: "acct_1",
    orgId: "org_1",
    ownerId: "user_1",
    ownerName: "owner",
    alias: "work",
    provider,
    status: "active",
    settings,
  };
}

const MAILBOX = { mailbox: "me@example.com" };
const HTTP = { transport: "http", baseUrl: "https://api.example.com", auth: { type: "bearer" } };
const CLI = { transport: "cli", command: "gh", bin: "/usr/bin/gh" };

const LISTS: Record<string, readonly { name: string }[]> = {
  gmail: GMAIL_TOOLS,
  outlook: OUTLOOK_TOOLS,
  "google-calendar": GOOGLE_CALENDAR_TOOLS,
  github: GITHUB_TOOLS,
  notion: NOTION_TOOLS,
  stripe: STRIPE_TOOLS,
  linear: LINEAR_TOOLS,
  slack: SLACK_TOOLS,
  mcp: [{ name: "upstream_tool" }],
};
const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name).join(",");

/** Which definition this is: the service whose tool list it lists, or HTTP or CLI by its shape. */
async function identify(definition: Definition | null): Promise<string | null> {
  if (definition === null) return null;
  if (definition.tools === undefined) {
    return definition.executeTimeoutMs === undefined ? "http" : "cli";
  }
  const listed = names(await definition.tools(new AbortController().signal));
  const matches = Object.keys(LISTS).filter((label) => names(LISTS[label] ?? []) === listed);
  expect(matches).toHaveLength(1);
  return matches[0] ?? null;
}

/** Provider, the account's settings, the deps key that serves it, and the definition it gets. */
const SERVICES: [string, Record<string, unknown>, ServiceKey, string][] = [
  ["gmail", {}, "gmail", "gmail"],
  ["outlook", MAILBOX, "outlook", "outlook"],
  ["google-calendar", MAILBOX, "googleCalendar", "google-calendar"],
  ["github", {}, "github", "github"],
  ["notion", {}, "notion", "notion"],
  ["stripe", {}, "stripe", "stripe"],
  ["linear", {}, "linear", "linear"],
  ["slack", {}, "slack", "slack"],
  ["http:billing", HTTP, "http", "http"],
  ["cli:gh", CLI, "cli", "cli"],
];

describe("definitionRegistry", () => {
  it("the service tool lists are distinct, so each definition can be told apart", () => {
    const listed = Object.values(LISTS).map(names);
    expect(new Set(listed).size).toBe(listed.length);
  });

  for (const [provider, settings, key, label] of SERVICES) {
    const others = SERVICE_KEYS.filter((other) => other !== key);

    it(`${provider}: its own deps serve it`, async () => {
      const registry = definitionRegistry(depsWith([key]));
      expect(await identify(registry.forAccount(account(provider, settings)))).toBe(label);
    });

    it(`${provider}: every deps present still serves it`, async () => {
      const registry = definitionRegistry(depsWith(SERVICE_KEYS));
      expect(await identify(registry.forAccount(account(provider, settings)))).toBe(label);
    });

    it(`${provider}: null when its own deps are null`, async () => {
      const registry = definitionRegistry(depsWith(others, [key]));
      expect(registry.forAccount(account(provider, settings))).toBeNull();
    });

    if (key !== "gmail") {
      it(`${provider}: null when its own deps are absent`, async () => {
        const registry = definitionRegistry(depsWith(others));
        expect(registry.forAccount(account(provider, settings))).toBeNull();
      });
    }
  }

  it("gmail: deps forced to undefined still reach the Gmail definition, which throws", () => {
    const deps = { ...depsWith(SERVICE_KEYS.filter((key) => key !== "gmail")), gmail: undefined };
    const registry = definitionRegistry(deps as unknown as RegistryDeps);
    expect(() => registry.forAccount(account("gmail"))).toThrow(TypeError);
  });

  it("mcp: the passthrough serves it with no service deps at all", async () => {
    const registry = definitionRegistry(depsWith([]));
    expect(await identify(registry.forAccount(account("mcp:docs")))).toBe("mcp");
  });

  it("mcp: the passthrough serves it with every service deps present", async () => {
    const registry = definitionRegistry(depsWith(SERVICE_KEYS));
    expect(await identify(registry.forAccount(account("mcp:docs")))).toBe("mcp");
  });

  const FACTORY_NULLS: [string, string, Record<string, unknown>, RegistryDeps][] = [
    ["outlook before its first sign-in", "outlook", {}, depsWith(SERVICE_KEYS)],
    ["google-calendar before its first sign-in", "google-calendar", {}, depsWith(SERVICE_KEYS)],
    ["http with settings that don't parse", "http:billing", {}, depsWith(SERVICE_KEYS)],
    ["cli with settings that don't parse", "cli:gh", {}, depsWith(SERVICE_KEYS)],
    ["cli kubectl", "cli:kube", { ...CLI, command: "kubectl" }, depsWith(SERVICE_KEYS)],
    [
      "cli without a sandbox",
      "cli:gh",
      CLI,
      { ...depsWith(SERVICE_KEYS), cli: { ...cli, sandbox: null } },
    ],
  ];
  for (const [name, provider, settings, deps] of FACTORY_NULLS) {
    it(`null for ${name}`, () => {
      expect(definitionRegistry(deps).forAccount(account(provider, settings))).toBeNull();
    });
  }

  for (const provider of [
    "unknown",
    "google",
    "microsoft",
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "",
  ]) {
    it(`null for provider ${JSON.stringify(provider)} even with every deps present`, () => {
      expect(definitionRegistry(depsWith(SERVICE_KEYS)).forAccount(account(provider))).toBeNull();
    });
  }

  it("building any definition reads no credential", async () => {
    tokenReads = 0;
    const registry = definitionRegistry(depsWith(SERVICE_KEYS));
    for (const [provider, settings] of SERVICES) {
      await identify(registry.forAccount(account(provider, settings)));
    }
    await identify(registry.forAccount(account("mcp:docs")));
    expect(tokenReads).toBe(0);
  });
});
