// The config a host's setup writes (src/onboard/steps/hostconfig.ts): the
// repository on the shipped template or on the install's own config, the
// filers off on a host-managed install, and never another `dry_run` than the
// text had. Pure: every case is a text in and a text out, over the real
// shipped template.
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { readConfigToml } from "@quickchatai/pi-quickreview/src/shippedconfig.js";
import { parseCaps } from "../src/config.js";
import {
  HOST_MANAGED_CAPS,
  completeFromTemplate,
  renderHostConfig,
  type HostConfigChoice,
} from "../src/onboard/steps/hostconfig.js";

const TEMPLATE = readFileSync(new URL("../config.example.toml", import.meta.url), "utf8");
const MARKER_ONLY = '[github]\ntoken_source = "host"\n';
const CHOICE: HostConfigChoice = {
  repo: "acme/widgets",
  baseBranch: "trunk",
  timezone: "Europe/Warsaw",
};

type Doc = Record<string, unknown>;
const doc = (text: string): Doc => parse(text) as Doc;
const table = (text: string, name: string): Record<string, unknown> =>
  doc(text)[name] as Record<string, unknown>;
const rendered = (existing: string | null, choice = CHOICE): string => {
  const r = renderHostConfig(existing, TEMPLATE, choice);
  if (!r.ok) throw new Error(r.why);
  return r.text;
};
/** The root `dry_run` line as written, comment and all. */
const dryRunLine = (text: string): string | undefined => /^dry_run\s*=.*$/m.exec(text)?.[0];

describe("a new config", () => {
  it("is the shipped template with the repository, its branch and the machine's timezone", () => {
    const text = rendered(null);
    expect(table(text, "github")["repo"]).toBe("acme/widgets");
    expect(table(text, "github")["base_branch"]).toBe("trunk");
    expect(table(text, "ops")["timezone"]).toBe("Europe/Warsaw");
    // the template's own flag, untouched: it ships true
    expect(doc(text)["dry_run"]).toBe(true);
    expect(dryRunLine(text)).toBe(dryRunLine(TEMPLATE));
    // every comment of the template is still there
    expect(text.split("\n").length).toBe(TEMPLATE.split("\n").length);
  });

  it("an install that keeps its own credential keeps its filers", () => {
    const r = renderHostConfig(null, TEMPLATE, CHOICE);
    expect(r).toMatchObject({ ok: true, hostManaged: false, completed: false });
    expect(table(rendered(null), "caps")).toEqual(table(TEMPLATE, "caps"));
  });

  it("a branch GitHub did not name leaves the template's", () => {
    const text = rendered(null, { ...CHOICE, baseBranch: null });
    expect(table(text, "github")["base_branch"]).toBe(table(TEMPLATE, "github")["base_branch"]);
  });
});

