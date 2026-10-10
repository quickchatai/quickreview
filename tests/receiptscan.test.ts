// The receipt scan's index. A plain `readFileSync(file, "utf8").includes(marker)`
// per in-scope file, per query, blocks the event loop for as long as reconcile
// keeps asking. These pin that the index answers EXACTLY what that plain scan
// answers (the receipt rule: present / absent / unknown, same scope), and that
// it reads each byte once, in chunks, with a real event-loop turn between them.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReceiptIndex, indexableMarker } from "../src/receiptscan.js";
import { recheckPromptMarker, roundPromptMarker } from "../src/types.js";
import { sessionCommandMarker } from "../src/session-command.js";

let root: string;
/** An hour ago: every file a test writes now is in scope unless it says not. */
const SINCE = Date.now() - 60 * 60_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-receipts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** One JSONL line as pi writes an accepted user message: the marker inside a
 * JSON string, so it rides JSON encoding the way it does live. */
const userLine = (text: string): string =>
  `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const filler = (bytes: number): string => {
  const line = `${JSON.stringify({ type: "toolResult", text: "x".repeat(200) })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
};

/** The reference answer — a plain read-and-includes — for the equivalence checks. */
function oldAnswer(files: string[], marker: string): boolean {
  return files.some((f) => readFileSync(f, "utf8").includes(marker));
}

describe("indexableMarker — the token shape the index can answer exactly", () => {
  it("accepts every production marker", () => {
    expect(indexableMarker(roundPromptMarker(5841, 3))).toBe(true);
    expect(
      indexableMarker(
        recheckPromptMarker(5841, `base_advance:${"a".repeat(40)}::${"b".repeat(40)}`),
      ),
    ).toBe(true);
    expect(indexableMarker(sessionCommandMarker("c-0123", "f".repeat(64)))).toBe(true);
  });

  it("refuses anything a token lookup could answer differently from a substring test", () => {
    expect(indexableMarker("plain marker")).toBe(false);
    expect(indexableMarker("<!-- qcr-a --> tail -->")).toBe(false); // suffix twice
    expect(indexableMarker("<!-- qcr-ł -->")).toBe(false); // non-ASCII
    expect(indexableMarker(`<!-- qcr-${"x".repeat(600)} -->`)).toBe(false); // too long
  });
});

