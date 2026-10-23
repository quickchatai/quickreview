import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { BUNDLE_RECORD_MAX_BYTES } from "../src/archive/bundle.js";
import { emptyManifest, writeManifest } from "../src/archive/manifest.js";
import * as manifests from "../src/archive/manifest.js";
import { SpanMeter } from "../src/archive/prfiles.js";
import { archiveRow } from "../src/archive/rows.js";
import {
  onArchiver,
  prFixture,
  manifestOf,
  put,
  sha,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const fixtures: PrFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
const fixture = (): PrFixture => {
  const f = prFixture();
  fixtures.push(f);
  return f;
};

it(
  "streams an oversized ledger snapshot, keeps it live, and never restores it",
  { timeout: HEAVY_TIMEOUT_MS },
  async () => {
    const f = fixture();
    const rel = `state/ledgers/pr-${f.pr}.md`;
    const bytes = Buffer.alloc(BUNDLE_RECORD_MAX_BYTES + 1, 120);
    writeFileSync(join(f.root, rel), bytes);
    const a = onArchiver(f);
    try {
      expect((await a.tick()).state).toBe("idle");
      const entry = manifestOf(f).entries.find((e) => e.kind === "file" && e.source === rel);
      expect(entry).toMatchObject({ snapshot: true, class: "ledger", bytes: bytes.length });
      expect(entry?.source_removed_at).toBeUndefined();
      expect(readFileSync(join(f.root, rel)).equals(bytes)).toBe(true);
      expect(
        gunzipSync(
          readFileSync(join(f.root, "archive", `pr-${f.pr}`, String(entry?.archive))),
        ).equals(bytes),
      ).toBe(true);
      expect(archiveRow(f.store, f.pr)?.state_files).toBe(f.small.length);
      await a.tick();
      expect(
        manifestOf(f).entries.filter((e) => e.kind === "file" && e.source === rel),
      ).toHaveLength(1);
      unlinkSync(join(f.root, rel));
      await a.operatorRestore(f.pr);
      expect(existsSync(join(f.root, rel))).toBe(false);
    } finally {
      a.stop();
    }
  },
);

it.each([true, false])(
  "retains oversized command metadata and its hash audit (%s)",
  { timeout: HEAVY_TIMEOUT_MS },
  async (matches) => {
    const f = fixture();
    const rel = `state/session-commands/cmd-${f.pr}-1.md`;
    const bytes = Buffer.alloc(BUNDLE_RECORD_MAX_BYTES + 1, 121);
    writeFileSync(join(f.root, rel), bytes);
    f.store.db
      .prepare("UPDATE session_commands SET payload_sha256 = ? WHERE payload_path = ?")
      .run(matches ? sha(bytes) : "different", join(f.root, rel));
    const a = onArchiver(f);
    try {
      expect((await a.tick()).state).toBe("idle");
      const entry = manifestOf(f).entries.find((e) => e.kind === "file" && e.source === rel);
      expect(entry).toMatchObject({
        session_command: {
          id: `cmd-${f.pr}-1`,
          kind: "round",
          round_no: 1,
          status: "acked",
          payload_sha256_ok: matches,
        },
      });
      expect(existsSync(join(f.root, rel))).toBe(false);
      await a.operatorRestore(f.pr);
      expect(readFileSync(join(f.root, rel)).equals(bytes)).toBe(true);
    } finally {
      a.stop();
    }
  },
);

it("passes the archiver's span meter through every PR manifest commit", async () => {
  const f = fixture();
  const writes = vi.spyOn(manifests, "writeManifest");
  const a = onArchiver(f);
  try {
    await a.tick();
    expect(writes.mock.calls.length).toBeGreaterThan(0);
    for (const call of writes.mock.calls) expect(call[3]).toBeInstanceOf(SpanMeter);
  } finally {
    a.stop();
  }
});

it.each(["ledger", "command"] as const)(
  "recovers an oversized %s gzip renamed before its manifest commit",
  { timeout: HEAVY_TIMEOUT_MS },
  async (kind) => {
    const f = fixture();
    const rel =
      kind === "ledger" ? `state/ledgers/pr-${f.pr}.md` : `state/session-commands/cmd-${f.pr}-1.md`;
    const bytes = Buffer.alloc(BUNDLE_RECORD_MAX_BYTES + 1, 122);
    writeFileSync(join(f.root, rel), bytes);
    f.store.db
      .prepare("UPDATE session_commands SET payload_sha256 = ? WHERE payload_path = ?")
      .run(sha(bytes), join(f.root, rel));
    let interrupted = false;
    const a = onArchiver(
      f,
      {},
      {
        step: (name, info) => {
          if (
            !interrupted &&
            name === "renamed" &&
            String(info.dest).endsWith(`/files/${rel}.gz`)
          ) {
            interrupted = true;
            throw new Error("crash after gzip rename");
          }
        },
      },
    );
    try {
      await a.tick();
      expect(interrupted).toBe(true);
      expect(existsSync(join(f.root, rel))).toBe(true);
      a.stop();
      const recovered = onArchiver(f);
      try {
        expect((await recovered.tick()).state).toBe("idle");
      } finally {
        recovered.stop();
      }
      const entries = manifestOf(f).entries.filter((e) => e.kind === "file" && e.source === rel);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject(
        kind === "ledger"
          ? { snapshot: true, class: "ledger" }
          : { session_command: { payload_sha256_ok: true } },
      );
      expect(existsSync(join(f.root, rel))).toBe(kind === "ledger");
    } finally {
      a.stop();
    }
  },
);

it("measures manifest validation and serialization within the supplied synchronous span", async () => {
  const f = fixture();
  const meter = new SpanMeter();
  const measure = vi.spyOn(meter, "measure");
  const prev = emptyManifest("pr-1");
  const next = { ...prev, passes: [{ id: "one", kind: "archive" as const, started_at: null }] };
  put(f.root, "archive/pr-1/keep", "");
  await writeManifest(join(f.root, "archive", "pr-1"), prev, next, meter);
  expect(measure).toHaveBeenCalledOnce();
});
