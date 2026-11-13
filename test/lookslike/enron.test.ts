import { describe, expect, it } from "vitest";
import {
  decodeQuotedPrintable,
  type IndexedMessage,
  isMessagePath,
  parseEnronMessage,
  selectOrdinarySample,
} from "../../scripts/lib/lookslike/enron.ts";
import { readTar, type TarFile } from "../../scripts/lib/lookslike/tar.ts";

const BLOCK = 512;

/** One ustar entry: a header block plus the data padded to whole blocks. */
function tarEntry(path: string, data: string | Buffer, type = "0"): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const header = Buffer.alloc(BLOCK);
  header.write(path, 0, 100, "utf8");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write(type, 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

const END = Buffer.alloc(BLOCK * 2);

/** Feeds the archive in awkward chunk sizes, so reads straddle block boundaries. */
async function* chunked(archive: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < archive.length; i += size) yield archive.subarray(i, i + size);
}

async function collect(archive: Buffer, want: (path: string) => boolean, size = 7) {
  const files: TarFile[] = [];
  for await (const file of readTar(chunked(archive, size), want)) files.push(file);
  return files.map((f) => ({ path: f.path, text: f.data.toString("utf8") }));
}

describe("readTar", () => {
  const archive = Buffer.concat([
    tarEntry("maildir/allen-p/", "", "5"),
    tarEntry("maildir/allen-p/inbox/1.", "first message"),
    tarEntry("maildir/allen-p/inbox/2.", "x".repeat(BLOCK + 3)),
    tarEntry("maildir/allen-p/notes.txt", "skip me"),
    END,
  ]);

  it("yields the wanted files with their exact bytes, across odd chunk boundaries", async () => {
    for (const size of [1, 7, 511, 513, archive.length]) {
      expect(await collect(archive, isMessagePath, size)).toEqual([
        { path: "maildir/allen-p/inbox/1.", text: "first message" },
        { path: "maildir/allen-p/inbox/2.", text: "x".repeat(BLOCK + 3) },
      ]);
    }
  });

  it("never yields a directory, even when every path is wanted", async () => {
    const files = await collect(archive, () => true);
    expect(files.map((f) => f.path)).toEqual([
      "maildir/allen-p/inbox/1.",
      "maildir/allen-p/inbox/2.",
      "maildir/allen-p/notes.txt",
    ]);
  });

  it("reads GNU long names", async () => {
    const long = `maildir/${"a".repeat(120)}/inbox/1.`;
    const withLongName = Buffer.concat([
      tarEntry("././@LongLink", `${long}\0`, "L"),
      tarEntry(long.slice(0, 100), "long"),
      END,
    ]);
    expect(await collect(withLongName, () => true)).toEqual([{ path: long, text: "long" }]);
  });

  it("throws on a truncated archive rather than yielding a partial file", async () => {
    const truncated = tarEntry("maildir/a/inbox/1.", "y".repeat(2000)).subarray(0, BLOCK + 100);
    await expect(collect(truncated, () => true)).rejects.toThrow("tar: truncated entry");
  });

  it("throws on trailing bytes that aren't a whole block", async () => {
    const ragged = Buffer.concat([tarEntry("maildir/a/inbox/1.", "z"), Buffer.alloc(10, 1)]);
    await expect(collect(ragged, () => true)).rejects.toThrow("tar: trailing partial block");
  });
});

describe("parseEnronMessage", () => {
  const raw = [
    "Message-ID: <1.JavaMail.evans@thyme>",
    "From: phillip.allen@enron.com",
    "Subject: Re: west desk",
    "  curve update",
    "Subject: ignored duplicate",
    "X-From: Phillip K Allen",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Price is =3D 5.2=",
    "0 today.",
  ].join("\r\n");

  it("unfolds headers, keeps the first duplicate and decodes quoted-printable", () => {
    expect(parseEnronMessage("maildir/allen-p/inbox/1.", Buffer.from(raw, "latin1"))).toEqual({
      path: "maildir/allen-p/inbox/1.",
      user: "allen-p",
      subject: "Re: west desk curve update",
      from: "Phillip K Allen <phillip.allen@enron.com>",
      body: "Price is = 5.20 today.",
    });
  });

  it("decodeQuotedPrintable joins soft breaks and decodes hex escapes", () => {
    expect(decodeQuotedPrintable("caf=E9 =\nau lait")).toBe("café au lait");
  });

  it("isMessagePath accepts maildir message files only", () => {
    expect(isMessagePath("maildir/allen-p/inbox/1.")).toBe(true);
    expect(isMessagePath("maildir/allen-p/")).toBe(false);
    expect(isMessagePath("maildir/allen-p/inbox/")).toBe(false);
    expect(isMessagePath("README")).toBe(false);
  });
});

describe("selectOrdinarySample", () => {
  const users = Array.from({ length: 12 }, (_, i) => `user-${i}`);
  const index: IndexedMessage[] = users.flatMap((user) =>
    Array.from({ length: 20 }, (_, n) => ({
      path: `maildir/${user}/inbox/${n}.`,
      user,
      contentHash: `${user}-${n}`,
    })),
  );
  // The same text filed in two mailboxes: only its first path may be sampled.
  const shared = { path: "maildir/user-0/sent/0.", user: "user-0", contentHash: "shared" };
  const copy = { path: "maildir/user-9/inbox/99.", user: "user-9", contentHash: "shared" };
  const selection = { seed: "test", heldOutUserShare: 0.4, trainCount: 50, heldOutCount: 30 };
  const sample = selectOrdinarySample([copy, ...index, shared], selection);

  it("never puts one mailbox owner's mail on both sides", () => {
    const trainUsers = new Set(sample.train.map((m) => m.user));
    expect(sample.heldOut.filter((m) => trainUsers.has(m.user))).toEqual([]);
    expect(sample.train.length).toBe(50);
    expect(sample.heldOut.length).toBeGreaterThan(0);
  });

  it("samples each text once, from its first path", () => {
    const all = [...sample.train, ...sample.heldOut];
    expect(new Set(all.map((m) => m.contentHash)).size).toBe(all.length);
    expect(all.some((m) => m.path === copy.path)).toBe(false);
  });

  it("is deterministic and independent of index order", () => {
    expect(selectOrdinarySample([...index, shared, copy].reverse(), selection)).toEqual(sample);
  });
});