describe("ReceiptIndex.present — the old scan's answers", () => {
  it("present, absent and no-evidence, as the old scan read them", async () => {
    const idx = new ReceiptIndex();
    const marker = roundPromptMarker(42, 1);
    // No session dir at all: no evidence.
    expect(await idx.present(join(root, "missing"), marker, SINCE)).toEqual({
      answer: null,
      unreadable: false,
    });
    mkdirSync(root, { recursive: true });
    // A session dir with nothing in scope: no evidence.
    expect((await idx.present(root, marker, SINCE)).answer).toBeNull();
    const f = join(root, "s.jsonl");
    writeFileSync(f, userLine("wake up and finish the review"));
    expect(await idx.present(root, marker, SINCE)).toEqual({ answer: false, unreadable: false });
    appendFileSync(f, userLine(`BODY\n\n${marker}\n`));
    expect(await idx.present(root, marker, SINCE)).toEqual({ answer: true, unreadable: false });
    // Another round's token is not this round's receipt.
    expect((await idx.present(root, roundPromptMarker(42, 2), SINCE)).answer).toBe(false);
  });

  it("keeps the old scope: files last written before since − 60 s are not read", async () => {
    const idx = new ReceiptIndex();
    const marker = roundPromptMarker(42, 1);
    const f = join(root, "old.jsonl");
    writeFileSync(f, userLine(marker));
    const old = new Date(SINCE - 2 * 60 * 60_000);
    utimesSync(f, old, old);
    expect((await idx.present(root, marker, SINCE)).answer).toBeNull();
    // Within the slack it counts.
    const edge = new Date(SINCE - 30_000);
    utimesSync(f, edge, edge);
    expect((await idx.present(root, marker, SINCE)).answer).toBe(true);
  });

  it("walks nested dirs and ignores non-.jsonl files", async () => {
    const idx = new ReceiptIndex();
    const marker = recheckPromptMarker(7, "push:abc");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "notes.txt"), marker);
    expect((await idx.present(root, marker, SINCE)).answer).toBeNull();
    writeFileSync(join(root, "a", "b", "x.jsonl"), userLine(marker));
    expect((await idx.present(root, marker, SINCE)).answer).toBe(true);
  });

  it("an unreadable in-scope file is UNKNOWN, never absence — and the scan goes on past it", async () => {
    const idx = new ReceiptIndex();
    const marker = roundPromptMarker(42, 1);
    // A symlink to a directory: listed as not-a-directory, stats in scope,
    // cannot be read (a fault identical for every uid).
    mkdirSync(join(root, "blocked.d"));
    symlinkSync(join(root, "blocked.d"), join(root, "a-blocked.jsonl"));
    writeFileSync(join(root, "b-readable.jsonl"), userLine("no marker"));
    expect(await idx.present(root, marker, SINCE)).toEqual({ answer: null, unreadable: true });
    writeFileSync(join(root, "c-delivered.jsonl"), userLine(marker));
    expect((await idx.present(root, marker, SINCE)).answer).toBe(true);
  });

  it("answers exactly what `includes` answers over a corpus of near-misses", async () => {
    const idx = new ReceiptIndex({ chunkBytes: 512 });
    const markers = [
      roundPromptMarker(42, 1),
      roundPromptMarker(42, 11),
      recheckPromptMarker(42, "push:abc"),
      recheckPromptMarker(42, "push:abcd"),
      sessionCommandMarker("c1", "e".repeat(64)),
      "plain-substring-marker",
    ];
    const f = join(root, "corpus.jsonl");
    writeFileSync(
      f,
      [
        userLine(`x ${roundPromptMarker(42, 11)} y`),
        userLine("<!-- qcr-round: pr-42 round-1"), // a cut-off token, no suffix
        userLine(`<!-- qcr-nested <!-- qcr-recheck: pr-42 push:abcd -->`),
        filler(3000),
        userLine("ł ą ś — plain-substring-marker — ż"),
        userLine(sessionCommandMarker("c1", "e".repeat(64))),
      ].join(""),
    );
    for (const m of markers)
      expect((await idx.present(root, m, SINCE)).answer, m).toBe(oldAnswer([f], m));
  });
});

