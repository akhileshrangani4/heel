/**
 * `pnpm eval:looks-like`: the `looks_like` release gate (spec: Hiding,
 * `looks_like`; D10 row). Blocking in CI.
 *
 * Exits 0 only when, on the held-out split, recall is at least 0.99 for each
 * category and the false-positive rate on ordinary mail is at most 5%. It
 * exits 1 first if the corpus is not the one the weights were trained
 * against: the weights must name this manifest, the regenerated synthetic
 * mail must match its digests, and every held-out Enron message must match
 * its committed content hash. A gate measured on a different corpus measures
 * nothing.
 *
 * The model is loaded through `src/lookslike/load.ts`, the path heel uses.
 *
 * Usage: node ./scripts/eval-looks-like.ts [--archive <enron tar.gz>] [--report <json out>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { LOOKS_LIKE_WEIGHTS_PATH, loadLooksLikeModel } from "../src/lookslike/load.ts";
import {
  DEFAULT_ARCHIVE_PATH,
  ENRON_ARCHIVE,
  ENRON_LIST_FILES,
  enronLabeled,
  GATE,
  MANIFEST_FILE,
  parseEnronList,
  parseManifest,
  SYNTHETIC_SETTINGS,
  syntheticDigest,
  syntheticLabeled,
  userOfPath,
} from "./lib/lookslike/corpus.ts";
import { contentHash } from "./lib/lookslike/enron.ts";
import { extractMessages, verifyArchive } from "./lib/lookslike/enron-archive.ts";
import { evaluateLooksLike, formatEvalReport } from "./lib/lookslike/evaluate.ts";
import { sha256 } from "./lib/lookslike/hashing.ts";
import { generateSyntheticCorpus } from "./lib/lookslike/synthetic/generate.ts";

const root = resolve(import.meta.dirname, "..");
const log = (line: string) => process.stdout.write(`${line}\n`);
const { values } = parseArgs({
  options: { archive: { type: "string" }, report: { type: "string" } },
});
const archive = resolve(
  values.archive ?? process.env["HEEL_ENRON_ARCHIVE"] ?? join(root, DEFAULT_ARCHIVE_PATH),
);

function fail(message: string): never {
  console.error(`eval:looks-like: ${message}`);
  process.exit(1);
}

// --- the corpus is the one the weights were trained against -------------------

const manifestText = readFileSync(join(root, MANIFEST_FILE), "utf8");
const manifest = parseManifest(JSON.parse(manifestText));

const Provenance = z.object({ training: z.object({ manifestSha256: z.string() }) });
const provenance = Provenance.parse(JSON.parse(readFileSync(LOOKS_LIKE_WEIGHTS_PATH, "utf8")));
if (provenance.training.manifestSha256 !== sha256(manifestText)) {
  fail(`${LOOKS_LIKE_WEIGHTS_PATH} was trained against another manifest: run pnpm gen:looks-like`);
}

const loaded = loadLooksLikeModel();
if (loaded.status !== "loaded") fail(`model not loaded from ${loaded.path}: ${loaded.error}`);

const synthetic = generateSyntheticCorpus(SYNTHETIC_SETTINGS);
const digests = {
  train: syntheticDigest(synthetic.train),
  heldOut: syntheticDigest(synthetic.heldOut),
};
if (digests.train !== manifest.synthetic.digests.train) {
  fail("synthetic training mail differs from the manifest: run pnpm gen:looks-like");
}
if (digests.heldOut !== manifest.synthetic.digests.heldOut) {
  fail("synthetic held-out mail differs from the manifest: run pnpm gen:looks-like");
}

const lists = {
  train: readFileSync(join(root, ENRON_LIST_FILES.train), "utf8"),
  heldOut: readFileSync(join(root, ENRON_LIST_FILES.heldOut), "utf8"),
};
if (sha256(lists.train) !== manifest.ordinary.digests.train) {
  fail(`${ENRON_LIST_FILES.train} differs from the manifest`);
}
if (sha256(lists.heldOut) !== manifest.ordinary.digests.heldOut) {
  fail(`${ENRON_LIST_FILES.heldOut} differs from the manifest`);
}
const trainEntries = parseEnronList(lists.train, ENRON_LIST_FILES.train);
const heldOutEntries = parseEnronList(lists.heldOut, ENRON_LIST_FILES.heldOut);
const trainUsers = new Set(trainEntries.map((e) => userOfPath(e.path)));
const leaked = [...new Set(heldOutEntries.map((e) => userOfPath(e.path)))].filter((u) =>
  trainUsers.has(u),
);
if (leaked.length > 0) fail(`mailboxes in both Enron splits: ${leaked.join(", ")}`);

if (manifest.ordinary.archive.sha256 !== ENRON_ARCHIVE.sha256) {
  fail("the manifest pins a different Enron archive than scripts/lib/lookslike/corpus.ts");
}
log(`verifying ${archive}`);
await verifyArchive(archive, ENRON_ARCHIVE);
const expected = new Map(heldOutEntries.map((e) => [e.path, e.contentHash]));
const enronHeldOut = await extractMessages(archive, new Set(expected.keys()));
if (enronHeldOut.length !== expected.size) {
  fail(`extracted ${enronHeldOut.length} of ${expected.size} held-out Enron messages`);
}
for (const m of enronHeldOut) {
  if (contentHash(m) !== expected.get(m.path)) fail(`content hash changed for ${m.path}`);
}

// --- the gate ----------------------------------------------------------------

const heldOut = [...syntheticLabeled(synthetic.heldOut), ...enronLabeled(enronHeldOut)];
const started = performance.now();
const report = evaluateLooksLike(heldOut, loaded.model, GATE);
const elapsedMs = performance.now() - started;

process.stdout.write(
  formatEvalReport(
    report,
    `looks_like held-out evaluation: ${synthetic.heldOut.length} synthetic, ${enronHeldOut.length} ordinary`,
  ),
);
log(`  classified ${heldOut.length} messages in ${elapsedMs.toFixed(0)} ms`);

if (values.report) {
  const out = { manifestSha256: sha256(manifestText), gate: GATE, elapsedMs, ...report };
  writeFileSync(resolve(values.report), `${JSON.stringify(out, null, 2)}\n`);
}
process.exit(report.pass ? 0 : 1);
