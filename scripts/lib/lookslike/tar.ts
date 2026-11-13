/**
 * A streaming reader for ustar/GNU tar archives, enough to walk the Enron
 * maildir tarball without a dependency. Entries are yielded in archive
 * order; a file's bytes are buffered only when `want(path)` returns true.
 */

export interface TarFile {
  path: string;
  data: Buffer;
}

const BLOCK = 512;

/** Reads a NUL- or space-terminated octal field. */
function octal(header: Buffer, start: number, length: number): number {
  const raw = header
    .subarray(start, start + length)
    .toString("latin1")
    .replace(/[\0 ]+$/g, "")
    .trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`tar: bad octal field "${raw}"`);
  return Number.parseInt(raw, 8);
}

function cString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Reads `path=...` from a pax extended header body. */
function paxPath(body: Buffer): string | undefined {
  let offset = 0;
  const text = body.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    if (record.startsWith("path=")) return record.slice(5);
    offset += length;
  }
  return undefined;
}

/**
 * Accumulates chunks and hands out exact byte counts. Consumed chunks are
 * dropped, so memory stays bounded by the largest entry requested.
 */
class ByteQueue {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  get available(): number {
    return this.length;
  }

  take(count: number): Buffer {
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const head = this.chunks[0];
      if (head === undefined) throw new Error("tar: queue underflow");
      const n = Math.min(head.length, count - written);
      head.copy(out, written, 0, n);
      written += n;
      if (n === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(n);
    }
    this.length -= count;
    return out;
  }

  skip(count: number): void {
    let left = count;
    while (left > 0) {
      const head = this.chunks[0];
      if (head === undefined) throw new Error("tar: queue underflow");
      const n = Math.min(head.length, left);
      left -= n;
      if (n === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(n);
    }
    this.length -= count;
  }
}

export async function* readTar(
  chunks: AsyncIterable<Buffer | Uint8Array>,
  want: (path: string) => boolean,
): AsyncGenerator<TarFile> {
  const queue = new ByteQueue();
  const iterator = chunks[Symbol.asyncIterator]();
  let done = false;

  async function fill(count: number): Promise<boolean> {
    while (queue.available < count && !done) {
      const next = await iterator.next();
      if (next.done === true) done = true;
      else queue.push(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
    }
    return queue.available >= count;
  }

  let longName: string | undefined;
  while (await fill(BLOCK)) {
    const header = queue.take(BLOCK);
    if (header.every((b) => b === 0)) return; // end-of-archive marker
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const prefix =
      header.subarray(257, 262).toString("latin1") === "ustar" ? cString(header, 345, 155) : "";
    const name = cString(header, 0, 100);
    const path = longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name);

    if (type === "L" || type === "x") {
      if (!(await fill(padded))) throw new Error("tar: truncated long-name record");
      const body = queue.take(padded).subarray(0, size);
      longName = type === "L" ? cString(body, 0, body.length) : paxPath(body);
      continue;
    }
    longName = undefined;

    const isFile = type === "0" || type === "\0";
    if (!(await fill(padded))) throw new Error(`tar: truncated entry ${path}`);
    if (isFile && want(path)) {
      const data = queue.take(padded).subarray(0, size);
      yield { path, data };
    } else {
      queue.skip(padded);
    }
  }
  if (queue.available > 0) throw new Error("tar: trailing partial block");
}
