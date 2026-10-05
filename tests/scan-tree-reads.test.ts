// scan-loop: a lens's reads land in the scanned tree.
//
// The case runner runs every lens in the app root (first-party ground: its
// `.pi/settings.json` tuning and reviewer context ride that cwd, and a
// reviewed tree's `.pi/` must never load — extensions/subagents.ts reason 3),
// NOT in the materialised tree. So a relative path the lens names opens the
// app root's copy — the wrong repository on a scan of another repository, HEAD
// instead of the scan sha on a self-scan. Three halves:
//  - the runner reports every read RESOLVED the way pi resolves it (against
//    the child's cwd, one `@` stripped, `~` expanded), so the read-count guard
//    judges what was actually opened, never how it was spelled;
//  - the guard credits a read that resolves inside the tree — relative or
//    absolute — and nothing that resolves outside it;
//  - the task string names each focus file's absolute tree path, and says the
//    working directory is not the tree.
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { COMPANION_AGENTS_DIR } from "../extensions/setup.js";
import { piCaseRunner, resolvedReadPath, type SpawnFn } from "../src/setup/caserunner.js";
import type { CaseSpec } from "../src/setup/engine.js";
import { SCAN_MODE_ANCHOR_ADDENDUM } from "../src/include.js";
import { focusLine, scanCasePrompt, scanValidatorPrompt } from "../src/setup/scan.js";
import { unreadFocus } from "../src/setup/scanrun.js";
import { stage2CasePrompt } from "../src/setup/stage2.js";

const APP = "/workspace";
const TREE = "/workspace/state/scan/tree/abc123";

function fakeSpawn(lines: unknown[]) {
  const calls: Array<{ cwd: string }> = [];
  const spawn: SpawnFn = (_command, _args, o) => {
    calls.push({ cwd: o.cwd });
    const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), kill: () => true });
    setTimeout(() => {
      for (const l of lines) stdout.write(`${JSON.stringify(l)}\n`);
      setTimeout(() => child.emit("close", 0), 5);
    }, 0);
    return child;
  };
  return { spawn, calls };
}

const tool = (toolName: string, path: string) => ({
  type: "tool_execution_start",
  toolCallId: `c-${path}`,
  toolName,
  args: { path },
});
const done = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "NONE" }],
    usage: { cost: { total: 0.01 } },
  },
};
const spec: CaseSpec = {
  id: "run/api",
  unit: "api",
  agent: "pass-survey",
  files: ["api/models.py"],
  prompt: "SCAN",
};

async function readsOf(paths: string[]): Promise<string[] | undefined> {
  const f = fakeSpawn([...paths.map((p) => tool("read", p)), done]);
  const out = await piCaseRunner({
    agentsDir: COMPANION_AGENTS_DIR,
    cwd: APP,
    spawn: f.spawn,
    invocation: { command: "pi", prefix: [] },
  }).run(spec, new AbortController().signal);
  expect(f.calls[0]!.cwd).toBe(APP); // first-party ground, never the tree
  return out.ok ? out.reads : undefined;
}

describe("the case runner reports every read as the path pi opened", () => {
  it("resolves a relative read against the child's cwd — the app root, not the tree", async () => {
    expect(await readsOf(["api/models.py"])).toEqual([`${APP}/api/models.py`]);
  });

  it("a relative read that names a path inside the tree resolves inside the tree", async () => {
    expect(await readsOf(["state/scan/tree/abc123/api/models.py"])).toEqual([
      `${TREE}/api/models.py`,
    ]);
  });

  it("strips pi's one leading `@`, expands `~`, and normalises `..` — as pi's own resolver does", () => {
    expect(resolvedReadPath("@/t/a.py", APP)).toBe("/t/a.py");
    expect(resolvedReadPath("@api/a.py", APP)).toBe(`${APP}/api/a.py`);
    expect(resolvedReadPath("~/x.md", APP)).toBe(join(homedir(), "x.md"));
    expect(resolvedReadPath(`${TREE}/../../../../../etc/passwd`, APP)).toBe("/etc/passwd");
    expect(resolvedReadPath(`${TREE}/./api//models.py`, APP)).toBe(`${TREE}/api/models.py`);
  });
});

describe("the read-count guard credits what resolved inside the tree", () => {
  const focus = ["api/models.py"];

  it("credits a RELATIVE read that resolved inside the tree", async () => {
    expect(
      unreadFocus(await readsOf(["state/scan/tree/abc123/api/models.py"]), focus, TREE),
    ).toBeNull();
  });

  it("credits an absolute read under the tree", async () => {
    expect(unreadFocus(await readsOf([`${TREE}/api/models.py`]), focus, TREE)).toBeNull();
  });

  it("never credits a relative read that opened the app root's copy — the wrong repository", async () => {
    expect(unreadFocus(await readsOf(["api/models.py"]), focus, TREE)).toMatch(
      /read none of its 1 focus file/,
    );
  });

  it("never credits a read that climbs out of the tree", async () => {
    expect(
      unreadFocus(await readsOf([`${TREE}/../abc123-other/api/models.py`]), focus, TREE),
    ).toMatch(/read none/);
    expect(unreadFocus(await readsOf(["../workspace/api/models.py"]), focus, TREE)).toMatch(
      /read none/,
    );
  });
});

describe("the task string names where to open each file", () => {
  const plan = {
    unit: "api",
    id: "api",
    part: 1,
    parts: 1,
    files: [{ path: "api/models.py", blob: "b", lines: 9 }],
    lines: 9,
  } as never;
  const ctx = { root: TREE, sha: "abc123", caseId: "run/api" };

  it("every focus line carries the file's absolute tree path, and keeps the repo-relative one the answer uses", () => {
    expect(focusLine({ path: "api/models.py", blob: "b", lines: 9 }, TREE)).toBe(
      `- api/models.py (9 lines) — open ${TREE}/api/models.py`,
    );
    for (const prompt of [
      scanCasePrompt(plan, ctx),
      stage2CasePrompt(
        {
          id: "r1",
          lens: "pass-security",
          units: ["api"],
          files: [{ path: "api/models.py", blob: "b", lines: 9 }],
          tests: [],
          lines: 9,
          reason: "x",
        } as never,
        ctx,
      ),
    ]) {
      expect(prompt).toContain(`open ${TREE}/api/models.py`);
      expect(prompt).toMatch(/working directory is NOT the tree/);
    }
  });

  it("the validator is told the same", () => {
    const prompt = scanValidatorPrompt(plan, [], ctx);
    expect(prompt).toContain(`open ${TREE}/api/models.py`);
    expect(prompt).toMatch(/working directory is NOT the tree/);
  });

  it("the scan-mode addendum tells every scan lens to open files by absolute tree path", () => {
    expect(SCAN_MODE_ANCHOR_ADDENDUM).toMatch(/working directory is NOT the tree root/);
    expect(SCAN_MODE_ANCHOR_ADDENDUM).toMatch(/absolute path under the tree root/);
  });
});

describe("the rest of pi's path normalisation", () => {
  it("a `file://` URL opens its path, and a unicode space reads as a space — pi's `normalizePath`", () => {
    expect(resolvedReadPath(`file://${TREE}/api/models.py`, APP)).toBe(`${TREE}/api/models.py`);
    expect(
      unreadFocus([resolvedReadPath(`file://${TREE}/api/models.py`, APP)], ["api/models.py"], TREE),
    ).toBeNull();
    expect(resolvedReadPath(`${TREE}/api/my\u00a0file.py`, APP)).toBe(`${TREE}/api/my file.py`);
  });
});
