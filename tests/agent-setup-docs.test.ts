// docs/agent-setup.md is the page a coding agent follows when a person pastes
// the README's Quickstart prompt into it. It is held to the code it tells the
// agent to run:
//   - its host table names the installer's hosts (src/plugincli.ts
//     PLUGIN_HOSTS), in their order, each with what that host's person types
//     (plugins/qcr/render.mjs NAMES);
//   - every `npx -y @quickchatai/quickreview <verb>` it gives is a verb the
//     bin's front door routes (src/qcrbin.ts binRoute), and no npx of the
//     package goes without `-y`, which a terminal would stop at;
//   - every review it gives parses as a preview (src/reviewargs.ts), and
//     step 4's model check asks for JSON;
//   - the README's prompt opens the Quickstart and fetches the page by its
//     raw URL on the package's own repository, and repeats no install line.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NAMES, loadSource } from "../plugins/qcr/render.mjs";
import { PLUGIN_HOSTS } from "../src/plugincli.js";
import { binRoute } from "../src/qcrbin.js";
import { parseReviewArgs } from "../src/reviewargs.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const PAGE_PATH = "docs/agent-setup.md";
const PAGE = read(PAGE_PATH);
const README = read("README.md");

/** The commands a host plugin carries: those with a template. */
const COMMANDS = Object.keys(loadSource().commands);
/** Every invoke-shaped spelling in `text`, in order. */
const spelled = (text: string): string[] => text.match(/[/$]qcr[:-][a-z]+/g) ?? [];

/** The part of `text` under the `## ` heading that starts with `title`. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}`);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("docs/agent-setup.md: the host table", () => {
  // the table's rows, without its header and rule
  const rows = section(PAGE, "2.")
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2);
  const hostOf = (row: string): string | undefined =>
    /`([a-z]+)`/.exec(row.split("|")[2] ?? "")?.[1];

  // MUTATION: drop the Antigravity row from the page's host table, or add a
  // host to INSTALLERS in src/plugincli.ts — this fails.
  it("names every host the installer installs into, in its order", () => {
    expect(rows.map(hostOf)).toEqual([...PLUGIN_HOSTS]);
  });

  // MUTATION: write `/qcr-review` in the page's Gemini CLI row — this fails.
  it("gives each host what its person types, as the renderer spells it", () => {
    for (const row of rows) {
      const host = hostOf(row)!;
      expect(spelled(row), host).toEqual(COMMANDS.map((c) => NAMES[host]![c]!.invoke));
    }
  });
});

describe("docs/agent-setup.md: the commands", () => {
  /** Each `npx -y @quickchatai/quickreview …` the page gives, as its argv. */
  const calls = [...PAGE.matchAll(/npx -y @quickchatai\/quickreview(?:@\S+)? ([^`\n]+)/g)].map(
    (m) => m[1]!.trim().split(/\s+/),
  );

  // MUTATION: write `npx -y @quickchatai/quickreview install --to <host>` (no
  // `plugin`) in step 3, or drop step 4's `model --json` line — this fails.
  it("gives only verbs the bin's front door routes, one for each step", () => {
    expect(calls.map((a) => a[0])).toEqual(
      expect.arrayContaining(["plugin", "model", "login", "review"]),
    );
    for (const argv of calls) expect(binRoute(argv).route, argv.join(" ")).not.toBe("app");
  });

  // MUTATION: drop `-y` from the login line in step 4 — this fails.
  it("passes -y to every npx of the package", () => {
    expect(PAGE.match(/npx @quickchatai\/quickreview/g)).toBeNull();
  });

  // A review the page gives without `--preview` would start a paid run, and
  // one under the limit starts without asking. Step 4 reads the fields of
  // `model --json`.
  // MUTATION: drop --preview from step 5's review line, or --json from step
  // 4's first model line — this fails.
  it("gives every review as a preview, and step 4's model check as JSON", () => {
    const routed = calls.map((argv) => ({ argv, r: binRoute(argv) }));
    const reviews = routed.filter((c) => c.r.route === "review");
    expect(reviews.length).toBeGreaterThan(0);
    for (const { argv, r } of reviews) {
      const cmd = parseReviewArgs("args" in r ? r.args : []);
      expect(!cmd.help && cmd.preview, argv.join(" ")).toBe(true);
    }
    const model = routed.find((c) => c.r.route === "model");
    expect(model && "json" in model.r && model.r.json, "the first model call").toBe(true);
  });
});

describe("README.md: the prompt to paste into a coding agent", () => {
  const pkg = JSON.parse(read("package.json")) as { repository: { url: string } };
  const repo = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(pkg.repository.url)?.[1];
  const raw = `https://raw.githubusercontent.com/${repo}/main/${PAGE_PATH}`;
  const quickstart = section(README, "Quickstart");
  const prompt = /```text\n([\s\S]*?)```/.exec(quickstart)?.[1] ?? "";

  // MUTATION: point the prompt at docs/plugin.md, or at the page's
  // github.com/…/blob/ URL, which an agent's fetch gets as HTML — this fails.
  it("opens the Quickstart and fetches the page by its raw URL", () => {
    expect(repo).toBeDefined();
    expect(existsSync(join(ROOT, PAGE_PATH))).toBe(true);
    expect(prompt).toContain(raw);
    expect(quickstart.indexOf("```text")).toBeGreaterThan(0);
    expect(quickstart.indexOf("```text")).toBeLessThan(quickstart.indexOf("```sh"));
  });

  // MUTATION: put `npx @quickchatai/quickreview plugin install --to claude` in
  // the prompt, or drop the page from the Documentation list — this fails.
  it("repeats no install line, and the Documentation list links the page", () => {
    expect(prompt).not.toMatch(/plugin install/);
    expect(section(README, "Documentation")).toContain(`](${PAGE_PATH})`);
  });
});
