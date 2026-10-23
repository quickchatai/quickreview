// [T8] — no production-dead module hides behind its own tests.
//
// Checked at module rather than symbol granularity: at symbol granularity the
// allowlist would run to hundreds of entries (pure helpers legitimately
// exercised only through their own unit tests), and an allowlist nobody reads
// teaches the reader to skim. At module granularity the set is small, and
// every entry is worth knowing about.
//
// Reachability from the real entrypoints, not "somebody imports it" — for the
// same reason [T3] uses a BFS: a dead module imported by another dead module
// looks alive, and a module whose only importer is dead is itself dead.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_DIRS, SRC_DIRS, sourceSpecifiers } from "./helpers/source-trees.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/**
 * Comments removed before the import scan.
 *
 * Without this the fence would read a commented-out import as a live edge,
 * and a planted orphan plus one commented-out import line in `wire.ts`
 * would pass clean — the likeliest artefact of someone commenting an import
 * while cutting a module.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("[T8] every src/ module (the app's and the core's) is reachable from a real entrypoint", () => {
  /**
   * The modules nothing in production can reach, each with what it is
   * and who drives it. Set equality both ways: a new orphan fails, and a
   * module that stops being an orphan fails too, so an entry cannot outlive
   * its reason.
   *
   * MUTATION: delete the `import … from "./severity.js"` lines that make
   * severity reachable — it appears here. Wire `posting.ts` into `wire.ts` —
   * its entry has to go.
   */
  const NOT_REACHED_FROM_PRODUCTION: ReadonlyArray<{ file: string; why: string }> = [
    {
      file: "packages/pi-plugin/src/engine/envmap.ts",
      why:
        "the table classifying every QCR_* and OPENVIKING_* name the extensions carry (P1.2). It is read " +
        "only by tests/extension-envmap.test.ts until the SDK session builder (P2) and the extension " +
        "factories (P3) take it. Delete this entry with the first import.",
    },
    {
      file: "src/piauthcopy.ts",
      why:
        "a re-export of src/engine/auth.ts (P2.10). The scan container imports it by path " +
        "(`dist/src/piauthcopy.js`, src/scanbox.ts LOGIN_SUMMARY_SCRIPT), a driver this static scan cannot " +
        "follow. Delete it, and point the script at engine/auth.js, with the companion rebuild.",
    },
    {
      file: "src/scanauth.ts",
      why:
        "a re-export of src/engine/auth.ts (P2.10). The scan container imports it by path " +
        "(`dist/src/scanauth.js`, src/scanbox.ts SCAN_AUTH_COPY_SCRIPT), a driver this static scan cannot " +
        "follow. Delete it, and point the script at engine/auth.js, with the companion rebuild.",
    },
    {
      file: "src/reviewrendercli.ts",
      why:
        "the `[review] render_outputs` renderer's command line. Driven by scripts/render-review.sh, which a " +
        "round session runs and which execs it out of dist/ — a real driver this static scan cannot follow.",
    },
    {
      file: "src/resumecheck.ts",
      why:
        "the static half of the resume rehearsal (P8.4): what a PR's session JSONL looks like before a worker " +
        "resumes it. Read by the rehearsal tests and helpers, and by src/preflight.ts, which is itself " +
        "driven by the image entrypoint rather than imported (see its entry). Delete this entry once a " +
        "production import reaches it.",
    },
    {
      file: "src/preflight.ts",
      why:
        "`daemon --preflight` (P8.4b): the cutover and release check. Run as `node dist/src/preflight.js` by " +
        "docker/entrypoint.sh from the new image, so a real driver this static scan cannot follow; no wire.ts, " +
        "cli.ts or extension imports it.",
    },
    {
      file: "src/memory/import.ts",
      why:
        "the one-time curated import. Driven by scripts/import-pi-memory.mjs, which loads it out of dist/ " +
        "at runtime — a real driver this static scan cannot follow, not an orphan.",
    },
    {
      file: "src/memory/legacy-file.ts",
      why: "the READ-ONLY reader over the archived MEMORY.md that the import above consumes. Same driver, same reason.",
    },
    // The pane-side entries the daemon's tmux panes run by path (the takeover and debug pi, P8.13/P8.13b):
    // the worker world is constructed in wire.ts (P8.15w) and names them as strings, which this static scan
    // cannot follow. Delete an entry only when its file does.
    {
      file: "src/ipc/launcher.ts",
      why:
        "the pane-side launcher (P7.2a): tmux runs `node dist/src/ipc/launcher.js <launch-file> -- pi ...` " +
        "for a takeover or debug pi (src/workerworld.ts names it), a real driver this static scan cannot follow.",
    },
    {
      file: "src/picwd.ts",
      why:
        "the entry both of those panes start pi's interactive CLI through, by path (src/takeoverpi.ts " +
        "PICWD_MAIN, P8.20a): pi's own CLI with the session cwd pinned to the pane's. A real driver this " +
        "static scan cannot follow, not an orphan.",
    },
    ...["takeoverpi.ts", "debugroundpi.ts"].map((f) => ({
      file: `src/${f}`,
      why:
        "the entry the TakeoverManager / DebugRoundManager run in their tmux pane by path (P8.13, P8.13b; " +
        "src/workerworld.ts names it): the borrowed login, pi's argv and env. A real driver this static scan " +
        "cannot follow, not an orphan.",
    })),
    {
      file: "src/ipc/postshim.ts",
      why:
        "the Node post client behind scripts/post-review.sh, approve-pr.sh and reply-thread.sh (P7.2). Driven " +
        "by those scripts, which exec it out of dist/ whenever QCR_IPC_SOCKET and QCR_IPC_CAP_FD are in " +
        "env: a real driver this static scan cannot follow, not an orphan.",
    },
    {
      file: "src/ipc/ghreadshim.ts",
      why:
        "the Node read client behind scripts/pr-context.sh, pr-checks.sh, pr-threads.sh and pr-self.sh: " +
        "the daemon makes their GitHub reads for the model's tool uid, which cannot mint a token. Driven " +
        "by those scripts, which run it out of dist/ whenever QCR_IPC_SOCKET and QCR_IPC_CAP_FD are in " +
        "env: a real driver this static scan cannot follow, not an orphan.",
    },
  ];

  it(
    "only the recorded modules are unreachable from wire.ts, cli.ts or an extension",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const files = SRC_DIRS.flatMap((d) => tsFiles(join(ROOT, d)));
      const importsOf = (f: string): string[] =>
        sourceSpecifiers(ROOT, f, stripComments(readFileSync(f, "utf8"))).filter((p) =>
          files.includes(p),
        );

      // The roots: the two process entrypoints, the operator one-shots, and
      // whatever the pi extensions reach into. `bench/cli.ts` because the qcr-bench sandbox image's entrypoint
      // (bench/aacr/in-container.sh) launches it; `openviking/sidecar-main.ts`
      // because the memory image's entrypoint (docker/memory/entrypoint.sh)
      // execs it out of dist/; `loginrefresh/main.ts` because the daemon
      // spawns it by path (src/loginrefresh/supervisor.ts, P8.22); `botworker.ts`
      // because the WorkerSupervisor (src/workersupervisor.ts, P8.5) spawns it by path for each round.
      const roots = [
        "src/wire.ts",
        "src/cli.ts",
        "src/bench/cli.ts",
        "src/openviking/sidecar-main.ts",
        "src/loginrefresh/main.ts",
        "src/botworker.ts",
      ].map((p) => join(ROOT, p));
      for (const f of EXTENSION_DIRS.flatMap((d) => tsFiles(join(ROOT, d)))) {
        for (const p of sourceSpecifiers(ROOT, f, stripComments(readFileSync(f, "utf8")))) {
          if (files.includes(p)) roots.push(p);
        }
      }
      for (const r of roots) {
        expect(
          files,
          `${relative(ROOT, r)} is named as an entrypoint but does not exist`,
        ).toContain(r);
      }

      const seen = new Set<string>();
      const queue = [...roots];
      while (queue.length > 0) {
        const f = queue.shift()!;
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(...importsOf(f));
      }
      // If the graph walk breaks, everything is "unreachable" and the equality
      // below fails loudly rather than passing on an empty set — but a partial
      // break could still look plausible, so pin that most of src/ IS reached.
      expect(
        seen.size,
        "the module graph walk reached almost nothing — the import scan broke",
      ).toBeGreaterThan(files.length / 2);

      const unreachable = files
        .filter((f) => !seen.has(f))
        .map((f) => relative(ROOT, f))
        .sort();
      for (const e of NOT_REACHED_FROM_PRODUCTION)
        expect(e.why.length, `${e.file} needs a reason`).toBeGreaterThan(40);

      expect(
        unreachable,
        "a module under src/ is not reachable from any entrypoint — it runs only in its own tests. Wire it, delete it, " +
          "or record it with what drives it. If one DROPPED off the list, delete its entry: it is live now.",
      ).toEqual(NOT_REACHED_FROM_PRODUCTION.map((e) => e.file).sort());
    },
  );
});
