// The one skill source (plugins/qcr/templates/) and its renderer
// (plugins/qcr/render.mjs), driven from the outside: the source in, the map
// of relative paths to file contents out, for every host and for pi.
//
//   - one golden tree per target under fixtures/plugin-render/ is the
//     staleness fence: a template edited without regenerating fails here;
//   - the names table holds every command, selfimprove included, and the
//     render emits only the commands that have a template;
//   - every manifest carries the version it was rendered at, and the three
//     marketplace hosts get a local marketplace naming the plugin;
//   - a host body runs qcr only at its contract, falls back to the pinned
//     `npx`, scans with `--sandbox host` in calls qcr scan parses, makes a
//     repo's first unit cut, and Codex's asks for the network once, up
//     front; a pi body hands the person the `/qcr-…` line;
//   - plugins/qcr/ is a source (the renderer and the templates, no manifest)
//     that names no Docker, ghcr or fixed release, and the repo root carries
//     no plugin manifest or marketplace.
//
// Regenerate the goldens ONLY for a deliberate change to the source or the
// layout: `UPDATE_GOLDEN=1 npx vitest run tests/plugin-render.test.ts`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  CONTRACTS,
  REVIEW_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  VERSION_SCHEMA_VERSION,
  supportedContracts,
} from "@quickchatai/pi-quickreview/src/contract.js";
import { PRICE_BASES } from "@quickchatai/pi-quickreview/src/measured.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { SECURITY_LENSES } from "@quickchatai/pi-quickreview/src/plugin/args.js";
import type { ThreatModelPreview } from "@quickchatai/pi-quickreview/src/scan/scanrun.js";
import { parseScanArgs } from "@quickchatai/pi-quickreview/src/scan/scanverbs.js";
import { ADJUST_OPS } from "@quickchatai/pi-quickreview/src/scan/unitcut.js";
import {
  COMMANDS,
  HOSTS,
  MARKETPLACE_NAME,
  NAMES,
  PLUGIN_NAME,
  TARGETS,
  TEMPLATE_CONTRACT,
  loadSource,
  packageVersion,
  render,
  renderedDiff,
  writeRendered,
} from "../plugins/qcr/render.mjs";
import { parseReviewArgs } from "../src/reviewargs.js";
import { parseSkillFrontmatter } from "./helpers/skill-frontmatter.js";

const ROOT = resolve(import.meta.dirname, "..");
const GOLDEN = join(ROOT, "tests", "fixtures", "plugin-render");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
// The goldens are rendered at a fixed version, so a release bump does not
// touch them; the version a manifest carries is checked on its own below.
const AT = { version: "0.0.0-golden", contract: TEMPLATE_CONTRACT };
const source = loadSource();
const rendered = (t: string, at = AT): Record<string, string> => render(source, t, at);

const tmp = mkdtempSync(join(tmpdir(), "plugin-render-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Every file under `dir`, relative to it, sorted (dot folders included). */
function tree(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? tree(dir, r) : [r];
    })
    .sort();
}

const skills = (files: Record<string, string>): Array<[string, string]> =>
  Object.entries(files).filter(([p]) => p.endsWith("/SKILL.md"));

/** The text an agent reads as a command's instructions, per file. */
const bodies = (t: string): Array<[string, string]> =>
  t === "gemini"
    ? Object.entries(rendered(t))
        .filter(([p]) => p.endsWith(".toml"))
        .map(([p, c]) => [p, parseToml(c)["prompt"] as string])
    : skills(rendered(t)).map(([p, c]) => [p, parseSkillFrontmatter(c).body]);

describe("the goldens", () => {
  // The staleness fence: a rendered copy that differs from its source fails.
  // MUTATION: edit one line of plugins/qcr/templates/review.md (either body)
  // without UPDATE_GOLDEN=1 — this fails.
  it.each(TARGETS)("%s renders exactly its golden tree", (t) => {
    const files = rendered(t);
    const dir = join(GOLDEN, t);
    if (UPDATE) {
      rmSync(dir, { recursive: true, force: true });
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
    }
    expect(tree(dir)).toEqual(Object.keys(files));
    for (const [p, c] of Object.entries(files))
      expect(readFileSync(join(dir, p), "utf8"), `${t}/${p}`).toBe(c);
  });

  it("holds one golden per target and nothing else", () => {
    expect(readdirSync(GOLDEN).sort()).toEqual([...TARGETS].sort());
    expect(TARGETS).toEqual([...HOSTS, "pi"]);
    expect([...HOSTS].sort()).toEqual(
      ["antigravity", "claude", "codex", "copilot", "cursor", "gemini", "opencode"].sort(),
    );
  });
});

