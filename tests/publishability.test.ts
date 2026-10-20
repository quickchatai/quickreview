// The publishability lint — "scrubbed" as a permanent, green-or-red
// property of every commit instead of a one-time cleanup.
//
// Prior art: tests/seed-integrity.test.ts (tree-walking assertions against a
// checked-in manifest) and tests/skill-descriptions.test.ts (prose-content
// assertions). This suite walks `git ls-files` MINUS the exclusions declared
// in publish-manifest.json — the single source of truth for what the public
// snapshot excludes, shared with the snapshot assembly — and asserts:
//
//   (a) no denylisted private token in any published text file (case-
//       insensitive), with two sanctioned exemption channels: the manifest's
//       `pending_reseed` section (frozen seed files whose de-identification
//       is the de-identification reseed) and the in-file
//       ALLOWLIST below (each entry names the file, the tokens, and the
//       reason); and a third: the manifest's `profile`. The
//       INTERNAL profile (the company-private snapshot) replaces the token
//       scan with (a-internal); the public profile is untouched;
//   (b) LICENSE and THIRD-PARTY-NOTICES.md exist and are non-trivial;
//   (c) config.example.toml exists and passes full config validation (the
//       example-config suite in tests/config.test.ts owns the deeper
//       assertions);
//   (d) no tracked file under the runtime state directories except .gitkeep
//       markers and memory/README.md;
//   (e) a NEGATIVE control: the same scanner, fed a planted token at a path
//       nothing exempts, reports the violation — the lint demonstrably bites;
//   (f) no published Markdown file links to a path the snapshot does
//       not ship — an excluded path (a lab notebook, a moved artefact, a
//       private doc) or one that was never tracked (tests/helpers/
//       published-links.ts), with its own negative control.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isBinaryContent } from "../src/setup/textsniff.js";
import { deadLinks } from "./helpers/published-links.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The manifest — exclusions (never published) and pending_reseed (published,
// but token-exempt until the de-identification reseed lands).
// ---------------------------------------------------------------------------

interface ManifestEntry {
  path: string;
  reason: string;
}
interface PublishManifest {
  exclude: ManifestEntry[];
  /** Optional: gone once the de-identification reseed lands; an assembled tree may lack it. */
  pending_reseed?: ManifestEntry[];
  /** Absent = "public". See PROFILE below. */
  profile?: string;
  profile_reason?: string;
  /** Present only in an ASSEMBLED tree (provenance of what was dropped). */
  applied_exclusions?: ManifestEntry[];
}

const manifest = JSON.parse(
  readFileSync(join(repoRoot, "publish-manifest.json"), "utf8"),
) as PublishManifest;
const pendingReseed = manifest.pending_reseed ?? [];

// ---------------------------------------------------------------------------
// The PROFILE — the ONE documented mechanism by
// which the private-token denylist may be relaxed, and it is read off the
// APPLIED manifest rather than inferred from anything.
//
//   public   (a manifest with no `profile` field, including
//            publish-manifest.json itself) — the denylist scan below runs
//            over the whole tree.
//   internal — the company-private snapshot (publish-manifest.internal.json,
//            applied by `scripts/publish-snapshot.sh --profile internal`).
//            That tree deliberately ships the private profile pack, the
//            internal ops docs and every CLAUDE.md, all of which name the
//            private org, hosts and people. Scanning it for those tokens
//            would fail by construction, so the scan is REPLACED — not
//            weakened — by the internal-profile assertion below: the
//            named-teammate corpora must be absent from the tree, and the
//            manifest must say in writing why the relaxation applies.
//
// The public path cannot be relaxed by accident: it takes a `profile` field
// in the manifest that a human wrote and a reason string this file checks.
// ---------------------------------------------------------------------------

const KNOWN_PROFILES = ["public", "internal"] as const;
type Profile = (typeof KNOWN_PROFILES)[number];
const PROFILE = (manifest.profile ?? "public") as Profile;
const INTERNAL = PROFILE === "internal";

