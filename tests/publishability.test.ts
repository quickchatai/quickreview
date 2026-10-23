// The publishability lint — "scrubbed" as a permanent, green-or-red property
// of every commit instead of a one-time cleanup. The repository is public in
// full, so the lint walks every tracked file (`git ls-files`) and asserts:
//
//   (a) no private token in any tracked text file. The repository ships no
//       private token, not even as a digest: the maintainers' denylist is
//       read at run time from a file outside it (tests/helpers/private-tokens.ts),
//       and without that file this check skips with the reason. The one
//       exemption channel is the ALLOWLIST below: each entry names the file,
//       the kinds of token granted, and the reason. Checks that need no
//       private list always run: no credential-shaped string, no tracked
//       denylist, and the local-only files (the operator's config, the VM
//       inventory, agent worktrees) are never tracked;
//   (b) LICENSE and THIRD-PARTY-NOTICES.md exist and are non-trivial;
//   (c) config.example.toml exists and passes full config validation (the
//       example-config suite in tests/config.test.ts owns the deeper
//       assertions);
//   (d) no tracked file under the runtime state directories except .gitkeep
//       markers and memory/README.md;
//   (e) a NEGATIVE control: the same scanner, fed planted canary tokens from
//       a test-only denylist file, reports the violations — the lint
//       demonstrably bites, with or without the maintainers' list;
//   (f) no tracked Markdown file links to an untracked or missing path
//       (tests/helpers/published-links.ts), with its own negative control.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isBinaryContent } from "../src/setup/textsniff.js";
import { deadLinks } from "./helpers/published-links.js";
import {
  HOME_LABEL,
  HOST_LABEL,
  loadDenylist,
  parseDenylist,
  PRIVATE_SKIP,
  PRIVATE_TOKENS,
  privateTokenHits,
  type TokenTables,
} from "./helpers/private-tokens.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The label the denylist gives the owner's name, so the ALLOWLIST can grant it.
const OWNER_NAME = "the owner's first name";
const skipped = (name: string): string =>
  PRIVATE_TOKENS ? name : `${name} (skipped: ${PRIVATE_SKIP})`;

// ---------------------------------------------------------------------------
// The allowlist — the ONLY sanctioned in-tree carriers of a private token.
// Every entry names the file, the kinds of token granted (the helper's
// labels), and the reason. An entry whose file is gone, or which no longer
// carries a granted kind, FAILS the hygiene check below — the allowlist
// cannot silently go stale.
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  path: string;
  labels: string[];
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    path: "bench/aacr/paper/benchmark.tex",
    labels: [OWNER_NAME],
    reason: "the paper's author line and self-citation carry the author's full name, by decision",
  },
  {
    path: "bench/aacr/paper/quickreview.tex",
    labels: [OWNER_NAME],
    reason: "the paper's author line and self-citation carry the author's full name, by decision",
  },
  {
    path: "bench/aacr/hf/card.md",
    labels: [OWNER_NAME],
    reason: "the dataset card's citations name the papers' author",
  },
  {
    path: "CODE_OF_CONDUCT.md",
    labels: [OWNER_NAME],
    reason: "the conduct reports go to the maintainer's own address, by decision",
  },
];

function allowlisted(path: string, label: string): boolean {
  return ALLOWLIST.some((e) => e.path === path && e.labels.includes(label));
}

// ---------------------------------------------------------------------------
// The scanner — pure over (path, text) pairs so the negative control can
// prove it bites without touching the working tree.
// ---------------------------------------------------------------------------

interface Violation {
  path: string;
  label: string;
  line: number;
  text: string;
}

function scanFiles(
  files: { path: string; text: string }[],
  tables: TokenTables | null = PRIVATE_TOKENS,
): Violation[] {
  const violations: Violation[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    for (const { line, label } of privateTokenHits(text, tables)) {
      if (allowlisted(path, label)) continue;
      violations.push({ path, label, line, text: lines[line - 1]!.trim().slice(0, 160) });
    }
  }
  return violations;
}

