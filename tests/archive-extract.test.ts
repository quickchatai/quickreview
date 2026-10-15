// `qcr archive extract <pr> --to <dir>` (docs/archiving.md §11,
// §15):
//
//   (2) extract writes files byte-identical (by sha256) to a scratch dir, and
//       refuses a --to under <root>/state, the pi-sessions root, inject/ or
//       archive/ — and one that would contain them, symlinks resolved.
//
// Plus: it is read-only over the archive; a re-run is idempotent and never
// overwrites a different file; a gzip that does not decompress to its
// recorded bytes is reported and leaves no partial behind; a missing manifest
// is never "nothing archived" when archive files sit there; and a tampered
// manifest cannot write outside --to.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractPr, liveTreeRefusal } from "../src/archive/extract.js";
import { archiveManifestLine, whyJson } from "../src/cli.js";
import { archiveRow } from "../src/archive/rows.js";
import {
  filesUnder,
  manifestOf,
  onArchiver,
  prFixture,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const open: PrFixture[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function archivedFixture(): Promise<PrFixture> {
  const f = prFixture();
  open.push(f);
  const a = onArchiver(f);
  await a.tick();
  a.stop();
  expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
  return f;
}

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-extract-"));
  scratch.push(d);
  return join(d, "out");
}

const opts = (f: PrFixture, to: string) => ({
  root: f.root,
  sessionsRoot: join(f.root, "state", "pi-sessions"),
  pr: f.pr,
  to,
  bytesPerS: 200 * 1024 * 1024,
});

/** Every file under `dir` with its sha256. */
const tree = (dir: string): Map<string, string> =>
  new Map(filesUnder(dir).map((p) => [p, sha(readFileSync(join(dir, p)))]));

describe("extraction is byte-identical (acceptance 2)", () => {
  it(
    "every archived byte lands in the scratch dir, sha256-equal to the original — and the archive is untouched",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const archiveDir = join(f.root, "archive", `pr-${f.pr}`);
      const before = tree(archiveDir);
      const to = scratchDir();
      const r = await extractPr(opts(f, to));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.errors).toEqual([]);
      expect(r.files.every((x) => x.outcome === "written")).toBe(true);
      // The transcripts, by their archive names, decompressed.
      const sdir = `state/pi-sessions/pr-${f.pr}/`;
      for (const rel of f.transcripts) {
        const out = join(to, "transcripts", rel.slice(sdir.length));
        expect(sha(readFileSync(out)), rel).toBe(sha(f.bytes.get(rel)!));
        // The original mtime rides along.
        expect(statSync(out).mtimeMs).toBe(f.mtimes.get(rel));
      }
      // Every small file at its live path under its bundle's dir — the
      // binary pass output and the same_as payload included.
      const bundle = readdirSync(to).find((n) => n.startsWith("state-"))!;
      expect(bundle).toBeDefined();
      for (const rel of f.small)
        expect(sha(readFileSync(join(to, bundle, rel))), rel).toBe(sha(f.bytes.get(rel)!));
      // Every extracted file's recorded sha256 is the file's.
      for (const x of r.files) expect(sha(readFileSync(join(to, x.path))), x.path).toBe(x.sha256);
      // The plain record is copied as it is.
      expect(r.copied.sort()).toEqual(["ledger.md", "manifest.json", "meta.json"]);
      expect(readFileSync(join(to, "manifest.json"), "utf8")).toBe(
        readFileSync(join(archiveDir, "manifest.json"), "utf8"),
      );
      // Read-only over the archive, and nothing left half-written.
      expect(tree(archiveDir)).toEqual(before);
      expect(filesUnder(to).filter((p) => p.endsWith(".extract-partial"))).toEqual([]);
    },
  );

  it(
    "a re-run is idempotent; a different file at a target is reported, never overwritten",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const to = scratchDir();
      await extractPr(opts(f, to));
      const again = await extractPr(opts(f, to));
      expect(again.ok && again.errors).toEqual([]);
      expect(again.ok && again.files.every((x) => x.outcome === "present")).toBe(true);
      const victim = join(to, "transcripts", f.transcripts[0]!.split("/").pop()!);
      writeFileSync(victim, "the analyst's own edit\n");
      const third = await extractPr(opts(f, to));
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      expect(third.errors).toEqual([
        expect.objectContaining({ error: expect.stringContaining("never overwritten") }),
      ]);
      expect(readFileSync(victim, "utf8")).toBe("the analyst's own edit\n");
    },
  );

  it(
    "a gzip that does not decompress to its recorded bytes is reported; the rest still extract, no partial left",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const m = manifestOf(f);
      const first = m.entries.find((e) => e.kind === "transcript")!;
      writeFileSync(join(f.root, "archive", `pr-${f.pr}`, first.archive as string), "garbage");
      const to = scratchDir();
      const r = await extractPr(opts(f, to));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.path).toBe((first.archive as string).replace(/\.gz$/, ""));
      expect(existsSync(join(to, r.errors[0]!.path))).toBe(false);
      expect(r.files.length).toBeGreaterThan(f.small.length);
      expect(filesUnder(to).filter((p) => p.endsWith(".extract-partial"))).toEqual([]);
    },
  );
});