/** Paths that never travel in ANY profile — the per-teammate review corpora. */
const NAMED_TEAMMATE_CORPORA = [
  "docs/retro/",
  "docs/audits/",
  "docs/research/",
  "docs/review-merit-assessment.md",
  "docs/corpus-rule-placements.md",
];

/** A manifest `path` ending in "/" is a directory prefix; otherwise exact. */
function matchesEntry(path: string, entry: ManifestEntry): boolean {
  return entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path;
}
const isExcluded = (path: string) => manifest.exclude.some((e) => matchesEntry(path, e));
const isPendingReseed = (path: string) => pendingReseed.some((e) => matchesEntry(path, e));

// ---------------------------------------------------------------------------
// (a) The token denylist — documented, case-insensitive substrings.
// ---------------------------------------------------------------------------

// The operator-specific tokens are assembled from parts so that this shipped
// file does not itself spell them (tokens are lower-case: the scan is a
// case-insensitive substring match against the lower-cased text).
const t = (...parts: string[]): string => parts.join("").toLowerCase();

const DENYLIST: { token: string; why: string }[] = [
  {
    token: "owner_legacy",
    why: "the original operator's personal name — owner identity is config",
  },
  { token: t("mh", "ale"), why: "the original operator's personal GitHub handle" },
  {
    token: "quickchat",
    why: "the private org and reviewed repo (quickchatai, example-app, *.quickchat.*)",
  },
  {
    token: "review.example.com",
    why: "the private webhook hostname (subsumed by 'quickchat'; listed for documentation)",
  },
  { token: "jbennett", why: "a teammate's GitHub handle" },
  { token: "gfrost", why: "a teammate's GitHub handle" },
  { token: "dwinchester", why: "a teammate's GitHub handle" },
  { token: "avasquez-", why: "a teammate's GitHub handle prefix" },
  { token: "pmercier", why: "a teammate's GitHub handle" },
  {
    token: t("my", "-vm"),
    why: "the private deployment VM's name and ssh aliases (incl. its -qc alias)",
  },
  { token: t("oper", "ator-box"), why: "the private shared operator terminal's host name" },
  { token: t("your-dev-", "project"), why: "the private GCP project id" },
  { token: t("issue-", "tracker"), why: "the private issue tracker's repository and paths" },
  {
    token: t("/home/", "user"),
    why: "the original operator's home directory (absolute private paths)",
  },
  {
    token: t("-home-", "user"),
    why: "the operator's home directory in dashed form (Claude Code project dirs)",
  },
  { token: t("src", ""), why: "the original operator's IDE projects directory" },
];

