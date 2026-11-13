/**
 * Reading the pinned Enron archive: verify it, index it, extract a sample.
 * The archive is never committed; `ENRON_ARCHIVE` in the manifest names the
 * URL and SHA-256 every step checks before trusting a local copy.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import {
  contentHash,
  type EnronMessage,
  type IndexedMessage,
  isMessagePath,
  parseEnronMessage,
} from "./enron.ts";
import { readTar } from "./tar.ts";

export interface PinnedArchive {
  url: string;
  sha256: string;
  bytes: number;
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Throws unless `path` exists and hashes to the pinned value. */
export async function verifyArchive(path: string, pinned: PinnedArchive): Promise<void> {
  if (!existsSync(path)) {
    throw new Error(`Enron archive not found at ${path}. Download ${pinned.url} there first.`);
  }
  const actual = await fileSha256(path);
  if (actual !== pinned.sha256) {
    throw new Error(`Enron archive at ${path} has SHA-256 ${actual}, expected ${pinned.sha256}.`);
  }
}

function messages(
  path: string,
  want: (p: string) => boolean,
): AsyncGenerator<{ path: string; data: Buffer }> {
  return readTar(createReadStream(path).pipe(createGunzip()), want);
}

/** One pass over the archive: every message's path, owner and content hash. */
export async function indexArchive(path: string): Promise<IndexedMessage[]> {
  const index: IndexedMessage[] = [];
  for await (const file of messages(path, isMessagePath)) {
    const message = parseEnronMessage(file.path, file.data);
    index.push({ path: message.path, user: message.user, contentHash: contentHash(message) });
  }
  return index;
}

/** The messages at `paths`, in archive order. Throws if any is missing. */
export async function extractMessages(
  path: string,
  paths: ReadonlySet<string>,
): Promise<EnronMessage[]> {
  const found: EnronMessage[] = [];
  for await (const file of messages(path, (p) => paths.has(p))) {
    found.push(parseEnronMessage(file.path, file.data));
  }
  if (found.length !== paths.size) {
    const seen = new Set(found.map((m) => m.path));
    const missing = [...paths].filter((p) => !seen.has(p)).slice(0, 5);
    throw new Error(
      `Enron archive is missing ${paths.size - found.length} sampled paths, e.g. ${missing.join(", ")}`,
    );
  }
  return found;
}