// Credential shapes: checked everywhere, with no private list. A test's fake
// credential is the one sanctioned carrier, by file.
const CREDENTIAL_SHAPES: Array<[string, RegExp]> = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9_-]{32,}/],
  ["a Slack token", /\bxox[abpr]-[0-9A-Za-z-]{10,}/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
];
const FAKE_CREDENTIAL_FILES = new Set([
  "tests/collect-secrets.test.ts",
  "tests/onboard-githubapp.test.ts",
  "tests/onboard-llmauth.test.ts",
  "tests/onboard-regressions.test.ts",
  "tests/slack-setup-wizard.test.ts",
  "tests/slack-wire.test.ts",
  "tests/tool-fence.test.ts",
]);

function credentialHits(
  files: { path: string; text: string }[],
  exempt: ReadonlySet<string> = FAKE_CREDENTIAL_FILES,
): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    if (exempt.has(path)) continue;
    text.split("\n").forEach((line, i) => {
      for (const [what, re] of CREDENTIAL_SHAPES)
        if (re.test(line)) out.push(`${path}:${i + 1} [${what}]`);
    });
  }
  return out;
}

// Binary files are exempt from the token sweep.
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".zip",
  ".gz",
  ".sqlite",
  ".db",
  ".node",
  ".wasm",
]);
function isBinary(path: string, buf: Buffer): boolean {
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())) return true;
  // NOT git's bare "any NUL is binary" probe: one literal NUL in a template
  // literal would exempt a whole source file from the token sweep. The shared
  // sniff needs corroboration before it calls a NUL-bearing file binary — the
  // same answer the scan gives.
  return isBinaryContent(buf, path);
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------

function trackedTexts(tracked: string[]): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const path of tracked) {
    // A tracked symlink has no text of its own; its target is scanned at its real path.
    if (lstatSync(join(repoRoot, path)).isSymbolicLink()) continue;
    const buf = readFileSync(join(repoRoot, path));
    if (isBinary(path, buf)) continue;
    files.push({ path, text: buf.toString("utf8") });
  }
  return files;
}

