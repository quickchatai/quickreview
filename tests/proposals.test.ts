// Proposals module (§7/§8): rubric list/read/remove argv, gh parsing,
// and accept = merge + auto-ratify against a temp repo-root with fake ssh/git.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuiConfig } from "../src/config.js";
import type { RemoteResult } from "../src/tui/remote.js";
import {
  acceptProposal,
  improvementsArgv,
  parseImprovements,
  parseRubricList,
  patchTargets,
  recordRatification,
  rubricListArgv,
  rubricReadArgv,
  rubricRemoveArgv,
  targetsAllowed,
  validSlug,
} from "../src/tui/proposals.js";

const cfg = {
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  remote_state_dir: "/opt/quickreview/state",
  remote_sandbox_root: "/opt/quickreview/sandbox",
  sudo_docker: true,
  poll_interval_s: 5,
  stale_after_s: 90,
  msg_timeout_s: 10,
} as TuiConfig;

describe("slugs and argv", () => {
  it("accepts kebab slugs, refuses traversal and shell metacharacters", () => {
    expect(validSlug("baseline-mergebase-2026-08-20")).toBe(true);
    expect(validSlug("../etc")).toBe(false);
    expect(validSlug("a b")).toBe(false);
    expect(validSlug("x;rm")).toBe(false);
    expect(validSlug(".hidden")).toBe(false);
  });

  it("read/remove argv are slug-validated and path-fixed", () => {
    expect(rubricListArgv(cfg).join(" ")).toContain("state/rubric");
    expect(rubricReadArgv(cfg, "ok-slug", "PROPOSAL.md").join(" ")).toContain("state/rubric/ok-slug/PROPOSAL.md");
    expect(() => rubricReadArgv(cfg, "../x", "PROPOSAL.md")).toThrow(/bad rubric slug/);
    expect(() => rubricRemoveArgv(cfg, "a/../b")).toThrow(/bad rubric slug/);
    expect(rubricRemoveArgv(cfg, "good").join(" ")).toContain("rm -rf '/opt/quickreview/sandbox/state/rubric/good'");
  });

  it("improvements argv reads both lists with the mint-token credential", () => {
    const s = improvementsArgv(cfg, "example-org/example-app").join(" ");
    expect(s).toContain("mint-token.sh");
    expect(s).toContain("head:bot/improve");
    expect(s).toContain("--label bot-filed");
  });
});

describe("parsing", () => {
  it("parses the rubric dir listing", () => {
    expect(parseRubricList("b-slug\na-slug\n\nbad name\n")).toEqual(["a-slug", "b-slug"]);
  });

  it("parses the two gh JSON lists around the --- separator", () => {
    const out = `[{"number":12,"title":"docs: fix typo","state":"MERGED"}]\n---\n[{"number":9,"title":"flaky test","state":"OPEN"}]`;
    expect(parseImprovements(out)).toEqual([
      { kind: "pr", number: 12, title: "docs: fix typo", state: "merged" },
      { kind: "issue", number: 9, title: "flaky test", state: "open" },
    ]);
  });

  it("degrades to empty lists on garbage", () => {
    expect(parseImprovements("gh: auth broken")).toEqual([]);
  });
});

const PATCH = `--- a/agents/pass-baseline.md
+++ b/agents/pass-baseline.md
@@ -1,2 +1,3 @@
 line one
+Always diff questioned transforms against the merge base first.
 line two
`;

describe("patch vetting", () => {
  it("extracts target files", () => {
    expect(patchTargets(PATCH)).toEqual(["agents/pass-baseline.md"]);
  });

  it("allows only agents/ and prompts/ targets", () => {
    expect(targetsAllowed(["agents/pass-baseline.md", "prompts/round-first.md"])).toBe(true);
    expect(targetsAllowed(["src/gate.ts"])).toBe(false);
    expect(targetsAllowed([])).toBe(false);
    expect(targetsAllowed(["agents/../src/gate.ts"])).toBe(false); // traversal
  });

  it("sees deletions and renames — a +++ /dev/null cannot hide a victim (review fix)", () => {
    const deletion = PATCH + `--- a/src/gate.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const gate = 1;\n`;
    expect(patchTargets(deletion)).toContain("src/gate.ts");
    expect(targetsAllowed(patchTargets(deletion))).toBe(false);
    const rename = "rename from src/gate.ts\nrename to agents/pass-x.md\n" + PATCH;
    expect(patchTargets(rename)).toContain("src/gate.ts");
    expect(targetsAllowed(patchTargets(rename))).toBe(false);
  });

  it("refuses a malformed repo string in the gh read", () => {
    expect(() => improvementsArgv(cfg, "owner/repo; rm -rf /")).toThrow(/bad repo/);
  });
});