describe("the names table", () => {
  // MUTATION: make copilot namespaced, or give codex a "/" — this fails.
  it("names each command and its invoke spelling per target", () => {
    const invoke = (t: string): string => NAMES[t]!["review"]!.invoke;
    expect(Object.fromEntries(TARGETS.map((t) => [t, invoke(t)]))).toEqual({
      claude: "/qcr:review",
      codex: "$qcr:review",
      gemini: "/qcr:review",
      antigravity: "/qcr:review",
      copilot: "/qcr-review",
      cursor: "/qcr-review",
      opencode: "/qcr-review",
      pi: "/qcr-review",
    });
    for (const t of ["claude", "codex", "gemini", "antigravity"])
      expect(NAMES[t]!["scan"]!.name, t).toBe("scan");
    for (const t of ["copilot", "cursor", "opencode", "pi"])
      expect(NAMES[t]!["scan"]!.name, t).toBe("qcr-scan");
  });

  it("holds selfimprove on every target", () => {
    expect(COMMANDS).toEqual(["review", "scan", "setup", "selfimprove"]);
    for (const t of TARGETS) expect(Object.keys(NAMES[t]!), t).toEqual([...COMMANDS]);
    expect(NAMES["codex"]!["selfimprove"]!.invoke).toBe("$qcr:selfimprove");
    expect(NAMES["pi"]!["selfimprove"]!.invoke).toBe("/qcr-selfimprove");
  });

  // MUTATION: render every command of COMMANDS instead of those with a
  // template — this fails.
  it("renders only the commands that have a template", () => {
    expect(Object.keys(source.commands).sort()).toEqual(["review", "scan", "setup"]);
    for (const t of TARGETS)
      expect(
        Object.keys(rendered(t)).some((p) => p.includes("selfimprove")),
        t,
      ).toBe(false);
    const onlyReview = { ...source, commands: { review: source.commands["review"]! } };
    const cursor = Object.keys(render(onlyReview, "cursor", AT));
    expect(cursor).toEqual([".cursor-plugin/plugin.json", "skills/qcr-review/SKILL.md"]);
  });

  it("matches the pi Plugin's own commands", async () => {
    const { QUICKREVIEW_COMMANDS } =
      await import("@quickchatai/pi-quickreview/extensions/quickreview.js");
    expect(Object.keys(source.commands).map((c) => NAMES["pi"]![c]!.name)).toEqual([
      ...QUICKREVIEW_COMMANDS,
    ]);
  });
});