describe("every byte is checked against the manifest's sha256", () => {
  it(
    "a gzip that decompresses cleanly to OTHER bytes (swapped, tampered) is reported and not written",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const m = manifestOf(f);
      const first = m.entries.find((e) => e.kind === "transcript")!;
      writeFileSync(
        join(f.root, "archive", `pr-${f.pr}`, first.archive as string),
        gzipSync(Buffer.from("other bytes\n")),
      );
      const to = scratchDir();
      const r = await extractPr(opts(f, to));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rel = (first.archive as string).replace(/\.gz$/, "");
      expect(r.errors).toEqual([
        { path: rel, error: expect.stringContaining("the manifest records") },
      ]);
      expect(existsSync(join(to, rel))).toBe(false);
      expect(r.files.some((x) => x.path === rel)).toBe(false);
      expect(filesUnder(to).filter((p) => p.endsWith(".extract-partial"))).toEqual([]);
    },
  );

  it(
    "a bundle record whose bytes the manifest does not record (sha256 or length) is reported and not written",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const manifestFile = join(f.root, "archive", `pr-${f.pr}`, "manifest.json");
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        entries: Array<{ kind: string; archive: string; files?: Array<Record<string, unknown>> }>;
      };
      const bundle = m.entries.find((e) => e.kind === "bundle")!;
      const [a, b] = bundle.files!;
      a!.sha256 = "0".repeat(64);
      b!.bytes = (b!.bytes as number) + 1;
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 1)}\n`);
      const to = scratchDir();
      const r = await extractPr(opts(f, to));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const dir = bundle.archive.replace(/\.jsonl\.gz$/, "");
      const bad = [a!.path as string, b!.path as string].map((p) => join(dir, p)).sort();
      expect(r.errors.map((e) => e.path).sort()).toEqual(bad);
      for (const e of r.errors) expect(e.error).toContain("the manifest records");
      for (const p of bad) expect(existsSync(join(to, p)), p).toBe(false);
      // Every other record still extracts, verified.
      expect(r.files.filter((x) => x.from === bundle.archive)).toHaveLength(
        bundle.files!.length - 2,
      );
    },
  );
});

describe("never into a live tree (acceptance 2)", () => {
  it("refuses --to under state/, the pi sessions root, inject/, archive/ — or the root — and writes nothing", async () => {
    const f = await archivedFixture();
    const sessions = join(f.root, "state", "pi-sessions");
    for (const to of [
      join(f.root, "state", "x"),
      join(f.root, "state"),
      join(sessions, "pr-1", "y"),
      join(f.root, "inject", "z"),
      join(f.root, "inject"),
      join(f.root, "archive", `pr-${f.pr}`, "out"),
      join(f.root, "archive"),
      join(f.root, "elsewhere-in-the-checkout"),
      f.root,
      join(f.root, ".."),
      "/",
    ]) {
      const r = await extractPr(opts(f, to));
      expect(r.ok, to).toBe(false);
      if (!r.ok) expect(r.reason, to).toMatch(/never goes into a live tree/);
    }
    expect(existsSync(join(f.root, "state", "x"))).toBe(false);
    expect(existsSync(join(f.root, "inject", "z"))).toBe(false);
    expect(existsSync(join(f.root, "elsewhere-in-the-checkout"))).toBe(false);
  });

  it("a pi sessions root outside the sandbox root is refused too", async () => {
    const f = await archivedFixture();
    const outside = mkdtempSync(join(tmpdir(), "qcr-extract-sessions-"));
    scratch.push(outside);
    const r = await extractPr({ ...opts(f, join(outside, "pr-9")), sessionsRoot: outside });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("pi sessions root") });
  });

  it("symlinks are resolved: a scratch path that leads into state/ is refused", async () => {
    const f = await archivedFixture();
    const d = mkdtempSync(join(tmpdir(), "qcr-extract-link-"));
    scratch.push(d);
    symlinkSync(join(f.root, "state"), join(d, "sneaky"));
    expect(
      await liveTreeRefusal(join(d, "sneaky", "out"), f.root, join(f.root, "state", "pi-sessions")),
    ).toMatch(/inside state\//);
    expect(
      await liveTreeRefusal(join(d, "fine"), f.root, join(f.root, "state", "pi-sessions")),
    ).toBeNull();
  });
});

describe("below --to, no link is followed", () => {
  it(
    "a symlinked subdirectory of --to is refused per file: nothing written through it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const to = scratchDir();
      const elsewhere = mkdtempSync(join(tmpdir(), "qcr-extract-elsewhere-"));
      scratch.push(elsewhere);
      mkdirSync(to, { recursive: true });
      symlinkSync(elsewhere, join(to, "transcripts"));
      const r = await extractPr(opts(f, to));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(readdirSync(elsewhere)).toEqual([]);
      const refused = r.errors.filter((e) => e.path.startsWith("transcripts/"));
      expect(refused.length).toBeGreaterThan(0);
      for (const e of refused) expect(e.error).toMatch(/not a plain directory/);
      // Everything not under the link still extracts.
      expect(r.files.some((x) => x.path.startsWith("state-"))).toBe(true);
      expect(r.copied).toContain("manifest.json");
    },
  );

  it("a leftover link at a partial's name is removed, never written through", async () => {
    const f = await archivedFixture();
    const to = scratchDir();
    const victim = join(mkdtempSync(join(tmpdir(), "qcr-extract-victim-")), "keep.txt");
    scratch.push(dirname(victim));
    writeFileSync(victim, "precious\n");
    mkdirSync(to, { recursive: true });
    symlinkSync(victim, join(to, "manifest.json.extract-partial"));
    const r = await extractPr(opts(f, to));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(r.copied).toContain("manifest.json");
    expect(existsSync(join(to, "manifest.json.extract-partial"))).toBe(false);
  });
});

describe("what extract will not pretend", () => {
  it("no manifest and no archive files: nothing archived; archive files without one: unknown", async () => {
    const f = prFixture();
    open.push(f);
    const r = await extractPr(opts(f, scratchDir()));
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("nothing of it was archived"),
    });
    const g = await archivedFixture();
    rmSync(join(g.root, "archive", `pr-${g.pr}`, "manifest.json"));
    const r2 = await extractPr(opts(g, scratchDir()));
    expect(r2).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be verified") });
  });

  it("an unreadable manifest is refused, never read as empty", async () => {
    const f = await archivedFixture();
    writeFileSync(join(f.root, "archive", `pr-${f.pr}`, "manifest.json"), "{not json");
    expect(await extractPr(opts(f, scratchDir()))).toMatchObject({ ok: false });
  });

  it("a tampered manifest cannot write outside --to", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    const f = await archivedFixture();
    const path = join(f.root, "archive", `pr-${f.pr}`, "manifest.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    const t = m.entries.find((e: { kind: string }) => e.kind === "transcript");
    t.archive = "../../../../escape.jsonl.gz";
    const b = m.entries.find((e: { kind: string }) => e.kind === "bundle");
    b.files[0].path = "../../escape-record";
    writeFileSync(path, JSON.stringify(m));
    const root = mkdtempSync(join(tmpdir(), "qcr-extract-escape-"));
    scratch.push(root);
    const to = join(root, "a", "b", "out");
    const r = await extractPr(opts(f, to));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.errors.map((e) => e.error)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unsafe archive name"),
        expect.stringContaining("unsafe record path"),
      ]),
    );
    expect(filesUnder(root).every((p) => p.startsWith("a/b/out/"))).toBe(true);
  });
});

describe("qcr why carries the manifest summary", () => {
  it(
    "the ledger as before, plus what the archive holds and what left the live tree",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archivedFixture();
      const dir = join(f.root, "archive", `pr-${f.pr}`);
      const why = whyJson(f.store, f.pr, dir);
      expect(why.ledger).toBe("## Ledger\nSETTLED: nothing\n");
      expect(why.archive).toEqual(
        expect.arrayContaining(["ledger.md", "meta.json", "manifest.json"]),
      );
      expect(why.archive_manifest).toMatchObject({
        state: "read",
        passes: 1,
        transcripts: f.transcripts.length,
        bundles: 1,
        records: f.small.length + 1, // + the ledger snapshot
        sources_removed: f.transcripts.length + f.small.length,
        restores: 0,
      });
      const line = archiveManifestLine(why.archive_manifest!);
      expect(line).toMatch(/^archive manifest: 1 pass\(es\), last 2026-/);
      expect(line).toContain(`${f.transcripts.length} transcript(s)`);
      // A restore is counted, and survives the JSON round trip (the TUI's transport).
      await onArchiver(f).operatorRestore(f.pr);
      const again = JSON.parse(JSON.stringify(whyJson(f.store, f.pr, dir)));
      expect(again.archive_manifest).toMatchObject({ state: "read", restores: 1 });
    },
  );

  it("no manifest: no summary; an unreadable one says so — never read as nothing", async () => {
    const f = prFixture();
    open.push(f);
    const dir = join(f.root, "archive", `pr-${f.pr}`);
    expect(whyJson(f.store, f.pr, dir).archive_manifest).toBeUndefined();
    writeFileSync(join(dir, "manifest.json"), "{torn");
    const why = whyJson(f.store, f.pr, dir);
    expect(why.archive_manifest).toMatchObject({ state: "unreadable" });
    expect(archiveManifestLine(why.archive_manifest!)).toMatch(/^archive manifest: UNREADABLE/);
    expect(why.ledger).toBe("## Ledger\nSETTLED: nothing\n");
  });
});