describe("ReceiptIndex — each byte read once, in chunks, never one span", () => {
  it("finds a token cut by a chunk boundary", async () => {
    const marker = recheckPromptMarker(9, `base_advance:${"c".repeat(40)}::${"d".repeat(40)}`);
    const f = join(root, "edge.jsonl");
    for (let cut = 1; cut < marker.length; cut += 17) {
      // Place the token so that `cut` of its bytes end the first 512-byte chunk.
      const lead = "y".repeat(512 - cut);
      writeFileSync(f, `${lead}${marker}${"z".repeat(100)}`);
      const idx = new ReceiptIndex({ chunkBytes: 512 });
      expect((await idx.present(root, marker, SINCE)).answer, `cut=${cut}`).toBe(true);
    }
  });

  it("a second query reads nothing; an appended file is read only from where it stopped", async () => {
    const idx = new ReceiptIndex({ chunkBytes: 64 * 1024 });
    const first = recheckPromptMarker(5, "push:aaa");
    const later = recheckPromptMarker(5, "push:bbb");
    const f = join(root, "s.jsonl");
    writeFileSync(f, filler(1 << 20) + userLine(first));
    expect((await idx.present(root, first, SINCE)).answer).toBe(true);
    const afterFirst = idx.stats().bytes_read;
    expect(afterFirst).toBeGreaterThan(1 << 20);
    // The same file again, for another marker: a set lookup, no bytes.
    expect((await idx.present(root, later, SINCE)).answer).toBe(false);
    expect(idx.stats().bytes_read).toBe(afterFirst);
    expect(idx.stats().hits).toBe(1);
    // pi appends: only the new bytes (plus the verified tail) are read.
    const appended = userLine(`x\n\n${later}\n`);
    appendFileSync(f, appended);
    expect((await idx.present(root, later, SINCE)).answer).toBe(true);
    const grew = idx.stats().bytes_read - afterFirst;
    expect(grew).toBeGreaterThanOrEqual(appended.length);
    expect(grew).toBeLessThanOrEqual(appended.length + 511);
    expect(idx.stats()).toMatchObject({ full_scans: 1, incremental_scans: 1 });
    // …and the earlier token is still known.
    expect((await idx.present(root, first, SINCE)).answer).toBe(true);
  });

  it("a file rewritten in place — its tail window changed, or shorter — is rescanned from 0", async () => {
    const idx = new ReceiptIndex();
    const marker = roundPromptMarker(42, 1);
    const f = join(root, "s.jsonl");
    writeFileSync(f, userLine(marker));
    expect((await idx.present(root, marker, SINCE)).answer).toBe(true);
    // Same inode, longer, different bytes: the tail check catches it.
    writeFileSync(f, userLine("a different conversation, longer than the first one was"));
    expect((await idx.present(root, marker, SINCE)).answer).toBe(false);
    expect(idx.stats().full_scans).toBe(2);
    // Shorter: rescanned from 0 too.
    writeFileSync(f, userLine(marker).slice(0, 10));
    expect((await idx.present(root, marker, SINCE)).answer).toBe(false);
  });

  it("a file REPLACED under its name is rescanned even at the same size and mtime", async () => {
    // The hit path trusts an unchanged (dev, ino, size, mtime) without reading
    // a byte; a rename-over gives the name a new inode, and that is checked.
    const idx = new ReceiptIndex();
    const marker = roundPromptMarker(42, 1);
    const f = join(root, "s.jsonl");
    const body = userLine(marker);
    writeFileSync(f, body);
    const at = new Date(Date.now() - 5_000);
    utimesSync(f, at, at);
    expect((await idx.present(root, marker, SINCE)).answer).toBe(true);
    const tmp = join(root, "s.jsonl.tmp");
    writeFileSync(tmp, "x".repeat(body.length - 1) + "\n"); // same size, no token
    utimesSync(tmp, at, at);
    renameSync(tmp, f);
    expect((await idx.present(root, marker, SINCE)).answer).toBe(false);
    expect(idx.stats()).toMatchObject({ full_scans: 2, hits: 0 });
  });

  it("concurrent queries for one cold file share ONE scan", async () => {
    const idx = new ReceiptIndex({ chunkBytes: 64 * 1024 });
    const a = recheckPromptMarker(5, "push:aaa");
    const b = recheckPromptMarker(5, "push:bbb");
    writeFileSync(join(root, "s.jsonl"), filler(2 << 20) + userLine(a));
    const [ra, rb] = await Promise.all([idx.present(root, a, SINCE), idx.present(root, b, SINCE)]);
    expect([ra.answer, rb.answer]).toEqual([true, false]);
    expect(idx.stats().full_scans).toBe(1);
  });

  it("a large file is read as many event-loop turns, not one synchronous span", async () => {
    const chunk = 64 * 1024;
    const idx = new ReceiptIndex({ chunkBytes: chunk });
    const marker = recheckPromptMarker(5, "push:zzz");
    const size = 4 << 20;
    writeFileSync(join(root, "big.jsonl"), filler(size) + userLine(marker));
    let turns = 0;
    let ticking = true;
    const tick = (): void => {
      turns++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const answer = (await idx.present(root, marker, SINCE)).answer;
    ticking = false;
    expect(answer).toBe(true);
    // A turn per chunk read (allowing for reads that land in one iteration):
    // other work ran all through the scan.
    expect(turns).toBeGreaterThanOrEqual(Math.floor(size / chunk / 2));
  });

  it("a marker outside the token shape is streamed and found across chunks too", async () => {
    const idx = new ReceiptIndex({ chunkBytes: 512 });
    const marker = "plain receipt marker";
    writeFileSync(join(root, "s.jsonl"), `${"q".repeat(500)}${marker}${"q".repeat(900)}`);
    expect((await idx.present(root, marker, SINCE)).answer).toBe(true);
    expect((await idx.present(root, "absent marker", SINCE)).answer).toBe(false);
  });
});
