/**
 * `pnpm gen:looks-like`: builds the `looks_like` corpus and trains the
 * weights (spec: Hiding, `looks_like`). Writes, all committed:
 * - `corpus/looks-like/manifest.json`: sources, licenses, splits, digests;
 * - `corpus/looks-like/enron-{train,held-out}.tsv`: archive paths and content hashes;
 * - `src/lookslike/weights.json`: the model, with its training provenance.
 *
 * Only the training split is read. Thresholds come from grouped out-of-fold
 * scores on it; the held-out split is touched only by `pnpm eval:looks-like`.
 *
 * Usage: node ./scripts/gen-looks-like.ts [--archive <enron tar.gz>] [--index <jsonl>]
 * `--index` reuses an archive index (one IndexedMessage per line) to skip a full scan.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FEATURE_VERSION } from "../src/core/lookslike/features.ts";
import {
  LOOKS_LIKE_MODEL_FORMAT,
  type LooksLikeModelFile,
  parseLooksLikeModel,
  quantizeWeights,
} from "../src/core/lookslike/model.ts";
import { LOOKS_LIKE_CATEGORIES, type LooksLikeCategory } from "../src/core/lookslike/types.ts";
import { LOOKS_LIKE_WEIGHTS_PATH } from "../src/lookslike/load.ts";
import {
  buildManifest,
  DEFAULT_ARCHIVE_PATH,
  ENRON_ARCHIVE,
  ENRON_LIST_FILES,
  enronLabeled,
  formatEnronList,
  MANIFEST_FILE,
  ORDINARY_SELECTION,
  SYNTHETIC_SETTINGS,
  syntheticLabeled,
  TRAINING_SETTINGS,
} from "./lib/lookslike/corpus.ts";
import { contentHash, type IndexedMessage, selectOrdinarySample } from "./lib/lookslike/enron.ts";
import { extractMessages, indexArchive, verifyArchive } from "./lib/lookslike/enron-archive.ts";
import { sha256 } from "./lib/lookslike/hashing.ts";
import { generateSyntheticCorpus } from "./lib/lookslike/synthetic/generate.ts";
import {
  chooseThresholds,
  encodeMessages,
  headExamples,
  outOfFoldScores,
  type ThresholdChoice,
  trainHead,
} from "./lib/lookslike/train.ts";

const root = resolve(import.meta.dirname, "..");
const log = (line: string) => process.stdout.write(`${line}\n`);
const { values } = parseArgs({
  options: { archive: { type: "string" }, index: { type: "string" } },
});
const archive = resolve(
  values.archive ?? process.env["HEEL_ENRON_ARCHIVE"] ?? join(root, DEFAULT_ARCHIVE_PATH),
);

log(`verifying ${archive}`);
await verifyArchive(archive, ENRON_ARCHIVE);

const index: IndexedMessage[] = values.index
  ? readFileSync(values.index, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as IndexedMessage)
  : await indexArchive(archive);
log(`indexed ${index.length} messages`);

const sample = selectOrdinarySample(index, ORDINARY_SELECTION);
const trainHashes = new Map(sample.train.map((m) => [m.path, m.contentHash]));
const enronTrain = await extractMessages(archive, new Set(trainHashes.keys()));
if (enronTrain.length !== sample.train.length) {
  throw new Error(`extracted ${enronTrain.length} of ${sample.train.length} training messages`);
}
for (const m of enronTrain) {
  if (contentHash(m) !== trainHashes.get(m.path))
    throw new Error(`content hash changed for ${m.path}`);
}

const synthetic = generateSyntheticCorpus(SYNTHETIC_SETTINGS);
const training = [...syntheticLabeled(synthetic.train), ...enronLabeled(enronTrain)];
log(`training on ${synthetic.train.length} synthetic and ${enronTrain.length} ordinary messages`);

const { dims } = TRAINING_SETTINGS.train;
const encoded = encodeMessages(training, dims);
const options = { ...TRAINING_SETTINGS.train, seed: SYNTHETIC_SETTINGS.seed };

const heads = {} as LooksLikeModelFile["heads"];
const crossValidation = {} as Record<LooksLikeCategory, ThresholdChoice>;
for (const category of LOOKS_LIKE_CATEGORIES) {
  const scores = outOfFoldScores(encoded, category, options, TRAINING_SETTINGS.folds);
  const choice = chooseThresholds(encoded, category, scores, TRAINING_SETTINGS.policy);
  crossValidation[category] = choice;
  const head = trainHead(headExamples(encoded, category), options);
  heads[category] = {
    bias: head.bias,
    ...quantizeWeights(head.weights),
    matchAt: choice.matchAt,
    noMatchBelow: choice.noMatchBelow,
  };
  log(
    `${category}: noMatchBelow=${choice.noMatchBelow.toFixed(4)} (bound by ${choice.boundBy}) ` +
      `out-of-fold recall=${choice.recall.toFixed(4)} ordinary FPR=${choice.ordinaryFpr.toFixed(4)} ` +
      `hard-negative FPR=${choice.hardNegativeFpr.toFixed(4)}`,
  );
}

const enronLists = {
  train: formatEnronList(sample.train),
  heldOut: formatEnronList(sample.heldOut),
};
const manifest = buildManifest({ synthetic, enronLists, enron: sample });
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

const weights: LooksLikeModelFile = {
  format: LOOKS_LIKE_MODEL_FORMAT,
  featureVersion: FEATURE_VERSION,
  dims,
  heads,
  training: {
    manifestSha256: sha256(manifestText),
    settings: TRAINING_SETTINGS,
    examples: { synthetic: synthetic.train.length, ordinary: enronTrain.length },
    crossValidation,
  },
};
parseLooksLikeModel(weights);

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  log(`wrote ${path}`);
};
write(join(root, ENRON_LIST_FILES.train), enronLists.train);
write(join(root, ENRON_LIST_FILES.heldOut), enronLists.heldOut);
write(join(root, MANIFEST_FILE), manifestText);
write(LOOKS_LIKE_WEIGHTS_PATH, `${JSON.stringify(weights, null, 2)}\n`);
