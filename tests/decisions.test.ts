// The owner's 2026-10-03 grilling decisions (gap plan): a no-budget line for
// every lens, a narrowed behaviour-delta trigger, a deterministic
// loosened-assertion hint for pass-tests, the repeated-copy design finding and
// the regression-test request. PR builds only; no benchmark names in prompts.
import { describe, expect, it } from "vitest";
import { addendaForPass, PASS_ADDENDA } from "../src/include.js";

const NO_BENCHMARK_NAMES =
  /qodo|martian|swe-?prbench|aacr|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|metaflow|spyder|cal\.com|keycloak|sentry|grafana|discourse|freecad|clickhouse|dbeaver|ollama|lvgl|electron|immich|ragflow|filament|kestra|browser-use|cherry/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("no budget", () => {
  it("binds every lens in PR builds, not the validator, not scans", () => {
    for (const p of ["pass-baseline", "pass-sweep", "pass-behaviour-delta", "pass-tests", "pass-security", "pass-style"])
      expect(ids(p), p).toContain("no-budget");
    expect(ids("pass-validate")).not.toContain("no-budget");
    expect(ids("pass-baseline", "scan")).not.toContain("no-budget");
  });
  it("says there is no budget and to report every real issue — and nothing more", () => {
    const t = text("no-budget");
    expect(t).toMatch(/No token, time or finding budget/);
    expect(t).toMatch(/Report every real issue/);
    expect(t).not.toMatch(/per hunk|enumerate|checked:/i);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});
