// The repository the home's setup checklist picks, written into config.toml:
// the config fill's writer (configfill.ts) over the template or the
// install's config, never touching dry_run.
import { parse } from "smol-toml";
import { assertNoDryRunEdit, changedEdits, patchToml, tomlString } from "./configfill.js";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The repository pick, as the config takes it. */
export interface RepoConfigChoice {
  repo: string;
  baseBranch: string | null;
  timezone: string | null;
  ownerName: string | null;
  ownerLogin: string | null;
}

/** A config value as text, "" when absent or not a string. */
function valueIn(doc: Record<string, unknown> | null, section: string, key: string): string {
  const table = doc?.[section];
  if (typeof table !== "object" || table === null) return "";
  const v = (table as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

/** The config text with the choice in it, from `existing` (null: none yet,
 * so the template). What changed is named; a config that is not TOML is
 * refused, since what it holds cannot be seen. */
export function renderRepoConfig(
  existing: string | null,
  template: string,
  choice: RepoConfigChoice,
): { ok: true; text: string; wrote: string[] } | { ok: false; why: string } {
  const fresh = existing === null;
  const source = existing ?? template;
  let doc: Record<string, unknown> | null = null;
  try {
    doc = parse(source);
  } catch (err) {
    return {
      ok: false,
      why: `${fresh ? "the shipped template" : "the config"} is not valid TOML (${message(err)}); nothing was written`,
    };
  }
  const fill = (section: string, key: string): boolean =>
    fresh || valueIn(doc, section, key) === "";
  const wanted = [
    { section: "github", key: "repo", value: tomlString(choice.repo) },
    ...(choice.baseBranch
      ? [{ section: "github", key: "base_branch", value: tomlString(choice.baseBranch) }]
      : []),
    ...(choice.timezone && fill("ops", "timezone")
      ? [{ section: "ops", key: "timezone", value: tomlString(choice.timezone) }]
      : []),
    ...(choice.ownerName && fill("owner", "name")
      ? [{ section: "owner", key: "name", value: tomlString(choice.ownerName) }]
      : []),
    ...(choice.ownerLogin && fill("owner", "github_login")
      ? [{ section: "owner", key: "github_login", value: tomlString(choice.ownerLogin) }]
      : []),
  ];
  assertNoDryRunEdit(wanted);
  const edits = changedEdits(source, wanted);
  const text = edits.length > 0 ? patchToml(source, edits) : source;
  let after: Record<string, unknown>;
  try {
    after = parse(text);
  } catch (err) {
    return {
      ok: false,
      why: `the patched config would not parse (${message(err)}); nothing was written`,
    };
  }
  if (valueIn(after, "github", "repo") !== choice.repo)
    return {
      ok: false,
      why: "the patched config does not carry the repository; nothing was written",
    };
  if (fresh && after["dry_run"] !== true)
    return {
      ok: false,
      why: "the shipped template no longer ships dry_run = true; nothing was written (invariant 6)",
    };
  return { ok: true, text, wrote: edits.map((e) => `[${e.section}] ${e.key}`) };
}