describe("recordRatification", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ratify-"));
    mkdirSync(join(root, "tests/fixtures"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents/pass-baseline.md"), "patched body\n");
    writeFileSync(join(root, "tests/fixtures/seed-manifest.json"), JSON.stringify({ files: { "agents/pass-baseline.md": "oldhash" } }));
    writeFileSync(join(root, "tests/fixtures/ratified-divergence.json"), JSON.stringify({ files: {} }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("re-pins the manifest hash and appends a dated the owner note", () => {
    const touched = recordRatification(root, ["agents/pass-baseline.md"], "fix-mergebase", "2026-08-20");
    expect(touched).toEqual(["agents/pass-baseline.md"]);
    const manifest = JSON.parse(readFileSync(join(root, "tests/fixtures/seed-manifest.json"), "utf8"));
    expect(manifest.files["agents/pass-baseline.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files["agents/pass-baseline.md"]).not.toBe("oldhash");
    const div = JSON.parse(readFileSync(join(root, "tests/fixtures/ratified-divergence.json"), "utf8"));
    expect(div.files["agents/pass-baseline.md"][0]).toMatch(/^2026-08-20 the owner: rubric proposal 'fix-mergebase'/);
  });

  it("skips non-seeded files (no exemption needed)", () => {
    const touched = recordRatification(root, ["agents/pass-intent.md"], "s", "2026-08-20");
    expect(touched).toEqual([]);
  });
});

describe("acceptProposal", () => {
  const sshOf =
    (patch: string, removed: string[]): ((host: string, argv: string[]) => Promise<RemoteResult>) =>
    (_host, argv) => {
      const s = argv.join(" ");
      if (s.includes("changes.patch")) return Promise.resolve({ ok: true, stdout: patch, stderr: "", code: 0 });
      if (s.includes("rm -rf")) {
        removed.push(s);
        return Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });
      }
      return Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });
    };

  it("applies, ratifies, commits, then removes the VM dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "accept-"));
    mkdirSync(join(root, "tests/fixtures"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents/pass-baseline.md"), "body\n");
    writeFileSync(join(root, "tests/fixtures/seed-manifest.json"), JSON.stringify({ files: { "agents/pass-baseline.md": "old" } }));
    writeFileSync(join(root, "tests/fixtures/ratified-divergence.json"), JSON.stringify({ files: {} }));
    const gitCalls: string[][] = [];
    const removed: string[] = [];
    const res = await acceptProposal(
      {
        cfg,
        ssh: sshOf(PATCH, removed),
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-20",
      },
      "fix-mergebase",
    );
    expect(res.ok).toBe(true);
    expect(gitCalls.map((c) => c.slice(0, 2).join(" "))).toEqual(["git apply", "git apply", "git add", "git commit"]);
    expect(gitCalls[3]!.join(" ")).toContain("ratified by the owner via TUI");
    expect(removed).toHaveLength(1);
    const div = JSON.parse(readFileSync(join(root, "tests/fixtures/ratified-divergence.json"), "utf8"));
    expect(Object.keys(div.files)).toEqual(["agents/pass-baseline.md"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a patch reaching outside agents//prompts/ before touching git", async () => {
    const evil = PATCH.replace(/agents\/pass-baseline\.md/g, "src/gate.ts");
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        cfg,
        ssh: sshOf(evil, []),
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: "/nonexistent",
        today: () => "2026-08-20",
      },
      "evil",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("non-rubric paths");
    expect(gitCalls).toHaveLength(0);
  });

  it("refuses a patch that does not apply cleanly", async () => {
    const res = await acceptProposal(
      {
        cfg,
        ssh: sshOf(PATCH, []),
        git: {
          run: (cmd, args) => (args[1] === "--check" ? Promise.reject(new Error("does not apply")) : Promise.resolve("")),
        },
        repoRoot: "/nonexistent",
        today: () => "2026-08-20",
      },
      "conflicting",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("does not apply cleanly");
  });
});
