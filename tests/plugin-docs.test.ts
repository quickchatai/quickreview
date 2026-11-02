// The host plugins' install docs against the renderer's names table
// (plugins/qcr/render.mjs `NAMES`): docs/plugin.md's install table and the
// README's install lines name every host the installer takes, each with what
// that host's person types, spelled as the render spells it. Both list the
// update and uninstall verbs, and the page carries the move from the
// Docker-based Claude Code plugin.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTS, NAMES, TARGETS, loadSource } from "../plugins/qcr/render.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const PAGE = read("docs/plugin.md");
const README = read("README.md");

/** The commands a host plugin carries: those with a template. */
const COMMANDS = Object.keys(loadSource().commands);
const invokes = (host: string): string[] => COMMANDS.map((c) => NAMES[host]![c]!.invoke);
/** Every invoke-shaped spelling in `text`, in order. */
const spelled = (text: string): string[] => text.match(/[/$]qcr[:-][a-z]+/g) ?? [];
/** The Docker-era plugin's uninstall, by its whole id, on its own line. */
const OLD_UNINSTALL = "claude plugin uninstall qcr@quickreview\n";
const installOf = (host: string): RegExp => new RegExp(`plugin install --to ${host}(?![\\w-])`);

describe("docs/plugin.md", () => {
  const rows = PAGE.split("\n").filter((l) => l.startsWith("|"));

  // MUTATION: write `/qcr-review` in the Gemini CLI row of docs/plugin.md's
  // install table, or drop the opencode row — this fails.
  it.each(HOSTS)("%s: one install row, with the invoke spellings of NAMES", (host) => {
    const mine = rows.filter((l) => installOf(host).test(l));
    expect(mine, host).toHaveLength(1);
    expect(spelled(mine[0]!), host).toEqual(invokes(host));
  });

  it("names no invoke spelling the renderer does not render", () => {
    const known = new Set(
      TARGETS.flatMap((t) => Object.values(NAMES[t]!).map((n: { invoke: string }) => n.invoke)),
    );
    expect(spelled(PAGE).filter((s) => !known.has(s))).toEqual([]);
  });

  it("gives the npx install, --to all, update and uninstall", () => {
    expect(PAGE).toContain("npx @quickchatai/quickreview plugin install --to claude");
    expect(PAGE).toContain("qcr plugin install --to all");
    expect(PAGE).toContain("qcr plugin update");
    expect(PAGE).toContain("qcr plugin uninstall --from <host>");
    expect(PAGE).toContain("qcr plugin uninstall --from all");
  });

  // Both plugins are named `qcr`, so a bare `claude plugin uninstall qcr`
  // may pick the new one: the step names the old plugin's whole id.
  // MUTATION: write `claude plugin uninstall qcr` in docs/plugin.md's
  // migration block — this fails.
  it("tells a user of the Docker-based plugin to uninstall it by its id, then run the installer", () => {
    const old = PAGE.indexOf(OLD_UNINSTALL);
    const fresh = PAGE.indexOf("npx @quickchatai/quickreview plugin install --to claude", old);
    expect(old).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeGreaterThan(old);
  });
});

describe("README.md", () => {
  const lines = README.split("\n");

  // MUTATION: drop the Antigravity line from the README's install block, or
  // write `/qcr:review` on its Codex line — this fails.
  it.each(HOSTS)("%s: one install line, with the invoke spellings of NAMES", (host) => {
    const mine = lines.filter((l) => installOf(host).test(l));
    expect(mine, host).toHaveLength(1);
    expect(spelled(mine[0]!), host).toEqual(invokes(host));
  });

  it("gives --to all, update and uninstall, and links the install page", () => {
    expect(README).toMatch(/plugin install --to all\b/);
    expect(README).toMatch(/plugin update\b/);
    expect(README).toMatch(/plugin uninstall --from\b/);
    expect(README).toContain("[docs/plugin.md](docs/plugin.md)");
  });
});

describe("the changelog", () => {
  // MUTATION: move the migration lines under `## 1.3.2` in CHANGELOG.md — this fails.
  it("carries the migration from the Docker-based plugin in its unreleased section", () => {
    const log = read("CHANGELOG.md");
    const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## )/m.exec(log)?.[1] ?? "";
    const old = unreleased.indexOf(OLD_UNINSTALL);
    expect(old).toBeGreaterThanOrEqual(0);
    expect(
      unreleased.indexOf("npx @quickchatai/quickreview plugin install --to claude", old),
    ).toBeGreaterThan(old);
  });
});