describe("publishability lint", () => {
  const tracked = trackedFiles();

  it.skipIf(!PRIVATE_TOKENS)(skipped("(a) no private token in any tracked text file"), () => {
    const files = trackedTexts(tracked);
    expect(files.length).toBeGreaterThan(500);
    const violations = scanFiles(files);
    const rendered = violations
      .slice(0, 50)
      .map((v) => `${v.path}:${v.line} [${v.label}] ${v.text}`)
      .join("\n");
    expect(
      violations,
      `private tokens in tracked files (fix the file, or add a reasoned ALLOWLIST entry):\n${rendered}`,
    ).toEqual([]);
  });

  it("(a) no credential-shaped string in any tracked text file", () => {
    const files = trackedTexts(tracked);
    expect(files.length).toBeGreaterThan(500);
    const hits = credentialHits(files);
    expect(hits, `credential-shaped strings in tracked files:\n${hits.join("\n")}`).toEqual([]);
    for (const p of FAKE_CREDENTIAL_FILES) {
      const text = readFileSync(join(repoRoot, p), "utf8");
      expect(
        credentialHits([{ path: p, text }], new Set()),
        `${p}: carries no fake credential any more — remove it from FAKE_CREDENTIAL_FILES`,
      ).not.toEqual([]);
    }
  });

  it("(a) the repository tracks no denylist and no digest table of private tokens", () => {
    expect(tracked.filter((p) => /publish-denylist/i.test(p))).toEqual([]);
    const helper = readFileSync(join(repoRoot, "tests/helpers/private-tokens.ts"), "utf8");
    expect(helper).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it("(a) the local-only files are never tracked", () => {
    const LOCAL_ONLY = ["config.toml", "deploy/ansible/inventory.ini", ".claude/worktrees/"];
    for (const p of LOCAL_ONLY) {
      const offenders = tracked.filter((t) => (p.endsWith("/") ? t.startsWith(p) : t === p));
      expect(offenders, `${p} is local-only and must stay untracked`).toEqual([]);
    }
  });

  it("allowlist hygiene: every entry is unique, tracked and reasoned", () => {
    const trackedSet = new Set(tracked);
    const seen = new Set<string>();
    for (const entry of ALLOWLIST) {
      expect(seen.has(entry.path), `${entry.path}: duplicate allowlist entry`).toBe(false);
      seen.add(entry.path);
      expect(trackedSet.has(entry.path), `${entry.path}: allowlisted but not tracked`).toBe(true);
      expect(entry.reason.trim().length, `${entry.path}: reason required`).toBeGreaterThan(10);
    }
  });

  // The maintainers' denylist labels the owner's name OWNER_NAME, so the
  // entries' granted kinds match what the scanner reports.
  it.skipIf(!PRIVATE_TOKENS)(
    skipped("allowlist hygiene: every entry's file still carries a granted kind"),
    () => {
      for (const entry of ALLOWLIST) {
        const carried = new Set(
          privateTokenHits(readFileSync(join(repoRoot, entry.path), "utf8")).map((h) => h.label),
        );
        for (const label of entry.labels) {
          expect(
            carried.has(label),
            `${entry.path}: allowlisted '${label}' no longer occurs — stale entry, remove it`,
          ).toBe(true);
        }
      }
    },
  );

  it("(b) LICENSE exists and is a real license", () => {
    const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
    // MIT is ~1.1KB —
    // the floor guards against an empty/placeholder file, not a long text.
    expect(license.length).toBeGreaterThan(900);
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Quickchat AI");
  });

  it("(b) THIRD-PARTY-NOTICES.md exists and rolls up every vendored component", () => {
    const notices = readFileSync(join(repoRoot, "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notices.length).toBeGreaterThan(1500);
    for (const component of ["openviking-pi", "inline-bash", ".claude/skills"]) {
      expect(notices, `notices must cover ${component}`).toContain(component);
    }
    // Subagents are pi's own first-party extension inside the pinned pi
    // package, loaded from the install path, so nothing is vendored or
    // redistributed. The tree must carry no copy of the unlicensed
    // third-party pi-subagents extension, and the notices must
    // still explain where subagents come from so a license audit finds the
    // answer rather than a gap.
    expect(notices).toMatch(/first-party.{0,200}subagent|subagent.{0,200}first-party/is);
    expect(tracked.some((p) => p.startsWith("extensions/vendor/pi-subagents/"))).toBe(false);
  });

  it("(c) config.example.toml exists and passes full config validation", () => {
    const examplePath = join(repoRoot, "config.example.toml");
    expect(existsSync(examplePath)).toBe(true);
    expect(() => loadConfig(examplePath)).not.toThrow();
    // Safe-defaults spot check; tests/config.test.ts
    // owns the deeper example-config assertions.
    expect(loadConfig(examplePath).dry_run).toBe(true);
  });

  it("(d) no tracked file under the runtime state directories", () => {
    const RUNTIME_DIRS = [
      "state/",
      "inject/",
      "verdict/",
      "commands/",
      "digest/",
      "archive/",
      "memory/",
    ];
    const ALLOWED = new Set(["memory/README.md"]);
    const offenders = tracked.filter((p) => {
      if (!RUNTIME_DIRS.some((d) => p.startsWith(d))) return false;
      if (ALLOWED.has(p)) return false;
      return !p.endsWith("/.gitkeep");
    });
    expect(offenders, "runtime state must never be tracked").toEqual([]);
  });

  it("(e) NEGATIVE control: planted canaries at an unexempted path are caught", () => {
    // The canaries are neutral tokens in a test-only denylist file, read by
    // the same loader as the maintainers' list: one per class, a word (also
    // as a dash-separated part), a home directory and a host name (also as a
    // parent domain).
    const CANARY = "acme-canary-host";
    const dir = mkdtempSync(join(tmpdir(), "qcr-denylist-"));
    let tables: TokenTables | null;
    try {
      const path = join(dir, "publish-denylist.txt");
      writeFileSync(
        path,
        [
          "# test canaries",
          "",
          `${CANARY} the test canary`,
          "user:acme-canary-user",
          "host:canary.example.invalid",
        ].join("\n"),
      );
      tables = loadDenylist(path);
      expect(loadDenylist(join(dir, "absent.txt"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(tables).not.toBeNull();
    const planted = scanFiles(
      [
        {
          path: "src/planted-control.ts",
          text: [
            "const x = 1;",
            `// deployed on ${CANARY}-qc`,
            "// see /home/acme-canary-user/src and -home-acme-canary-user-project",
            "// webhook at https://hooks.canary.example.invalid/x",
          ].join("\n"),
        },
      ],
      tables,
    );
    expect(planted.map((v) => [v.path, v.line, v.label])).toEqual([
      ["src/planted-control.ts", 2, "the test canary"],
      ["src/planted-control.ts", 3, HOME_LABEL],
      ["src/planted-control.ts", 4, HOST_LABEL],
    ]);
    // The canaries are not real tokens: the maintainers' list misses them.
    if (PRIVATE_TOKENS)
      expect(scanFiles([{ path: "src/planted-control.ts", text: CANARY }])).toEqual([]);

    // A malformed denylist line is an error, never a silent miss.
    expect(() => parseDenylist("host:not-dotted")).toThrow(/line 1/);
    expect(() => parseDenylist("# ok\nnope:x")).toThrow(/line 2/);

    // A source file with one stray NUL is still TEXT to the sweep — never
    // exempted as binary.
    const nulSource = Buffer.from("// for the owner\nconst k = `${a}\0${b}`;\n");
    expect(isBinary("src/planted-control.ts", nulSource)).toBe(false);
    expect(isBinary("docs/media/planted.gif", nulSource)).toBe(true);

    // An allowlisted path is granted only its listed kinds.
    expect(
      scanFiles([{ path: "bench/aacr/paper/benchmark.tex", text: CANARY }], tables),
    ).not.toEqual([]);

    // The credential sweep bites too.
    expect(
      credentialHits([
        { path: "src/planted-control.ts", text: `const t = "ghp_${"a".repeat(36)}";` },
      ]),
    ).toEqual(["src/planted-control.ts:1 [a GitHub token]"]);
  });
});

describe("(f) tracked links land on tracked paths", () => {
  const tracked = trackedFiles();

  it("no tracked Markdown file links to an untracked or missing path", () => {
    const files = tracked
      .filter((p) => p.endsWith(".md"))
      .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
    const dead = deadLinks({ tracked, files });
    const rendered = dead
      .slice(0, 80)
      .map((d) => `${d.file}:${d.line} → ${d.target} (${d.resolved})`)
      .join("\n");
    expect(
      dead,
      `${dead.length} dead link(s) — repoint each at a tracked path or an external URL:\n${rendered}`,
    ).toEqual([]);
  });

  it("NEGATIVE control: a link to an untracked path is caught; code and URLs are not read", () => {
    const dead = deadLinks({
      tracked: ["README.md", "docs/a.md", "bench/x/NOTES.md"],
      files: [
        {
          path: "docs/a.md",
          text: [
            "[ok](../README.md) [ok dir](../docs/) [web](https://example.com) [anchor](#top)",
            "[private](private.md#s) ![img](../bench/x/NOTES.md)",
            "```",
            "[in a fence](private.md)",
            "```",
            "`[inline code](private.md)` [gone](nowhere.md)",
            '<img src="../bench/y/NOTES.md">',
            "[outside](../../elsewhere.md)",
          ].join("\n"),
        },
      ],
    });
    expect(
      dead.map((d) => [d.line, d.resolved]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [2, "docs/private.md"],
      [6, "docs/nowhere.md"],
      [7, "bench/y/NOTES.md"],
      [8, "../elsewhere.md"],
    ]);
  });
});