describe("the manifests", () => {
  const AT2 = { version: "4.5.6", contract: TEMPLATE_CONTRACT };
  const manifests: Record<string, string[]> = {
    claude: ["qcr/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json"],
    codex: ["qcr/.codex-plugin/plugin.json", ".claude-plugin/marketplace.json"],
    copilot: ["qcr/.github/plugin/plugin.json", ".github/plugin/marketplace.json"],
    cursor: [".cursor-plugin/plugin.json"],
    gemini: ["gemini-extension.json"],
    antigravity: ["plugin.json"],
    opencode: [],
    pi: [],
  };

  // MUTATION: write a fixed version into one manifest — this fails.
  it.each(TARGETS)("%s: every manifest carries the version it was rendered at", (t) => {
    const files = rendered(t, AT2);
    const json = Object.keys(files).filter((p) => p.endsWith(".json"));
    expect(json.sort(), t).toEqual([...manifests[t]!].sort());
    for (const p of json) {
      const m = JSON.parse(files[p]!) as Record<string, unknown>;
      expect(m["name"] === PLUGIN_NAME || m["name"] === MARKETPLACE_NAME, p).toBe(true);
      // antigravity's manifest admits no version key: it rides in the description
      if (t === "antigravity")
        expect(m).toEqual({ name: "qcr", description: expect.stringContaining("4.5.6") });
      else if (p.endsWith("marketplace.json"))
        expect((m["plugins"] as Array<{ version: string }>)[0]!.version).toBe("4.5.6");
      else expect(m["version"], p).toBe("4.5.6");
    }
    // the pinned npx line is the same version
    const all = Object.values(files).join("\n");
    expect(all).not.toContain("0.0.0-golden");
    if (t !== "pi") expect(all).toContain("npx -y @quickchatai/quickreview@4.5.6 ");
  });

  it("gives claude, codex and copilot a local marketplace naming the plugin beside it", () => {
    for (const t of ["claude", "codex", "copilot"]) {
      const files = rendered(t);
      const at = manifests[t]![1]!;
      const m = JSON.parse(files[at]!) as {
        name: string;
        owner: { name: string };
        plugins: Array<{ name: string; source: string }>;
      };
      expect(m.name, t).toBe(MARKETPLACE_NAME);
      expect(m.owner.name, t).toBeTruthy();
      expect(
        m.plugins.map((p) => [p.name, p.source]),
        t,
      ).toEqual([["qcr", "./qcr"]]);
      // the plugin's own manifest sits in the folder the marketplace names
      expect(files[manifests[t]![0]!], t).toBeDefined();
      expect(manifests[t]![0]!.startsWith("qcr/"), t).toBe(true);
    }
  });

  it("the CLI renders at the package's own version and the Plugin's, which agree", () => {
    const app = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    const plugin = JSON.parse(
      readFileSync(join(ROOT, "packages", "pi-plugin", "package.json"), "utf8"),
    ) as { version: string };
    expect(packageVersion()).toBe(app.version);
    expect(plugin.version).toBe(app.version);
  });

  it("ships in the App's package, which `qcr plugin` renders from", () => {
    const app = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(app.files).toContain("plugins/");
  });

  it("refuses a version or a contract that is not one", () => {
    expect(() => render(source, "claude", { version: "latest", contract: 1 })).toThrow(/version/);
    expect(() => render(source, "claude", { version: "1.2.3", contract: 0 })).toThrow(/contract/);
    expect(() => render(source, "vscode", AT)).toThrow(/unknown target/);
  });
});

describe("the host plugin is a source, off Docker", () => {
  const SOURCE = join(ROOT, "plugins", "qcr");
  const AT2 = { version: "4.5.6", contract: TEMPLATE_CONTRACT };
  const RELEASE = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;

  // MUTATION: put a `docker run …` step back into plugins/qcr/templates/setup.md's
  // host body, or write `"version": "1.3.2"` into one template — this fails.
  it("no source file and no render names Docker, ghcr, read:packages or a fixed release", () => {
    for (const p of tree(SOURCE)) {
      const text = readFileSync(join(SOURCE, p), "utf8");
      expect(text, `plugins/qcr/${p}`).not.toMatch(/docker|ghcr|read:packages/i);
      // the release is the render's input, never a literal a person bumps
      expect(text.match(RELEASE) ?? [], `plugins/qcr/${p}`).toEqual([]);
    }
    for (const t of TARGETS)
      for (const [p, text] of Object.entries(rendered(t, AT2))) {
        expect(text, `${t}/${p}`).not.toMatch(/docker|ghcr|read:packages/i);
        expect(new Set(text.match(RELEASE) ?? []), `${t}/${p}`).toEqual(
          new Set(text.match(RELEASE) ? ["4.5.6"] : []),
        );
      }
  });

  // MUTATION: restore plugins/qcr/.claude-plugin/plugin.json, or
  // plugins/qcr/scripts/qcr-setup.sh — this fails.
  it("plugins/qcr/ holds the renderer, its types and the templates, and no manifest", () => {
    const extra = tree(SOURCE).filter(
      (p) => p !== "render.mjs" && p !== "render.d.mts" && !p.startsWith("templates/"),
    );
    expect(extra).toEqual([]);
  });

  // MUTATION: restore the root .claude-plugin/marketplace.json — this fails.
  it("the repo root carries no plugin manifest or marketplace of its own", () => {
    for (const p of [
      ".claude-plugin",
      ".codex-plugin",
      ".cursor-plugin",
      ".github/plugin",
      "gemini-extension.json",
      "plugin.json",
      "marketplace.json",
    ])
      expect(existsSync(join(ROOT, p)), p).toBe(false);
  });
});