describe("a config holding only a host's marker", () => {
  // MUTATION: patch the marker-only file in place instead of completing it
  // from the template — the result states no dry_run, and this fails.
  it("is completed from the template: it states dry_run, as the template does, and keeps the marker", () => {
    const r = renderHostConfig(MARKER_ONLY, TEMPLATE, CHOICE);
    expect(r).toMatchObject({ ok: true, hostManaged: true, completed: true });
    const text = rendered(MARKER_ONLY);
    expect(Object.hasOwn(doc(text), "dry_run")).toBe(true);
    expect(dryRunLine(text)).toBe(dryRunLine(TEMPLATE));
    expect(table(text, "github")).toMatchObject({
      token_source: "host",
      repo: "acme/widgets",
      base_branch: "trunk",
    });
    expect(table(text, "ops")["timezone"]).toBe("Europe/Warsaw");
  });

  // MUTATION: drop the `heldBack` loop in completeFromTemplate — the template's
  // own `[scan] sandbox` is then stated, the reading differs, and this fails.
  it("reads over the shipped defaults exactly as the marker did", () => {
    const whole = completeFromTemplate(MARKER_ONLY, TEMPLATE);
    if (!whole.ok) throw new Error(whole.why);
    expect(readConfigToml(whole.text, TEMPLATE)).toEqual(readConfigToml(MARKER_ONLY, TEMPLATE));
  });

  // The marker does not load without the mode whose credential is the file
  // (parseGithubSection), so the mode the host named is stated beside it.
  // MUTATION: write `auth` on every install — an install that keeps its own
  // credential then states a route its account step has not set up; this fails.
  it("states the auth mode the host named, beside the marker and nowhere else", () => {
    const named = { ...CHOICE, auth: "user" as const };
    expect(table(rendered(MARKER_ONLY, named), "github")["auth"]).toBe("user");
    // a host that named none leaves the config's own
    expect(table(rendered(MARKER_ONLY), "github")).not.toHaveProperty("auth");
    // an install that keeps its own credential: the account step writes the mode
    expect(table(rendered(null, named), "github")).not.toHaveProperty("auth");
    // already there: nothing is rewritten
    const both = '[github]\ntoken_source = "host"\nauth = "user"\n';
    expect(rendered(both, named)).toBe(rendered(both));
  });

  // MUTATION: drop HOST_MANAGED_CAPS from the edits — this fails.
  it("turns the improvement-PR filer and the bot's own issues off", () => {
    const caps = table(rendered(MARKER_ONLY), "caps");
    expect(caps).toMatchObject({
      improvement_pr_per_day: 0,
      improvement_pr_per_week: 0,
      issues_per_day: 0,
    });
    // the size caps are not the switch, and stay
    expect(caps["improvement_pr_max_lines"]).toBe(
      table(TEMPLATE, "caps")["improvement_pr_max_lines"],
    );
    expect(HOST_MANAGED_CAPS.map((e) => `${e.section}.${e.key}`)).toEqual([
      "caps.improvement_pr_per_day",
      "caps.improvement_pr_per_week",
      "caps.issues_per_day",
    ]);
  });

  // The filers refuse at a cap of zero: the day's count is never below it
  // (src/improvements.ts `improvementRateReason`, `issueRateReason`).
  it("writes caps the daemon's own loader takes", () => {
    const caps = parseCaps(table(rendered(MARKER_ONLY), "caps"));
    expect(caps.improvement_pr_per_day).toBe(0);
    expect(caps.improvement_pr_per_week).toBe(0);
    expect(caps.issues_per_day).toBe(0);
  });

  it("carries the other keys a host wrote, and its own timezone when it named one", () => {
    const partial = `${MARKER_ONLY}secrets_dir = "/srv/secrets"\n\n[ops]\ntimezone = "Asia/Tokyo"\n`;
    const text = rendered(partial);
    expect(table(text, "github")["secrets_dir"]).toBe("/srv/secrets");
    expect(table(text, "ops")["timezone"]).toBe("Asia/Tokyo");
  });

  it("refuses a partial config it cannot carry onto the template, in words", () => {
    const tables = `${MARKER_ONLY}\n[[extra]]\nname = "a"\n`;
    const r = renderHostConfig(tables, TEMPLATE, CHOICE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/leaves out dry_run.*nothing was written/);
  });
});

describe("a config that is already there", () => {
  it("is patched in place: only the keys that change", () => {
    const before = TEMPLATE.replace(/^#token_source = "self"$/m, 'token_source = "host"');
    expect(before).not.toBe(TEMPLATE);
    const text = rendered(before);
    const changed = text.split("\n").filter((line, i) => line !== before.split("\n")[i]);
    expect(changed.map((l) => l.split("=")[0]!.trim()).sort()).toEqual([
      "base_branch",
      "improvement_pr_per_day",
      "improvement_pr_per_week",
      "issues_per_day",
      "repo",
    ]);
    // a second setup changes nothing
    expect(rendered(text)).toBe(text);
  });

  it("refuses a config that is not TOML", () => {
    const r = renderHostConfig("[github\nrepo = ", TEMPLATE, CHOICE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/not valid TOML.*nothing was written/);
  });
});

describe("dry_run is not this writer's", () => {
  // MUTATION: add { section: "", key: "dry_run", value: "false" } to
  // HOST_MANAGED_CAPS, or to the edits renderHostConfig builds — every case
  // here is refused or states another flag, and this fails.
  it("the text that comes out states the same dry_run as the text that went in", () => {
    const live = TEMPLATE.replace(/^dry_run = true/m, "dry_run = false");
    const hosted = (text: string): string =>
      text.replace(/^#token_source = "self"$/m, 'token_source = "host"');
    for (const [existing, flag] of [
      [null, true],
      [TEMPLATE, true],
      [hosted(TEMPLATE), true],
      [MARKER_ONLY, true],
      [live, false],
      [hosted(live), false],
    ] as const) {
      const text = rendered(existing);
      expect(readConfigToml(text, TEMPLATE)["dry_run"]).toBe(flag);
      // and where the text stated the flag itself, the line is byte for byte its own
      if (existing !== null && dryRunLine(existing) !== undefined)
        expect(dryRunLine(text)).toBe(dryRunLine(existing));
    }
  });

  it("names no dry_run key among its own edits", () => {
    for (const edit of HOST_MANAGED_CAPS)
      expect(`${edit.section}.${edit.key}`).not.toMatch(/dry_run/);
  });
});
