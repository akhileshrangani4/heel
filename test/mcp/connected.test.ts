import { describe, expect, it } from "vitest";
import { connectedKeyNote } from "../../src/gateway/mcp/connected.ts";
import { KEY_SERVICES, SIGN_IN_SERVICES } from "../../src/requests/connection.ts";

/**
 * The note an agent passes on once a key it asked for is connected. heel
 * holds that key now, so the note speaks only of other copies, and must
 * never read as "revoke the key you just gave heel".
 */

const notes = KEY_SERVICES.map((service) => {
  const note = connectedKeyNote(service, `${service}-work`);
  if (note === null) throw new Error(`no note for ${service}`);
  return { service, note };
});

const sentences = (text: string) => text.split(/(?<=\.)\s+/);

describe("the note on a connected key", () => {
  it("is only for services that take a key", () => {
    for (const service of [...SIGN_IN_SERVICES, "mcp", "mcp:abc123", "http:api", "cli:gh"]) {
      expect(connectedKeyNote(service, "x"), service).toBeNull();
    }
    expect(notes.map((n) => n.service)).toEqual([...KEY_SERVICES]);
  });

  it("says heel holds the key now and to keep it only in heel", () => {
    for (const { service, note } of notes) {
      expect(note, service).toMatch(/heel now holds their \w+ key, so keep it only in heel\./);
      expect(note, service).toContain(`When a call on ${service}-work first works`);
    }
  });

  it("never tells the owner to revoke the key heel holds", () => {
    for (const { service, note } of notes) {
      for (const sentence of sentences(note)) {
        // Revoking is offered only for an older key, and only when it isn't the one heel holds.
        if (/\brevoke\b/i.test(sentence)) {
          expect(sentence, service).toMatch(/\bolder\b/);
          expect(sentence, service).toContain("if it's a different key from the one heel holds");
        }
        // Any other mention of revoking says what it would break.
        if (/\brevoking\b/i.test(sentence)) expect(sentence, service).toMatch(/would cut heel off/);
      }
      expect(note, service).not.toMatch(
        /\b(revoke|delete|remove) (this key|the key (they|you) (just )?(gave|pasted)|the key heel (now )?holds|heel's key|the new key)\b/i,
      );
    }
  });

  it("leaves logging gh out to the owner, with the tradeoff, and never says never", () => {
    const github = notes.find((n) => n.service === "github")?.note ?? "";
    expect(github).toContain("Logging gh out (gh auth logout) is optional and their choice");
    expect(github).toMatch(/handy, but it's a second place on this machine with broad access/);
    // A token from gh auth token is the gh login's own: logging gh out leaves it working, revoking the app doesn't.
    expect(github).toMatch(
      /came from gh auth token, logging out only removes it from this machine/,
    );
    expect(github).toMatch(/revoking the GitHub CLI's access on GitHub would cut heel off too/);
    for (const { service, note } of notes) {
      expect(note, service).not.toMatch(/\bnever\b/i);
      if (service !== "github") expect(note, service).not.toMatch(/\bgh\b/);
    }
  });

  it("uses no em dashes", () => {
    for (const { service, note } of notes) expect(note, service).not.toMatch(/\u2014/);
  });
});