describe("the skills", () => {
  it.each(TARGETS.filter((t) => t !== "gemini"))(
    "%s: front matter parses, and each name matches its folder",
    (t) => {
      const files = rendered(t);
      expect(skills(files)).toHaveLength(3);
      for (const [p, c] of skills(files)) {
        const fm = parseSkillFrontmatter(c);
        const folder = p.split("/").at(-2);
        expect(fm.fields.get("name")?.value, p).toBe(folder);
        expect(
          Object.values(NAMES[t]!).map((n) => n.name),
          p,
        ).toContain(folder);
        expect(fm.fields.get("description")?.resolvesTo, p).toBe("string");
        expect(fm.fields.get("description")!.value.length, p).toBeGreaterThan(40);
        expect(fm.comments, p).toBe(0);
      }
    },
  );

  it("gemini: each command is TOML with the shared description and the host body as its prompt", () => {
    const files = rendered("gemini");
    for (const c of ["review", "scan", "setup"] as const) {
      const toml = parseToml(files[`commands/qcr/${c}.toml`]!);
      expect(toml["description"]).toBe(source.commands[c]!.description);
      expect(toml["prompt"] as string).toMatch(/^# /);
    }
  });

  it("a placeholder the renderer does not know is refused", () => {
    const broken = {
      ...source,
      commands: { review: { ...source.commands["review"]!, host: "# x\n\n{{versoin}}\n" } },
    };
    expect(() => render(broken, "claude", AT)).toThrow(/placeholder/);
  });
});

describe("the bodies", () => {
  const runs = (body: string): string[] =>
    [...body.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)]
      .map((m) => m[0])
      .filter((c) => /\b(qcr|quickreview@\S+)\s[^`]*\b(review|scan|version)\b/.test(c));

  // MUTATION: drop `--schema {{schema}}` from one command in the review
  // template's table — this fails.
  it.each(HOSTS)(
    "%s: every qcr call carries the contract, and every scan call --sandbox host",
    (t) => {
      for (const [p, body] of bodies(t)) {
        expect(runs(body).length, p).toBeGreaterThan(1);
        const bare = runs(body).filter(
          (c) =>
            /\bqcr (review|scan|version)\b/.test(c) ||
            /quickreview@\S+ (review|scan|version)\b/.test(c),
        );
        expect(bare, p).toEqual([]);
        for (const c of runs(body).filter((r) => /--schema 2 scan\b/.test(r)))
          expect(c, p).toContain("--sandbox host");
        expect(body, p).not.toMatch(
          /qcr-json|docker (run|login|pull)|qcr-setup\.sh|CLAUDE_PLUGIN_ROOT/,
        );
      }
    },
  );

  // MUTATION: drop the npx fallback from the pick-qcr partial — this fails.
  it.each(HOSTS)("%s: probes the installed qcr first and falls back to the pinned npx", (t) => {
    for (const [p, body] of bodies(t)) {
      const probe = body.indexOf("qcr --schema 2 version");
      const npx = body.indexOf("npx -y @quickchatai/quickreview@0.0.0-golden");
      expect(probe, p).toBeGreaterThanOrEqual(0);
      expect(npx, p).toBeGreaterThan(probe);
      expect(body, p).toMatch(/nonzero/);
      expect(body, p).toMatch(/not JSON|but JSON/);
      expect(body, p).not.toMatch(/\{\{/);
    }
  });

  it.each(HOSTS)("%s: setup offers the global install and hands over the login line", (t) => {
    const setup = bodies(t).find(([p]) => /setup/.test(p))![1];
    expect(setup).toContain("npm i -g @quickchatai/quickreview");
    expect(setup).toContain("`qcr login`");
    expect(setup).toContain("`npx -y @quickchatai/quickreview@0.0.0-golden login`");
    expect(setup).toContain(NAMES[t]!["review"]!.invoke);
  });

  // MUTATION: drop "Wait for a go" from plugins/qcr/templates/review.md's host
  // body — this fails.
  it.each(HOSTS)("%s: review previews before it runs and posts only on --to pr", (t) => {
    const review = bodies(t).find(([p]) => /review/.test(p))![1];
    expect(review).toMatch(/--preview/);
    expect(review).toMatch(/Wait for a go/);
    expect(review).toMatch(/only with `--to pr`/);
    expect(review).not.toMatch(/--post/);
  });

  // Every call the agent is told to make goes through qcr scan's own parser:
  // a full `qcr --schema 2 scan …` call; a bare fragment that leads with a
  // scan verb (`status --wait --timeout S`), parsed as `scan <fragment>`;
  // and a bare flag a step names (`--path DIR`, `--limit N`), parsed on the
  // call it adds to, the full call before it. A placeholder (`S`, `N`, a
  // valued flag named alone) takes a sample value.
  // MUTATION: spell a scan call in plugins/qcr/templates/scan.md's host body
  // `scan unit propose` — this fails.
  // MUTATION: spell `status --wait --timout S` in that body — this fails.
  // MUTATION: spell `--limt N` in step 4 of that body — this fails.
  const SCAN_VERBS = new Set([
    "preview",
    "start",
    "status",
    "stop",
    "findings",
    "matches",
    "match",
    "suggestions",
    "stage2",
    "dismiss",
    "login",
    "units",
    "doctor",
    "rebuild",
  ]);
  const SAMPLE: Record<string, string> = {
    "--path": "src",
    "--sha": "HEAD",
    "--timeout": "5",
    "--limit": "3",
    "--severity": "high",
    "--validity": "likely",
    "--lens": "security",
    "--state": "new",
    "--unit": "app",
    "--key": "K",
  };
  // qcr's own flags, taken before the scan's parse (src/scancli.ts, src/schemaflag.ts)
  const OWN = new Set(["--sandbox", "--schema", "--json"]);
  const words = (span: string): string[] => {
    const raw = span
      .replace(/^`+|`+$/g, "")
      .trim()
      .split(/\s+/);
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i]!;
      if (OWN.has(a)) {
        if (a !== "--json") i++;
        continue;
      }
      const next = raw[i + 1];
      if (a in SAMPLE) {
        out.push(
          a,
          next === undefined || next.startsWith("--") || /^[A-Z]+$/.test(next) ? SAMPLE[a]! : next,
        );
        if (next !== undefined && !next.startsWith("--")) i++;
      } else out.push(a);
    }
    return out;
  };
  it.each(HOSTS)("%s: every scan call the body names is one qcr scan parses", (t) => {
    let parsed = 0;
    for (const [p, body] of bodies(t)) {
      let last: string[] | null = null;
      for (const m of body.matchAll(/`[^`\n]+`/g)) {
        const span = m[0];
        const first = span.replace(/^`+/, "").split(/\s+/)[0]!;
        let argv: string[];
        if (/--schema 2 scan\b/.test(span)) {
          const w = words(span);
          argv = w.slice(w.indexOf("scan") + 1);
          last = argv;
        } else if (SCAN_VERBS.has(first)) argv = words(span);
        else if (first.startsWith("--") && !OWN.has(first) && last !== null)
          argv = [...last, ...words(span)];
        else continue;
        expect(() => parseScanArgs(argv), `${p}: ${span} → ${argv.join(" ")}`).not.toThrow();
        parsed++;
      }
    }
    expect(parsed).toBeGreaterThan(10);
  });

  // A repo's first scan has no unit cut, and the preview stops on it; the
  // body makes one rather than ending there.
  // MUTATION: drop the no-cut branch from plugins/qcr/templates/scan.md's host
  // body — this fails.
  it.each(HOSTS)("%s: scan proposes the first unit cut and saves it on a go", (t) => {
    const scan = bodies(t).find(([p]) => /scan/.test(p))![1];
    const at = [
      "no saved unit cut",
      "`qcr --schema 2 scan units propose --sandbox host`",
      "ask whether to save it",
      "`qcr --schema 2 scan units save --sandbox host`",
      "preview again",
    ].map((s) => scan.indexOf(s));
    expect(
      at.every((i) => i >= 0),
      String(at),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // a draft save refuses is fixed with the adjust ops qcr takes, every one named
    // MUTATION: add an op to ADJUST_OPS in packages/pi-plugin/src/scan/unitcut.ts — this fails.
    expect(scan).toContain("`qcr --schema 2 scan units adjust --file - --sandbox host`");
    const named = /a JSON array of ops on stdin \(([^;]+);/.exec(scan)?.[1] ?? "";
    expect([...named.matchAll(/`(\w+)`/g)].map((m) => m[1])).toEqual([...ADJUST_OPS]);
  });

  // Under `[scan] threat_model` (the security profile sets "auto") a preview
  // can carry stage 0, and the scan's own start is refused until it has run:
  // the body prices stage 0 on its own, starts it with its key, waits, and
  // previews again, rather than starting with `preview.key` and looping on
  // the refusal. Every `threat_model_stage` field it names is one the
  // preview carries (the record below breaks the typecheck when one goes).
  // MUTATION: drop the stage-0 branch from plugins/qcr/templates/scan.md's
  // host body — this fails.
  const STAGE0_FIELDS: Record<keyof ThreatModelPreview, true> = {
    key: true,
    mode: true,
    sha: true,
    why: true,
    existing: true,
    estimate_usd: true,
    cap_usd: true,
    tier: true,
    inventory: true,
    blockers: true,
  };
  it.each(HOSTS)("%s: scan drafts a due threat model first, at its own price", (t) => {
    const scan = bodies(t).find(([p]) => /scan/.test(p))![1];
    const at = [
      "`preview.threat_model_stage`",
      "`cap_usd`",
      "ask for a go for this stage alone",
      "`qcr --schema 2 scan threat-model start --key <preview.threat_model_stage.key> --sandbox host`",
      "`qcr --schema 2 scan status --wait --sandbox host`",
      "`qcr --schema 2 scan preview --sandbox host` again",
      "\n2. ",
    ].map((s) => scan.indexOf(s));
    expect(
      at.every((i) => i >= 0),
      String(at),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const named = [...scan.matchAll(/threat_model_stage\.(\w+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const f of named) expect(Object.keys(STAGE0_FIELDS), f).toContain(f);
  });

  // `--security` (#28) plans the security family on top of the usual plan;
  // a host body that never names it gives a security ask an ordinary plan.
  // MUTATION: drop `--security` from plugins/qcr/templates/review.md's host
  // body — this fails.
  it.each(HOSTS)("%s: review offers --security, a flag qcr review takes", (t) => {
    const review = bodies(t).find(([p]) => /review/.test(p))![1];
    expect(review).toMatch(/add `--security`/);
    expect(parseReviewArgs(["--security", "--preview"])).toMatchObject({ securityRequest: true });
  });

  // The `security` preset keeps the pass-sec-* family and the validator,
  // nothing else; the pi body says so and names the flag beside it.
  // MUTATION: put "the security and data-safety lenses only" back in
  // review.md's pi body — this fails.
  // MUTATION: add pass-data-safety to SECURITY_LENSES — this fails.
  it("pi: review describes the security preset as it plans, and names --security", () => {
    const review = bodies("pi").find(([p]) => /review/.test(p))![1];
    expect(SECURITY_FAMILY.length).toBe(14);
    expect(review).toMatch(
      /`security` \(the fourteen `pass-sec-\*` security lenses and the validator, and no other lens/,
    );
    expect(review).not.toMatch(/data-safety lenses only/);
    expect(SECURITY_LENSES).not.toContain("pass-data-safety");
    expect(SECURITY_LENSES).not.toContain("pass-security");
    expect(review).toMatch(/data-safety lenses are skipped/);
    expect(review).toContain("`/qcr-review --security`");
  });

  it.each(HOSTS)("%s: review and scan say what a refusal of the contract looks like", (t) => {
    for (const [p, body] of bodies(t).filter(([p]) => /review|scan/.test(p))) {
      expect(body, p).toMatch(/schema_version/);
      expect(body, p).toMatch(/exits 3 with nothing on stdout/);
    }
  });

  // MUTATION: move the login check above the version probe in
  // plugins/qcr/templates/setup.md's host body — this fails.
  it.each(HOSTS)("%s: setup checks qcr's contract, then the login", (t) => {
    const setup = bodies(t).find(([p]) => /setup/.test(p))![1];
    const at = ["qcr --schema 2 version", "auth.json", "`qcr login`"].map((s) => setup.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(setup).not.toMatch(/CLAUDE_PLUGIN_ROOT|qcr-setup\.sh/);
  });

  // MUTATION: delete plugins/qcr/templates/notes/codex.md — this fails.
  it("only Codex's bodies ask for the network, once, before the first call", () => {
    for (const t of HOSTS)
      for (const [p, body] of bodies(t)) {
        const asks = body.split("require_escalated").length - 1;
        expect(asks, p).toBe(t === "codex" ? 1 : 0);
        if (t === "codex")
          expect(body.indexOf("require_escalated"), p).toBeLessThan(body.indexOf("qcr --schema 2"));
      }
  });

  it("each body names the other commands in its own host's spelling", () => {
    expect(bodies("codex").find(([p]) => /review/.test(p))![1]).toContain("$qcr:setup");
    expect(bodies("copilot").find(([p]) => /review/.test(p))![1]).toContain("/qcr-setup");
    expect(bodies("claude").find(([p]) => /review/.test(p))![1]).toContain("/qcr:setup");
  });

  // MUTATION: render pi from the host bodies — this fails.
  it("pi's bodies hand the person the /qcr- line and never run qcr", () => {
    for (const [p, body] of bodies("pi")) {
      const name = p.split("/").at(-2)!;
      expect(body, p).toContain(`/${name}`);
      expect(body, p).toMatch(/A slash command is the person's to type/);
      expect(body, p).not.toMatch(/qcr --schema|npx/);
    }
  });
});

describe("the contract", () => {
  // MUTATION: set TEMPLATE_CONTRACT to 3 — this fails.
  it("the templates' contract is one this qcr prints", () => {
    expect(supportedContracts()).toContain(TEMPLATE_CONTRACT);
  });

  // One number moves every template at once. The bodies above spell the
  // calls with the number itself (`qcr --schema 2 …`), so it is pinned here.
  // MUTATION: set TEMPLATE_CONTRACT back to 1 — the review skill reads
  // `preview.model`, `preview.price_basis` and a null estimate, which a
  // contract-1 payload on a model with no measured price never carries (the
  // call is refused instead), and this fails.
  it("is contract 2: the code's own review, scan and version families", () => {
    expect(TEMPLATE_CONTRACT).toBe(2);
    expect(CONTRACTS[TEMPLATE_CONTRACT]).toEqual({
      review: REVIEW_SCHEMA_VERSION,
      scan: SCAN_SCHEMA_VERSION,
      version: VERSION_SCHEMA_VERSION,
    });
  });

  // MUTATION: drop the `unmeasured` bullet from plugins/qcr/templates/review.md's
  // host body — an agent shows a null estimate as a price (or as $0), and
  // this fails. MUTATION: tell the agent to pass `--model` for the provider
  // question — the answer holds for one run, and this fails.
  it.each(HOSTS)("%s: review reads the model and what the price is known from", (t) => {
    const review = bodies(t).find(([p]) => /review/.test(p))![1];
    expect(review).toContain("`preview.model.spec`");
    expect(review).toContain("`preview.price_basis`");
    // every basis the preview can carry has its own instruction
    for (const basis of PRICE_BASES) expect(review, basis).toContain(`\`${basis}\``);
    expect(review).toMatch(/`unmeasured`: `preview\.estimate_usd` is `null`/);
    expect(review).toMatch(/Never show a price you worked out yourself/);
    expect(review).toMatch(/no dollar stop/);
    // the provider question: the answer is kept, never passed as a one-run flag
    expect(review).toContain("`preview.model.ask`");
    expect(review).toContain("`preview.alternatives[].spec`");
    expect(review).toContain("`qcr model use <provider>`");
    expect(review).toMatch(/Do not pass `--model` for this/);
    // the key is the person's go, on a review with no estimate too
    expect(review).toMatch(/The key starts a review over the limit, and one with no estimate/);
  });
});

describe("writing and checking a rendered tree", () => {
  it("writes the render, then finds a stale, missing or extra file", () => {
    const out = join(tmp, "pi");
    const files = rendered("pi");
    mkdirSync(join(out, "skills", "old"), { recursive: true });
    writeFileSync(join(out, "skills", "old", "SKILL.md"), "stale\n");
    writeFileSync(join(out, "package.json"), "{}\n");
    writeRendered(files, out, "skills/");
    expect(renderedDiff(files, out, "skills/")).toEqual([]);
    // what lies outside the rendered folder is left alone
    expect(readFileSync(join(out, "package.json"), "utf8")).toBe("{}\n");
    writeFileSync(join(out, "skills", "qcr-scan", "SKILL.md"), "edited\n");
    rmSync(join(out, "skills", "qcr-setup"), { recursive: true });
    mkdirSync(join(out, "skills", "extra"));
    writeFileSync(join(out, "skills", "extra", "SKILL.md"), "x\n");
    expect(renderedDiff(files, out, "skills/")).toEqual([
      "changed skills/qcr-scan/SKILL.md",
      "missing skills/qcr-setup/SKILL.md",
      "extra skills/extra/SKILL.md",
    ]);
  });
});