// ---------------------------------------------------------------------------
// The allowlist — the ONLY sanctioned in-tree carriers of denylisted tokens.
// Every entry names the file, the exact tokens granted, and the reason. An
// entry whose file is gone, or whose token no longer occurs in the file, FAILS
// the hygiene check below — the allowlist cannot silently go stale.
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  path: string;
  tokens: string[];
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  // -- Legal attribution: Quickchat AI is the copyright holder / public org.
  {
    path: "LICENSE",
    tokens: ["quickchat"],
    reason: "outbound license copyright line — Quickchat AI is the copyright holder",
  },
  {
    path: "package.json",
    tokens: ["quickchat"],
    reason: "repository placeholder URL under the copyright holder's public org",
  },
  {
    path: "extensions/vendor/openviking-pi/NOTICE",
    tokens: ["quickchat"],
    reason: "Apache-2.0 §4(b) modification notice names the vendoring party — legal attribution",
  },
  {
    path: "extensions/vendor/openviking-pi/patches/0000-vendoring-and-build-conformance.patch",
    tokens: ["quickchat"],
    reason:
      "recorded patch series adding the NOTICE — provenance record, never edited after the fact",
  },
  {
    path: "extensions/vendor/openviking-pi/patches/0005-second-memory-namespace.patch",
    tokens: ["owner_legacy"],
    reason: "recorded patch series (fork provenance) — patches are never edited after the fact",
  },
  {
    path: "extensions/vendor/openviking-pi/qcr-namespaces.ts",
    tokens: ["owner_legacy"],
    reason:
      "fork file recorded verbatim by patch 0005; editing it would drift the file from its recorded patch",
  },

  // -- The papers' author line (both papers ship as .tex + PDF under the
  //    author's name and affiliation).
  {
    path: "bench/aacr/paper/benchmark.tex",
    tokens: ["owner_legacy", "quickchat"],
    reason:
      "the paper's author line and self-citation — Mateusz Jakubczak, Quickchat AI (the publishing org), as decided for publication",
  },
  {
    path: "bench/aacr/paper/quickreview.tex",
    tokens: ["owner_legacy", "quickchat"],
    reason:
      "the paper's author line and self-citation — Mateusz Jakubczak, Quickchat AI (the publishing org), as decided for publication",
  },

  // -- Legacy-acceptance folds: the token IS the tested/parsed input
  //    (accepted forever on input, never emitted — the codebase's
  //    belt-and-braces convention; see tests/legacy-acceptance.test.ts).
  {
    path: "src/config.ts",
    tokens: ["owner_legacy"],
    reason:
      "the legacy [slack] legacy_owner_slack_id alias — accepted on input, folded to [owner] slack_id",
  },
  {
    path: "src/state.ts",
    tokens: ["owner_legacy"],
    reason: "foldSlackTier accepts the retired 'owner_legacy' tier spelling on input",
  },
  {
    path: "src/commands.ts",
    tokens: ["owner_legacy"],
    reason: "LEGACY_COMMAND_NAMES maps the retired 'flag-owner-legacy' command to 'flag-owner'",
  },
  {
    path: "src/wire.ts",
    tokens: ["owner_legacy"],
    reason:
      "older origin records live on in the legacy owner-legacy.log audit file — read forever, written never",
  },
  {
    path: "config.example.toml",
    tokens: ["owner_legacy"],
    reason: "documents the legacy [slack] legacy_owner_slack_id alias an old config may still carry",
  },
  {
    path: "tests/prompt-provenance.test.ts",
    tokens: ["owner_legacy"],
    reason:
      "the provenance scan's own needle: asserts the owner's name never reaches a model-facing prompt",
  },
  {
    path: "tests/fixtures/config.toml",
    tokens: ["owner_legacy"],
    reason: "fixture exercises the legacy legacy_owner_slack_id alias fold",
  },
  {
    path: "tests/legacy-acceptance.test.ts",
    tokens: ["owner_legacy"],
    reason:
      "THE pinning file for the owner_legacy→owner tier fold and flag-owner-legacy→flag-owner command fold",
  },
  {
    path: "tests/slack-config.test.ts",
    tokens: ["owner_legacy"],
    reason: "exercises the legacy legacy_owner_slack_id alias (set, conflicting, folded)",
  },
  {
    path: "tests/slack-appendix-schemas.test.ts",
    tokens: ["owner_legacy"],
    reason: "pins the flag-owner-legacy legacy command alias against the frozen appendix seed",
  },
  {
    path: "tests/slack-router.test.ts",
    tokens: ["owner_legacy"],
    reason: "pasted-table injection case uses the retired legacy tier spelling deliberately",
  },
  {
    path: "deploy/collect-slack-secrets.mjs",
    tokens: ["owner_legacy"],
    reason: "the Slack wizard reads/patches the legacy legacy_owner_slack_id config key alias",
  },
  {
    path: "tests/slack-setup-wizard.test.ts",
    tokens: ["owner_legacy"],
    reason: "tests the wizard's handling of the legacy legacy_owner_slack_id key",
  },

  // -- Grandfathered ratification grammar: the verifying regexes accept the
  //    historical personal spelling so old fences/notes need no rewrite;
  //    history is never rewritten.
  {
    path: "tests/invariant-fences.test.ts",
    tokens: ["owner_legacy"],
    reason:
      "the fence grammar's grandfathered '(?:the owner|owner) only' spelling and its acceptance tests",
  },
  {
    path: "tests/seed-integrity.test.ts",
    tokens: ["owner_legacy"],
    reason: "divergence-note grammar grandfathers the historical ratifier spelling",
  },
  {
    path: "tests/proposals.test.ts",
    tokens: ["owner_legacy"],
    reason: "rubric-accept fence/divergence grammar tests exercise the grandfathered spelling",
  },
  {
    path: "tests/fixtures/ratified-divergence.json",
    tokens: ["owner_legacy"],
    reason:
      "the ratification HISTORY — hash-pinned record of who ratified each reseed; history is never rewritten",
  },
  {
    path: "docs/ownership.md",
    tokens: ["owner_legacy"],
    reason:
      "the public ownership doc names the grandfathered historical spelling the fence grammar accepts",
  },

  // -- The companion's reviewed-repo mount point is the generic
  //    `/reviewed-repo`; what is left here is the private
  //    identity the companion commits under and the tests that pin the shipped
  //    reviewed_repo_dir default and the retired path's drift.
  {
    path: "docker/companion/entrypoint.sh",
    tokens: ["quickchat"],
    reason:
      "provisions the [companion] git identity (its commit email) — the mount path itself is generic",
  },
  {
    path: "docker/entrypoint.sh",
    tokens: ["quickchat"],
    reason:
      "the release image's companion mode provisions the [companion] git identity (its commit email) — the companion's entrypoint since P7.8 (docker/companion/entrypoint.sh stays only for the scan sandbox's one-shot mode)",
  },
  {
    path: ".github/workflows/release.yml",
    tokens: ["quickchat"],
    reason:
      "names the release and memory-sidecar images under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "docs/action/qcr-review.yml",
    tokens: ["quickchat"],
    reason:
      "the workflow template names the Action under the publishing org (quickchatai/quickreview@v1), the one line a user copies; the Action's repository moves at the public leg",
  },
  {
    path: "docs/action.md",
    tokens: ["quickchat"],
    reason:
      "the Action's user doc names it under the publishing org (quickchatai/quickreview@v1), as the template does",
  },
  {
    path: "plugins/qcr/scripts/qcr-setup.sh",
    tokens: ["quickchat"],
    reason:
      "names the default release image under the publishing org's registry namespace (ghcr.io/quickchatai/quickreview), the one place the plugin can learn it before a wrapper pins it",
  },
  {
    path: "docker-compose.yml",
    tokens: ["quickchat"],
    reason:
      "names the daemon and memory-sidecar images it pulls, under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "README.md",
    tokens: ["quickchat"],
    reason:
      "the install commands name the release image under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "docs/onboarding.md",
    tokens: ["quickchat"],
    reason:
      "the install and bring-up commands name the release image under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "docker/daemon/README.md",
    tokens: ["quickchat"],
    reason:
      "the compose stack's quick start names the release and memory images under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "src/onboard/steps/compose.ts",
    tokens: ["quickchat"],
    reason:
      "the RELEASE_IMAGE_REPO / MEMORY_IMAGE_REPO constants: the images bring-up pulls, under the publishing org's registry namespace (ghcr.io/quickchatai/...), the ones release.yml pushes",
  },
  {
    path: "src/onboard/steps/bringup.ts",
    tokens: ["quickchat"],
    reason: "its header comment names the images it pulls (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/onboard-bringup.test.ts",
    tokens: ["quickchat"],
    reason: "pins the extraction command and image names bring-up prints (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/onboard-engine.test.ts",
    tokens: ["quickchat"],
    reason: "pins the manifest probe's image name (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/compose-stack.test.ts",
    tokens: ["quickchat"],
    reason:
      "pins the image names the compose file pulls, under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/onboarding-docs.test.ts",
    tokens: ["quickchat"],
    reason:
      "pins that the user docs name the release image under the registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "deploy/ansible/group_vars/all.yml",
    tokens: ["quickchat"],
    reason:
      "release_image / release_memory_image: the images the VM route pulls, under the publishing org's registry namespace (ghcr.io/quickchatai/...), the ones release.yml pushes",
  },
  {
    path: "deploy/ansible/README.md",
    tokens: ["quickchat"],
    reason:
      "the VM route's docs name the release and memory images under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "scripts/deploy.sh",
    tokens: ["quickchat"],
    reason:
      "release <version> names the daemon and memory images it has the VM pull, under the publishing org's registry namespace (ghcr.io/quickchatai/...), as a fallback for an inventory that sets none",
  },
  {
    path: "scripts/vm-ghcr-login.sh",
    tokens: ["quickchat"],
    reason:
      "names the default release and memory images it checks the pull credential against, under the publishing org's registry namespace (ghcr.io/quickchatai/...), as a fallback for an inventory that sets none",
  },
  {
    path: "tests/qcr-update.test.ts",
    tokens: ["quickchat"],
    reason:
      "drives the VM updater against a fake docker: the image repositories are the release images under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/fixtures/deploy-manifest-1.2.3.json",
    tokens: ["quickchat"],
    reason:
      "a release's deploy manifest as CI emits it: the daemon and memory image repositories under the publishing org's registry namespace (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/deploy.test.ts",
    tokens: ["quickchat"],
    reason:
      "pins the image names deploy.sh release plans and the VM-layout probe reads (ghcr.io/quickchatai/...)",
  },
  {
    path: "tests/tui-companion.test.ts",
    tokens: ["quickchat"],
    reason:
      "pins the shipped reviewed_repo_dir default and that a container still carrying the retired /example-app mount drifts",
  },

  // -- Files that must spell a token: negative assertions name what they look
  //    for, the exclusion record names what it excludes, and a live default
  //    stays put.
  {
    path: "tests/posting.test.ts",
    tokens: ["owner_legacy"],
    reason: "negative assertion that the assembled review body stays scrubbed of the personal name",
  },
  {
    path: "tests/github-app-manifest.test.ts",
    tokens: ["quickchat"],
    reason: "negative assertion that the shipped App manifest carries no private-org hostname",
  },
  {
    path: "publish-manifest.json",
    tokens: ["quickchat", t("oper", "ator-box")],
    reason:
      "the exclusion record itself must name the excluded private paths (the private profile, the operator-terminal docs and scripts)",
  },
  {
    path: "prompts/companion.md",
    tokens: [t("my", "-vm")],
    reason:
      "a frozen, byte-pinned seed (tests/seed-integrity.test.ts) still names the review VM by its private name; rewording it is an owner-ratified reseed",
  },

  // -- Tests exercising the private quickchat profile pack (excluded from the
  //    snapshot alongside profiles/quickchat/; the assembly drops or guards
  //    these blocks when assembling the public tree).
  {
    path: "tests/profiles.test.ts",
    tokens: ["quickchat", "owner_legacy", "gfrost"],
    reason:
      "byte-pins the private quickchat pack's moved corpus rules (verbatim, incl. their leak-check list); its fixture copy tests/fixtures/profiles/quickchat/ is excluded beside profiles/quickchat/",
  },
  {
    path: "tests/heuristics.test.ts",
    tokens: ["quickchat"],
    reason:
      "equivalence proof: quickchat heuristics.toml == the pre-lift compiled-in selection; its fixture copy tests/fixtures/profiles/quickchat/ is excluded beside profiles/quickchat/",
  },
  {
    path: "tests/include.test.ts",
    tokens: ["quickchat"],
    reason:
      "asserts the deployed composition [generic registry + quickchat pack]; its fixture copy tests/fixtures/profiles/quickchat/ is excluded beside profiles/quickchat/",
  },
  {
    path: "tests/stack-neutral.test.ts",
    tokens: ["quickchat"],
    reason:
      "proof that the stack rules the reseed took out of three seeds reach their lenses through the quickchat pack (self-skips without it); its fixture copy tests/fixtures/profiles/quickchat/ is excluded beside profiles/quickchat/",
  },
  {
    path: "tests/ecosystem.test.ts",
    tokens: ["quickchat"],
    reason: "asserts the shipped profiles' ecosystem selections incl. the private pack",
  },
  {
    path: "tests/dispatch.test.ts",
    tokens: ["quickchat"],
    reason:
      "a lens-selection case names a quickchat-shaped settings path (project/settings_prod.py)",
  },
  {
    path: "docs/profiles.md",
    tokens: ["quickchat"],
    reason: "documents the shipped profile set incl. the private pack the live deployment selects",
  },

  // -- Deliberate negative assertions / scrub tripwires.
  {
    path: "tests/checklist.test.ts",
    tokens: ["owner_legacy"],
    reason:
      "negative assertion that the cutover checklist output stays scrubbed of the personal name",
  },
  {
    path: "tests/publishability.test.ts",
    tokens: [
      "owner_legacy",
      "quickchat",
      "gfrost",
      "jbennett",
      "dwinchester",
      "avasquez-",
      "pmercier",
      "review.example.com",
    ],
    reason:
      "this lint — the denylist itself plus the negative-control plants (the operator-specific tokens are built from parts, so the file never spells them)",
  },
  {
    path: "bench/aacr/hf_export.py",
    tokens: ["owner_legacy", "quickchat"],
    reason:
      "the HF dataset export's scrub rules name the strings they rewrite, and its NOTICE names the copyright holder",
  },
  {
    path: "tests/fences-provenance.test.ts",
    tokens: ["owner_legacy"],
    reason:
      "the provenance fence names the owner to forbid the name in code comments, and allowlists the legacy wire spellings it must accept",
  },
  {
    path: "bench/aacr/export_runs.py",
    tokens: ["owner_legacy", "quickchat"],
    reason:
      "the run-archive export's scrub rules and re-grep name the strings they rewrite and hunt, and its README's modified-work statement names the copyright holder",
  },
  {
    path: "bench/aacr/hf/card.md",
    tokens: ["owner_legacy", "quickchat"],
    reason: "the dataset card's citations name the papers' author and affiliation",
  },
  {
    path: "tests/hf-export.test.ts",
    tokens: ["owner_legacy"],
    reason:
      "scrub tripwire: plants the rewritten names and asserts none survives the export's scrub",
  },
];

