// runPi resolves only once its output files are flushed (selfscan
// bench-harness). The end-to-end race in bench-defects.test.ts loses only
// under load; this pins it deterministically with a SLOW write stream: every
// write lands 20 ms late, so a runPi that resolves on the child's `close`
// (before the files flush) reads an empty tail every time.
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    createWriteStream: (path: string) =>
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          setTimeout(() => {
            real.appendFileSync(path, chunk);
            cb();
          }, 20);
        },
      }),
  };
});

const { runJudgeSession } = await import("../src/bench/runner.js");

describe("runPi's output files", () => {
  it("are complete the moment runPi resolves, even when the disk is slow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runpi-flush-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "pi"),
      '#!/bin/sh\ncat >/dev/null\necho \'{"type":"a"}\'\necho LAST\necho ERRLAST >&2\n',
    );
    chmodSync(join(dir, "bin", "pi"), 0o755);
    const eventsPath = join(dir, "e.jsonl");
    appendFileSync(eventsPath, "");
    const r = await runJudgeSession("prompt", {
      root: "/x",
      cwd: dir,
      model: "m",
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
      eventsPath,
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(eventsPath, "utf8").endsWith("LAST\n")).toBe(true);
    expect(readFileSync(join(dir, "e.stderr.log"), "utf8").endsWith("ERRLAST\n")).toBe(true);
  });
});
