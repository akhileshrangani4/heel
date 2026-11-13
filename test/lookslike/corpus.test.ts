/**
 * The committed corpus and weights agree with the code that made them. These
 * are the cheap halves of `pnpm eval:looks-like`'s provenance checks: they
 * need no Enron archive, so `pnpm test` catches a family edited without
 * regenerating, the way schema-drift catches an unregenerated JSON Schema.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENRON_LIST_FILES,
  GATE,
  MANIFEST_FILE,
  ORDINARY_SELECTION,
  parseEnronList,
  parseManifest,
  SYNTHETIC_SETTINGS,
  syntheticDigest,
  userOfPath,
} from "../../scripts/lib/lookslike/corpus.ts";
import { generateSyntheticCorpus } from "../../scripts/lib/lookslike/synthetic/generate.ts";
import { LOOKS_LIKE_CATEGORIES } from "../../src/core/lookslike/types.ts";
import { LOOKS_LIKE_WEIGHTS_PATH } from "../../src/lookslike/load.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const manifestText = read(MANIFEST_FILE);
const manifest = parseManifest(JSON.parse(manifestText));
const synthetic = generateSyntheticCorpus(SYNTHETIC_SETTINGS);

describe("synthetic corpus", () => {
  it("regenerates to the digests in the committed manifest", () => {
    expect(syntheticDigest(synthetic.train)).toBe(manifest.synthetic.digests.train);
    expect(syntheticDigest(synthetic.heldOut)).toBe(manifest.synthetic.digests.heldOut);
  });

  it("never puts a held-out split unit in training", () => {
    const heldOut = new Set(synthetic.heldOutUnits);
    expect(synthetic.train.filter((m) => heldOut.has(m.splitUnit))).toEqual([]);
    expect(synthetic.heldOut.every((m) => heldOut.has(m.splitUnit))).toBe(true);
  });

  it("holds out enough positives per category for the gate to be meaningful", () => {
    for (const category of LOOKS_LIKE_CATEGORIES) {
      const positives = synthetic.heldOut.filter((m) => m.labels.includes(category));
      expect(positives.length).toBeGreaterThanOrEqual(GATE.minPositivesPerCategory);
    }
  });
});

describe("ordinary (Enron) lists", () => {
  const lists = {
    train: read(ENRON_LIST_FILES.train),
    heldOut: read(ENRON_LIST_FILES.heldOut),
  };
  const entries = {
    train: parseEnronList(lists.train, ENRON_LIST_FILES.train),
    heldOut: parseEnronList(lists.heldOut, ENRON_LIST_FILES.heldOut),
  };

  it("match the digests and counts in the manifest", () => {
    expect(sha256(lists.train)).toBe(manifest.ordinary.digests.train);
    expect(sha256(lists.heldOut)).toBe(manifest.ordinary.digests.heldOut);
    expect(entries.train).toHaveLength(ORDINARY_SELECTION.trainCount);
    expect(entries.heldOut).toHaveLength(ORDINARY_SELECTION.heldOutCount);
    expect(entries.heldOut.length).toBeGreaterThanOrEqual(GATE.minOrdinary);
  });

  it("split by mailbox owner, so no owner's mail is on both sides", () => {
    const trainUsers = new Set(entries.train.map((e) => userOfPath(e.path)));
    const shared = entries.heldOut.filter((e) => trainUsers.has(userOfPath(e.path)));
    expect(shared).toEqual([]);
  });

  it("list paths and hashes only, never message text", () => {
    for (const line of [...lists.train.split("\n"), ...lists.heldOut.split("\n")]) {
      if (line.length === 0) continue;
      expect(line).toMatch(/^maildir\/[^\t]+\t[0-9a-f]{64}$/);
    }
  });
});

describe("committed weights", () => {
  it("were trained against the committed manifest", () => {
    const weights = JSON.parse(readFileSync(LOOKS_LIKE_WEIGHTS_PATH, "utf8"));
    expect(weights.training.manifestSha256).toBe(sha256(manifestText));
  });
});
