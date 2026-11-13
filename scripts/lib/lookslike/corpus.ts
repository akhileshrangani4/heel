/**
 * The `looks_like` evaluation corpus (spec: Hiding, `looks_like`; decided
 * Nov 13: synthetic reset and code mail from public provider templates, plus
 * ordinary mail from a public corpus).
 *
 * Nothing here is message text. The synthetic mail is regenerated from code
 * and a seed; the ordinary mail is re-extracted from a pinned archive by
 * path and checked against a committed content hash. `manifest.json` records
 * both, and its digests let `pnpm eval:looks-like` prove it is measuring the
 * same corpus the weights were trained against.
 */
import { z } from "zod";
import {
  LOOKS_LIKE_CATEGORIES,
  type LooksLikeCategory,
} from "../../../src/core/lookslike/types.ts";
import type { EnronMessage, IndexedMessage, OrdinarySelection } from "./enron.ts";
import type { PinnedArchive } from "./enron-archive.ts";
import { sha256 } from "./hashing.ts";
import { FAMILIES } from "./synthetic/families.ts";
import { type SyntheticMessage, splitUnit } from "./synthetic/generate.ts";
import { TEMPLATE_SOURCES } from "./synthetic/sources.ts";
import type { LabeledMessage, ThresholdPolicy, TrainOptions } from "./train.ts";

export const CORPUS_SEED = "heel-looks-like-v1";

export const SYNTHETIC_SETTINGS = {
  seed: CORPUS_SEED,
  perFamily: 50,
  heldOutShare: 1 / 3,
} as const;

/** Mailbox owners, not messages, are split, so no correspondent's style crosses splits. */
export const ORDINARY_SELECTION: OrdinarySelection = {
  seed: CORPUS_SEED,
  heldOutUserShare: 0.3,
  trainCount: 4000,
  heldOutCount: 2000,
};

/** The CMU release of the Enron corpus, May 7 2015 version. Never committed. */
export const ENRON_ARCHIVE: PinnedArchive = {
  url: "https://www.cs.cmu.edu/~enron/enron_mail_20150507.tar.gz",
  sha256: "b3da1b3fe0369ec3140bb4fbce94702c33b7da810ec15d718b3fadf5cd748ca7",
  bytes: 443_254_787,
};

/**
 * What the distributor says about use, quoted from https://www.cs.cmu.edu/~enron/
 * (read Nov 13 2026). No license is stated.
 */
export const ENRON_TERMS =
  'No license is stated. The distributor offers it "as a resource for researchers who are interested in improving current email tools" ' +
  'and asks users to "be sensitive to the privacy of the people involved". heel commits only archive paths and content hashes, never message text.';

export const TRAINING_SETTINGS: {
  train: Omit<TrainOptions, "seed">;
  folds: number;
  policy: ThresholdPolicy;
} = {
  train: { dims: 2 ** 16, epochs: 8, learningRate: 0.1, l2: 1e-6 },
  folds: 5,
  // Recall is the hard constraint; the FPR budget buys margin for unseen templates.
  policy: { targetRecall: 0.995, ordinaryFprBudget: 0.005 },
};

/** The release gate (spec D10 row), plus floors so it can never pass on an empty set. */
export const GATE = {
  minRecall: 0.99,
  maxOrdinaryFpr: 0.05,
  minPositivesPerCategory: 100,
  minOrdinary: 1000,
} as const;

export const CORPUS_DIR = "corpus/looks-like";
export const MANIFEST_FILE = `${CORPUS_DIR}/manifest.json`;
export const ENRON_LIST_FILES = {
  train: `${CORPUS_DIR}/enron-train.tsv`,
  heldOut: `${CORPUS_DIR}/enron-held-out.tsv`,
} as const;

/** Where `pnpm gen:looks-like` and `pnpm eval:looks-like` look for the archive by default. */
export const DEFAULT_ARCHIVE_PATH = ".cache/looks-like/enron_mail_20150507.tar.gz";