function allowlisted(path: string, token: string): boolean {
  return ALLOWLIST.some((e) => e.path === path && e.tokens.includes(token));
}

// ---------------------------------------------------------------------------
// The scanner — pure over (path, text) pairs so the negative control can
// prove it bites without touching the working tree.
// ---------------------------------------------------------------------------

interface Violation {
  path: string;
  token: string;
  line: number;
  text: string;
}

function scanFiles(files: { path: string; text: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, text } of files) {
    if (isExcluded(path) || isPendingReseed(path)) continue;
    const lower = text.toLowerCase();
    for (const { token } of DENYLIST) {
      if (!lower.includes(token)) continue;
      if (allowlisted(path, token)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(token)) {
          violations.push({ path, token, line: i + 1, text: lines[i]!.trim().slice(0, 160) });
        }
      }
    }
  }
  return violations;
}

// Binary files are exempt from the TOKEN sweep only (they are still subject
// to the exclusion manifest at snapshot time).
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

describe("publish-manifest.json", () => {
  it("every entry carries a path and a non-empty reason", () => {
    for (const entry of [...manifest.exclude, ...pendingReseed]) {
      expect(entry.path, JSON.stringify(entry)).toBeTruthy();
      expect(entry.reason?.trim().length ?? 0, `${entry.path}: reason required`).toBeGreaterThan(
        10,
      );
    }
  });

  it("declares a known profile, and anything but public says in writing why", () => {
    expect(KNOWN_PROFILES as readonly string[], `unknown profile '${PROFILE}'`).toContain(PROFILE);
    if (INTERNAL) {
      expect(
        (manifest.profile_reason ?? "").trim().length,
        "a non-public profile relaxes the denylist — the manifest must carry the reason",
      ).toBeGreaterThan(40);
    } else {
      // The default is public and stays implicit: no field, no relaxation.
      expect(manifest.profile ?? "public").toBe("public");
    }
  });

  it("every pending_reseed entry cites — the section dies with that reseed", () => {
    // The section is OPTIONAL: it is deleted when the reseed lands, and the
    // assembled public tree may carry a manifest without it
    // (then the token scan bites on prompts//agents//seeds/ too — the point).
    for (const entry of pendingReseed) {
      expect(entry.reason, entry.path).toContain("");
    }
  });

  it("directory entries end with '/' and match at least one tracked file (or are known-untracked belts)", () => {
    const tracked = trackedFiles();
    // Config, profiles and the retro/audit/research corpora live in the
    // install's config and state homes — their entries stay as belts, so a
    // checkout that still strands one (un-migrated) never ships it.
    const KNOWN_UNTRACKED = new Set([
      "deploy/ansible/inventory.ini",
      ".claude/worktrees/",
      "config.toml",
      "docs/retro/",
      "docs/audits/",
      "docs/research/",
      ...manifest.exclude
        .map((e) => e.path)
        .filter((p) => p.startsWith("profiles/") && p.endsWith("/")),
    ]);
    for (const entry of [...manifest.exclude, ...pendingReseed]) {
      if (KNOWN_UNTRACKED.has(entry.path)) continue;
      const hits = tracked.filter((p) => matchesEntry(p, entry));
      expect(
        hits.length,
        `${entry.path} matches nothing tracked — stale manifest entry`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("publishability lint", () => {
  const tracked = trackedFiles();

  // Skipped ONLY under the internal profile, which is replaced by the
  // assertion below rather than left unchecked. A skipped test is visible in
  // the run; a silently-passing one is not.
  it.skipIf(INTERNAL)("(a) no denylisted private token in any published text file", () => {
    const files: { path: string; text: string }[] = [];
    for (const path of tracked) {
      if (isExcluded(path) || isPendingReseed(path)) continue;
      // A tracked symlink has no text of its own; its target is scanned at its real path.
      if (lstatSync(join(repoRoot, path)).isSymbolicLink()) continue;
      const buf = readFileSync(join(repoRoot, path));
      if (isBinary(path, buf)) continue;
      files.push({ path, text: buf.toString("utf8") });
    }
    const violations = scanFiles(files);
    const rendered = violations
      .slice(0, 50)
      .map((v) => `${v.path}:${v.line} [${v.token}] ${v.text}`)
      .join("\n");
    expect(
      violations,
      `private tokens in published files (fix the file, or add a reasoned ALLOWLIST/manifest entry):\n${rendered}`,
    ).toEqual([]);
  });

  it.runIf(INTERNAL)(
    "(a-internal) the relaxation is declared in the manifest, and the named-teammate corpora are absent anyway",
    () => {
      expect(
        manifest.profile_reason,
        "the internal profile must carry its own written reason",
      ).toBeTruthy();
      const offenders = tracked.filter((p) =>
        NAMED_TEAMMATE_CORPORA.some((d) => (d.endsWith("/") ? p.startsWith(d) : p === d)),
      );
      expect(offenders, "per-teammate review corpora never travel — in ANY profile").toEqual([]);
      // …and their absence is recorded as deliberate, not incidental.
      const dropped = (manifest.applied_exclusions ?? manifest.exclude).map((e) => e.path);
      for (const path of NAMED_TEAMMATE_CORPORA)
        expect(dropped, `${path} must be an applied exclusion, not merely missing`).toContain(path);
    },
  );

  it("allowlist hygiene: every entry's file is tracked, published, and still carries the granted token", () => {
    const trackedSet = new Set(tracked);
    for (const entry of ALLOWLIST) {
      expect(trackedSet.has(entry.path), `${entry.path}: allowlisted but not tracked`).toBe(true);
      expect(
        isExcluded(entry.path),
        `${entry.path}: allowlisted AND excluded — drop the allowlist entry`,
      ).toBe(false);
      expect(entry.reason.trim().length, `${entry.path}: reason required`).toBeGreaterThan(10);
      const lower = readFileSync(join(repoRoot, entry.path), "utf8").toLowerCase();
      for (const token of entry.tokens) {
        expect(
          lower.includes(token),
          `${entry.path}: allowlisted token '${token}' no longer occurs — stale entry, remove it`,
        ).toBe(true);
      }
    }
  });

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
    expect(trackedFiles().some((p) => p.startsWith("extensions/vendor/pi-subagents/"))).toBe(false);
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

  it("(e) NEGATIVE control: a planted token at an unexempted path is caught", () => {
    const planted = scanFiles([
      {
        path: "src/planted-control.ts",
        text: `// deployed for the owner on ${t("my", "-vm")}-qc\nconst x = 1;\n`,
      },
    ]);
    expect(planted.map((v) => v.token).sort()).toEqual([t("my", "-vm"), "owner_legacy"]);
    expect(planted[0]!.path).toBe("src/planted-control.ts");
    expect(planted[0]!.line).toBe(1);

    // A source file with one stray NUL is still TEXT to the sweep — never
    // exempted as binary.
    const nulSource = Buffer.from("// for the owner\nconst k = `${a}\0${b}`;\n");
    expect(isBinary("src/planted-control.ts", nulSource)).toBe(false);
    expect(isBinary("docs/media/planted.gif", nulSource)).toBe(true);

    // …while the exemption channels behave as declared. The exclude/
    // pending_reseed probes are conditional: an assembled tree carries an
    // EMPTY exclude (exclusions applied at assembly), and the pending_reseed
    // section is gone once the reseed has landed — a planted token
    // under prompts/ is now CAUGHT; the frozen appendix's legacy spellings
    // are carried by the reasoned ALLOWLIST instead.
    const retroPlant = scanFiles([{ path: "docs/retro/planted.md", text: "the owner" }]);
    if (isExcluded("docs/retro/planted.md")) expect(retroPlant).toEqual([]);
    else expect(retroPlant).not.toEqual([]);
    const seedPlant = scanFiles([{ path: "prompts/planted.md", text: "the owner" }]);
    if (isPendingReseed("prompts/planted.md"))
      expect(seedPlant).toEqual([]); // pending_reseed (a dead section)
    else expect(seedPlant).not.toEqual([]);
    expect(scanFiles([{ path: "tests/legacy-acceptance.test.ts", text: "flag-owner-legacy" }])).toEqual(
      [],
    ); // allowlisted carrier
    expect(scanFiles([{ path: "LICENSE", text: "Copyright Quickchat AI" }])).toEqual([]); // allowlisted token
    expect(scanFiles([{ path: "LICENSE", text: t("my", "-vm", "-qc") }])).not.toEqual([]); // …but only the GRANTED token
  });
});

describe("(f) shipped links land on shipped paths", () => {
  const tracked = trackedFiles();

  it("no published Markdown file links into an excluded or untracked path", () => {
    const files = tracked
      .filter((p) => p.endsWith(".md") && !isExcluded(p))
      .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
    const dead = deadLinks({ tracked, exclude: manifest.exclude, files });
    const rendered = dead
      .slice(0, 80)
      .map((d) => `${d.file}:${d.line} → ${d.target} (${d.kind}: ${d.resolved})`)
      .join("\n");
    expect(
      dead,
      `${dead.length} shipped link(s) the public snapshot would break — repoint each at a shipped path (the papers, a shipped doc) or an external URL (the dataset):\n${rendered}`,
    ).toEqual([]);
  });

  it("NEGATIVE control: a link into an excluded path, and one to nothing, are both caught", () => {
    const dead = deadLinks({
      tracked: ["README.md", "docs/a.md", "docs/private.md", "bench/x/NOTES.md"],
      exclude: [{ path: "docs/private.md" }, { path: "bench/x/" }],
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
            '<img src="../bench/x/NOTES.md">',
          ].join("\n"),
        },
      ],
    });
    expect(dead.map((d) => [d.line, d.resolved, d.kind])).toEqual([
      [2, "docs/private.md", "excluded"],
      [2, "bench/x/NOTES.md", "excluded"],
      [6, "docs/nowhere.md", "missing"],
      [7, "bench/x/NOTES.md", "excluded"],
    ]);
  });
});
