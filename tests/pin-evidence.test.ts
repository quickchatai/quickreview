// D29 evidence map (P9.8a): every VERIFY-ON-PIN tag in the tree belongs to a map
// entry, and scripts/pin-evidence.mjs reports evidence from an extract.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "pin-evidence.mjs");
const extract = join(root, "tests", "fixtures", "pin-evidence", "extract.jsonl");

interface Entry {
  id: string;
  files: Record<string, number>;
  signal: { kind: "jsonl" | "log" | "gap" };
}
const map = JSON.parse(readFileSync(join(root, "scripts", "pin-evidence-map.json"), "utf8")) as {
  entries: Entry[];
};

const SCANNED = ["src", "extensions", "tests", "docker", "config.example.toml", "tsconfig.json"];
const SKIPPED = new Set(["node_modules", "dist", "patches", "fixtures"]);
// Prose about the convention, not a tag on an assumption.
const NOT_TAGS = new Set(["src/CLAUDE.md", "tests/pin-evidence.test.ts"]);

function walk(p: string, out: string[]): void {
  if (!statSync(p).isDirectory()) {
    out.push(p);
    return;
  }
  for (const n of readdirSync(p)) if (!SKIPPED.has(n)) walk(join(p, n), out);
}

function tagCounts(): Record<string, number> {
  const files: string[] = [];
  for (const s of SCANNED) walk(join(root, s), files);
  files.push(join(root, "tests", "fixtures", "config.toml"));
  const counts: Record<string, number> = {};
  for (const f of files) {
    const rel = relative(root, f);
    if (NOT_TAGS.has(rel)) continue;
    let n = 0;
    try {
      n = readFileSync(f, "utf8").split("VERIFY-ON-PIN").length - 1;
    } catch {
      continue;
    }
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

describe("VERIFY-ON-PIN evidence map", () => {
  it("covers every tag in the tree, file by file", () => {
    const mapped: Record<string, number> = {};
    for (const e of map.entries)
      for (const [f, n] of Object.entries(e.files)) {
        expect(mapped[f], `${f} appears in two entries`).toBeUndefined();
        mapped[f] = n;
      }
    expect(mapped).toEqual(tagCounts());
  });

  it("gives every entry a unique id and a signal", () => {
    const ids = map.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of map.entries) expect(["jsonl", "log", "gap"]).toContain(e.signal.kind);
  });

  it("reports evidence from a faux extract and none from an empty one", () => {
    const rows = JSON.parse(
      execFileSync("node", [script, extract, "--json"], { encoding: "utf8" }),
    ) as {
      id: string;
      status: string;
    }[];
    const by = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(by["pi-argv-session"]).toBe("live");
    expect(by["inject-bridge-delivery"]).toBe("live");
    expect(by["ledger-pin-compaction"]).toBe("live");
    expect(by["oauth-refresh"]).toBe("live");
    expect(by["usage-and-price"]).toBe("live");
    expect(by["lens-prefix-cache"]).toBe("none");
    expect(by["guard-tool-call-fields"]).toBe("none");
    expect(by["pi-builtins"]).toBe("gap");
  });

  it("--require-all fails while a group lacks evidence", () => {
    expect(() =>
      execFileSync("node", [script, extract, "--require-all"], { stdio: "pipe" }),
    ).toThrow();
  });
});