// --- labelled messages -------------------------------------------------------

export function syntheticLabeled(messages: readonly SyntheticMessage[]): LabeledMessage[] {
  return messages.map((m) => ({
    id: m.id,
    group: m.splitUnit,
    labels: m.labels,
    ordinary: false,
    message: m.message,
  }));
}

/** Enron mail is taken as ordinary without review; a reset mail in it would only overstate FPR. */
export function enronLabeled(messages: readonly EnronMessage[]): LabeledMessage[] {
  return messages.map((m) => ({
    id: `enron:${m.path}`,
    group: `enron:${m.user}`,
    labels: [],
    ordinary: true,
    message: { subject: m.subject, from: m.from, body: m.body, bodyFormat: "text" },
  }));
}

// --- digests and lists -------------------------------------------------------

/** Stable over regeneration: any change to a family, the renderer or the seed changes it. */
export function syntheticDigest(messages: readonly SyntheticMessage[]): string {
  return sha256(messages.map((m) => JSON.stringify([m.id, m.labels, m.message])).join("\n"));
}

export interface EnronListEntry {
  path: string;
  contentHash: string;
}

export function formatEnronList(entries: readonly IndexedMessage[]): string {
  return `${[...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.path}\t${e.contentHash}`)
    .join("\n")}\n`;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseEnronList(text: string, file: string): EnronListEntry[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const [path, contentHash, ...rest] = line.split("\t");
      if (!path || !contentHash || rest.length > 0 || !HEX64.test(contentHash)) {
        throw new Error(`${file}:${index + 1}: expected "<path>\\t<sha256>"`);
      }
      return { path, contentHash };
    });
}

export function userOfPath(path: string): string {
  const user = path.split("/")[1];
  if (!user) throw new Error(`not an Enron maildir path: ${path}`);
  return user;
}

// --- manifest ----------------------------------------------------------------

const CategorySchema = z.enum(LOOKS_LIKE_CATEGORIES);
const SplitCountsSchema = z
  .object({
    password_reset: z.number().int(),
    login_code: z.number().int(),
    negative: z.number().int(),
  })
  .strict();

const ManifestSchema = z
  .object({
    format: z.literal("heel.looks-like.corpus"),
    version: z.literal(1),
    synthetic: z
      .object({
        seed: z.string(),
        perFamily: z.number().int().positive(),
        heldOutShare: z.number().gt(0).lt(1),
        generator: z.string(),
        sources: z.record(
          z.string(),
          z
            .object({
              repo: z.string(),
              commit: z.string(),
              license: z.string(),
              licenseFile: z.string(),
              files: z.array(z.string()),
              note: z.string().optional(),
            })
            .strict(),
        ),
        families: z.array(
          z
            .object({
              id: z.string(),
              source: z.string(),
              labels: z.array(CategorySchema),
              split: z.enum(["train", "held_out"]),
            })
            .strict(),
        ),
        heldOutUnits: z.array(z.string()),
        counts: z.object({ train: SplitCountsSchema, heldOut: SplitCountsSchema }).strict(),
        digests: z.object({ train: z.string(), heldOut: z.string() }).strict(),
      })
      .strict(),
    ordinary: z
      .object({
        name: z.string(),
        archive: z
          .object({ url: z.string(), sha256: z.string(), bytes: z.number().int() })
          .strict(),
        terms: z.string(),
        selection: z
          .object({
            seed: z.string(),
            heldOutUserShare: z.number(),
            trainCount: z.number().int(),
            heldOutCount: z.number().int(),
          })
          .strict(),
        lists: z.object({ train: z.string(), heldOut: z.string() }).strict(),
        counts: z.object({ train: z.number().int(), heldOut: z.number().int() }).strict(),
        mailboxes: z.object({ train: z.number().int(), heldOut: z.number().int() }).strict(),
        digests: z.object({ train: z.string(), heldOut: z.string() }).strict(),
      })
      .strict(),
    notes: z.array(z.string()),
  })
  .strict();

export type CorpusManifest = z.infer<typeof ManifestSchema>;

export function parseManifest(input: unknown): CorpusManifest {
  return ManifestSchema.parse(input);
}

function splitCounts(messages: readonly SyntheticMessage[]): z.infer<typeof SplitCountsSchema> {
  const count = (category: LooksLikeCategory) =>
    messages.filter((m) => m.labels.includes(category)).length;
  return {
    password_reset: count("password_reset"),
    login_code: count("login_code"),
    negative: messages.filter((m) => m.labels.length === 0).length,
  };
}

export interface ManifestInputs {
  synthetic: {
    train: readonly SyntheticMessage[];
    heldOut: readonly SyntheticMessage[];
    heldOutUnits: readonly string[];
  };
  enronLists: { train: string; heldOut: string };
  enron: { train: readonly IndexedMessage[]; heldOut: readonly IndexedMessage[] };
}

/** Pure: the manifest for a generated corpus. */
export function buildManifest(inputs: ManifestInputs): CorpusManifest {
  const heldOutUnits = new Set(inputs.synthetic.heldOutUnits);
  const mailboxes = (items: readonly IndexedMessage[]) => new Set(items.map((m) => m.user)).size;
  return {
    format: "heel.looks-like.corpus",
    version: 1,
    synthetic: {
      seed: SYNTHETIC_SETTINGS.seed,
      perFamily: SYNTHETIC_SETTINGS.perFamily,
      heldOutShare: SYNTHETIC_SETTINGS.heldOutShare,
      generator: "scripts/lib/lookslike/synthetic",
      // Copied: TEMPLATE_SOURCES is deeply readonly, the manifest is plain JSON.
      sources: Object.fromEntries(
        Object.entries(TEMPLATE_SOURCES).map(([id, source]) => [
          id,
          { ...source, files: [...source.files] },
        ]),
      ),
      families: FAMILIES.map((f) => ({
        id: f.id,
        source: f.source,
        labels: [...f.labels],
        split: heldOutUnits.has(splitUnit(f)) ? "held_out" : "train",
      })),
      heldOutUnits: [...inputs.synthetic.heldOutUnits],
      counts: {
        train: splitCounts(inputs.synthetic.train),
        heldOut: splitCounts(inputs.synthetic.heldOut),
      },
      digests: {
        train: syntheticDigest(inputs.synthetic.train),
        heldOut: syntheticDigest(inputs.synthetic.heldOut),
      },
    },
    ordinary: {
      name: "Enron email corpus, CMU release of May 7 2015",
      archive: { ...ENRON_ARCHIVE },
      terms: ENRON_TERMS,
      selection: { ...ORDINARY_SELECTION },
      lists: { ...ENRON_LIST_FILES },
      counts: { train: inputs.enron.train.length, heldOut: inputs.enron.heldOut.length },
      mailboxes: { train: mailboxes(inputs.enron.train), heldOut: mailboxes(inputs.enron.heldOut) },
      digests: {
        train: sha256(inputs.enronLists.train),
        heldOut: sha256(inputs.enronLists.heldOut),
      },
    },
    notes: [
      "Held-out synthetic mail comes from template sources (and heel-written negative families) the model never trained on; the split is by source, not by message.",
      "Held-out ordinary mail comes from Enron mailbox owners whose mail is not in the training split.",
      "The patterns were written after reading every template source, including held-out ones, so held-out recall measures the classifier on unseen sources, not the patterns.",
      "The false-positive gate is measured on ordinary (Enron) mail, as the spec defines it. The synthetic transactional and account-notice negatives are reported as a diagnostic only.",
      "Enron is 2001 corporate mail with little automated mail, so it understates how much modern transactional mail the detector hides; D10b's watch-mode check covers that gap.",
    ],
  };
}
