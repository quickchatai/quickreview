// Round-4 review calibrations, from the classes the round-3 default missed on
// the Martian tune20 set
// (bench/aacr/ext/martian-tuning/ROUND4-GAPS.md). Each rides the addendum
// registry (rule 6: seeds untouched), binds exactly the passes it names, and
// composes into PR builds only — a scan build is unchanged.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addendaForPass,
  buildAgents,
  PASS_ADDENDA,
} from "@quickchatai/pi-quickreview/src/include.js";
import { ALL_PASSES } from "@quickchatai/pi-quickreview/src/passes.js";

const root = resolve(process.cwd());
const NO_BENCHMARK_NAMES =
  /martian|golden|gifsicle|sentry|keycloak|grafana|cal\.com|discourse|arroyo|webassets/i;

let cache: Map<string, string> | undefined;
function built(): Map<string, string> {
  if (cache) return cache;
  const dir = mkdtempSync(join(tmpdir(), "qcr-calibration-r4-"));
  try {
    buildAgents(join(root, "agents"), dir, { root });
    cache = new Map(
      readdirSync(dir).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")]),
    );
    return cache;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function boundTo(id: string): { pr: string[]; scan: string[] } {
  const of = (mode: "pr" | "scan") =>
    ALL_PASSES.filter((p) =>
      addendaForPass(p, PASS_ADDENDA, "django", mode).some((a) => a.id === id),
    ).sort();
  return { pr: of("pr"), scan: of("scan") };
}

/** The lens's built body at whichever tier the default build produces first. */
function bodyOf(lens: string): string {
  const key = [...built().keys()].sort().find((k) => k.startsWith(`${lens}--`));
  expect(key, lens).toBeDefined();
  return built().get(key!)!;
}

function text(id: string): string {
  return PASS_ADDENDA.find((a) => a.id === id)!.text;
}

describe("concurrency-duplicate-init (pass-concurrency)", () => {
  it("binds pass-concurrency alone, PR builds only, after the planned-row rule", () => {
    expect(boundTo("concurrency-duplicate-init")).toEqual({ pr: ["pass-concurrency"], scan: [] });
    const order = addendaForPass("pass-concurrency").map((a) => a.id);
    expect(order.indexOf("concurrency-duplicate-init")).toBeGreaterThan(
      order.indexOf("concurrency-planned"),
    );
  });

  it("falsifies a duplicated initialisation on its own terms, and keeps cheap pure ones out", () => {
    const body = bodyOf("pass-concurrency");
    for (const phrase of [
      "A duplicated initialisation is damage of its own",
      "that is NOT what kills this candidate",
      "checked again after the exclusive lock is taken",
      "Pure, cheap, in-memory computation of an equal value: safe",
      "File or network I/O",
      "`P2` for a side effect or diverging values, `P3` for repeated I/O or computation only",
      "when the PR claims to FIX a race",
    ])
      expect(body, phrase).toContain(phrase);
    // the ratified sections it qualifies are still there, untouched
    expect(body).toContain("## Falsify your own finding before you emit it");
  });

  it("names no benchmark, project or PR", () => {
    expect(text("concurrency-duplicate-init")).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("write-predicate-scope (pass-baseline + pass-data-safety)", () => {
  it("binds the two lenses that read destructive queries, PR builds only", () => {
    expect(boundTo("write-predicate-scope")).toEqual({
      pr: ["pass-baseline", "pass-data-safety"],
      scan: [],
    });
  });

  it("reads every OR branch and precedence group of a DELETE/UPDATE filter for the scoping conditions", () => {
    for (const lens of ["pass-baseline", "pass-data-safety"]) {
      const body = bodyOf(lens);
      for (const phrase of [
        "Every branch of a DELETE or UPDATE filter carries the scope",
        "check that EVERY branch carries every one of them",
        "`a AND b OR c` without parentheses scopes only the first branch",
        "the condition it lacks (and the sibling branch that has it)",
      ])
        expect(body, `${lens}: ${phrase}`).toContain(phrase);
    }
  });

  it("names no benchmark, project or PR", () => {
    expect(text("write-predicate-scope")).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("persistence-bypasses-callbacks (pass-baseline + pass-data-safety)", () => {
  it("binds baseline and data-safety, PR builds only", () => {
    expect(boundTo("persistence-bypasses-callbacks")).toEqual({
      pr: ["pass-baseline", "pass-data-safety"],
      scan: [],
    });
  });

  it("names the direct writes across stacks and asks what the lifecycle maintained", () => {
    for (const lens of ["pass-baseline", "pass-data-safety"]) {
      const body = bodyOf(lens);
      for (const phrase of [
        "A persistence call that skips callbacks skips what they maintain",
        "`collection.delete` on a `has_many :through`",
        "`QuerySet.update()`/`.delete()`",
        "bulk JPQL `UPDATE`/`DELETE`",
        "Prisma `updateMany`/`deleteMany`/`createMany`",
        "a counter cache or denormalised count",
        "Report only writes whose model has a lifecycle effect for them.",
      ])
        expect(body, `${lens}: ${phrase}`).toContain(phrase);
    }
  });

  it("names no benchmark, project or PR", () => {
    expect(text("persistence-bypasses-callbacks")).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("removed-rule-other-consumers (pass-ui + pass-sweep + pass-widened)", () => {
  it("binds the three lenses that read removed rules against their consumers, PR builds only", () => {
    expect(boundTo("removed-rule-other-consumers")).toEqual({
      pr: ["pass-sweep", "pass-ui", "pass-widened"],
      scan: [],
    });
  });

  it("greps every consumer kind, including fallback and server-rendered templates", () => {
    for (const lens of ["pass-ui", "pass-sweep", "pass-widened"]) {
      const body = bodyOf(lens);
      for (const phrase of [
        "A removed or changed rule may have consumers the PR did not look at",
        "server-rendered and fallback templates",
        "email and print templates",
        "the removed or changed rule's `path:line` and the consumer's `path:line`",
        "do not dismiss it because the main app path is fine",
      ])
        expect(body, `${lens}: ${phrase}`).toContain(phrase);
    }
  });

  it("names no benchmark, project or PR", () => {
    expect(text("removed-rule-other-consumers")).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("contract-values-renumbered (pass-baseline + pass-backcompat + pass-contracts)", () => {
  it("binds baseline, backcompat and contracts, PR builds only", () => {
    expect(boundTo("contract-values-renumbered")).toEqual({
      pr: ["pass-backcompat", "pass-baseline", "pass-contracts"],
      scan: [],
    });
  });

  it("treats exit codes, wire enums and the like as contracts, and names reuse as the worst case", () => {
    for (const lens of ["pass-baseline", "pass-backcompat", "pass-contracts"]) {
      const body = bodyOf(lens);
      for (const phrase of [
        "A renumbered or reused contract value is a breaking change",
        "process exit codes, HTTP status codes and API error codes",
        "REUSES a value for a different meaning",
        "Reuse is the worst case",
        "unless the PR keeps the old value working or says",
        "not a style or docs remark",
      ])
        expect(body, `${lens}: ${phrase}`).toContain(phrase);
    }
  });

  it("names no benchmark, project or PR", () => {
    expect(text("contract-values-renumbered")).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("documented semantics (merged into validate-external-semantics, pass-validate)", () => {
  it("one rule, pass-validate alone, PR builds only", () => {
    expect(boundTo("validate-external-semantics")).toEqual({ pr: ["pass-validate"], scan: [] });
    expect(addendaForPass("pass-validate").map((a) => a.id)).not.toContain(
      "validate-documented-semantics",
    );
  });

  it("keeps reachability out of it and judges documented semantics from their documentation", () => {
    const body = bodyOf("pass-validate");
    for (const phrase of [
      "A missing source lowers `confidence`, never `reachability`",
      "reachability is how often the path runs",
      "Documented core semantics and published standards are evidence, not assumptions",
      "Behaviour specific to one third-party tool that its sources and documentation do not settle",
      "None of this lifts a candidate whose in-repo mechanism is wrong",
    ])
      expect(body, phrase).toContain(phrase);
  });

  it("names no benchmark, project or PR", () => {
    expect(text("validate-external-semantics")).not.toMatch(NO_BENCHMARK_NAMES);
  });
});
