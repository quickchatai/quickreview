// src/picwd.ts: the panes' interactive pi runs in its own cwd, whatever cwd the
// session JSONL's header records. Found by the worker rehearsal (P8.20a, DEBUG-1):
// a debug round on a PR the legacy tmux bot had reviewed opened the JSONL with its
// legacy header cwd, so bash-guard refused `scripts/post-review.sh` ("not a
// sanctioned script": the cwd was not the sandbox root) and the round never ended.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { piPackageDir } from "../src/engine/pisdk.js";
import { pinSessionCwd } from "../src/picwd.js";
import { PICWD_MAIN, paneLaunch } from "../src/takeoverpi.js";

// pi's own CLI session selection, from the very module its `main` runs: the export map
// does not publish it, so it is reached by file path (one module instance either way).
type CreateSessionManager = (
  parsed: Record<string, unknown>,
  cwd: string,
  sessionDir: string | undefined,
  settings: SettingsManager,
) => Promise<SessionManager>;
const piMain = (await import(pathToFileURL(join(piPackageDir(), "dist", "main.js")).href)) as {
  createSessionManager: CreateSessionManager;
};

let dir: string;
let legacy: string;
let root: string;
let file: string;
let settings: SettingsManager;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-picwd-"));
  legacy = join(dir, "legacy-sandbox");
  root = join(dir, "opt-qcr");
  mkdirSync(legacy);
  mkdirSync(root);
  mkdirSync(join(dir, "sessions"));
  file = join(dir, "sessions", "2026-10-18T10-00-00-000Z_rh-legacy.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "rh-legacy",
      timestamp: "2026-10-18T10:00:00.000Z",
      cwd: legacy,
    }) + "\n",
  );
  settings = SettingsManager.inMemory();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("[P8.20a] a pane's pi runs in its own cwd, not the legacy header's", () => {
  it("pi's CLI opens `--session <file>` in the header's cwd unpinned, and in the launcher's once pinned", async () => {
    const open = () =>
      piMain.createSessionManager({ session: file }, root, join(dir, "sessions"), settings);
    // pi as shipped: the legacy tree, where no script, state/ or verdict/ lives
    expect((await open()).getCwd()).toBe(legacy);
    pinSessionCwd(SessionManager, () => root);
    const pinned = await open();
    expect(pinned.getCwd()).toBe(root);
    // the same session, appended to: the id is the file's, and nothing is rewritten
    expect(pinned.getSessionId()).toBe("rh-legacy");
    expect(pinned.getSessionFile()).toBe(file);
    // idempotent; and an explicit override (pi's own missing-cwd recovery) still wins
    pinSessionCwd(SessionManager, () => "/elsewhere");
    expect((await open()).getCwd()).toBe(root);
    expect(SessionManager.open(file, join(dir, "sessions"), legacy).getCwd()).toBe(legacy);
  });

  it("the takeover and debug panes start pi through picwd, unless a pi binary is named", () => {
    expect(paneLaunch(["--session", file], undefined, "/usr/bin/node")).toEqual({
      bin: "/usr/bin/node",
      argv: [PICWD_MAIN, "--session", file],
    });
    expect(PICWD_MAIN.endsWith(join("src", "picwd.js"))).toBe(true);
    expect(paneLaunch(["-ne"], "/opt/pi")).toEqual({ bin: "/opt/pi", argv: ["-ne"] });
  });
});
