// Freeze fixes 2 (2026-10-03): the cross-benchmark miss analysis — general
// bug-class rules, PR builds only, no benchmark names in any prompt text.
import { describe, expect, it } from "vitest";
import { addendaForPass, PASS_ADDENDA } from "../src/include.js";

const NO_BENCHMARK_NAMES =
  /qodo|martian|swe-?prbench|aacr|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|spyder|cal\.com|keycloak|sentry|grafana|discourse|freecad|clickhouse|dbeaver|ollama|lvgl|electron|immich|ragflow|filament/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("exhaust the site", () => {
  it("binds baseline, sweep, widened and behaviour-delta, PR builds only", () => {
    for (const p of ["pass-baseline", "pass-sweep", "pass-widened", "pass-behaviour-delta"])
      expect(ids(p), p).toContain("exhaust-the-site");
    expect(ids("pass-security")).not.toContain("exhaust-the-site");
    expect(ids("pass-baseline", "scan")).not.toContain("exhaust-the-site");
  });
  it("names siblings, twins, every consequence and the other failures, one finding per fix", () => {
    const t = text("exhaust-the-site");
    expect(t).toMatch(/Siblings of the same shape/);
    expect(t).toMatch(/The twin/);
    expect(t).toMatch(/Every consequence/);
    expect(t).toMatch(/other calls in that loop/);
    expect(t).toMatch(/needs its OWN fix as its own finding/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});
