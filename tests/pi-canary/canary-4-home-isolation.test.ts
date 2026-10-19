// Canary 4 [P2.8]: the SDK host touches nothing under HOME.
//
// pi defaults three paths to ~/.pi/agent when the caller names none
// (model-runtime.js:81 models.json, models-store.js:30 models-store.json,
// settings-manager.js:223 settings.json), and its resource discovery walks
// $HOME/.agents/skills, the agentDir and every cwd ancestor. A missed explicit
// path would silently read the operator's login, extensions, skills or context
// files into a review run, or write a cache into their home. PiHost passes every
// path and discovers nothing, and this holds it two ways: with HOME holding
// decoys, nothing of them reaches the session and nothing is written; with HOME
// chmod 000 and PI_CODING_AGENT_DIR unset, a filesystem spy sees no call at all.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { spyOnFs } from "../helpers/fs-spy.js";
import { type HostRig, createHostRig, useOfflineGuard } from "./harness.js";

useOfflineGuard();

let home: string;
let rig: HostRig | undefined;
let savedHome: string | undefined;
let savedAgentDir: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-canary-home-"));
  savedHome = process.env["HOME"];
  savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["HOME"] = home;
  delete process.env["PI_CODING_AGENT_DIR"];
});

afterEach(() => {
  rig?.close();
  rig = undefined;
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedAgentDir !== undefined) process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
  chmodSync(home, 0o755);
  rmSync(home, { recursive: true, force: true });
});

/** Everything under a tree with its mtime and size, to detect any write. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory()
      ? [`${p}/`, ...snapshot(p)]
      : [`${p} ${statSync(p).size} ${statSync(p).mtimeMs}`];
  });
}

/** What a careless host would pick up from the operator's home. */
function plantDecoys(): void {
  mkdirSync(join(home, ".agents", "skills", "evil-skill"), { recursive: true });
  writeFileSync(
    join(home, ".agents", "skills", "evil-skill", "SKILL.md"),
    "---\nname: evil-skill\ndescription: DECOY-SKILL-FROM-HOME\n---\nDECOY-SKILL-BODY\n",
  );
  writeFileSync(join(home, "AGENTS.md"), "DECOY-CONTEXT-FROM-HOME\n");
  const agent = join(home, ".pi", "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  mkdirSync(join(agent, "skills", "agent-skill"), { recursive: true });
  writeFileSync(
    join(agent, "skills", "agent-skill", "SKILL.md"),
    "---\nname: agent-skill\ndescription: DECOY-SKILL-FROM-AGENT-DIR\n---\nbody\n",
  );
  writeFileSync(
    join(agent, "extensions", "planted.ts"),
    `export default function (pi) { pi.on("agent_start", () => { throw new Error("DECOY-EXTENSION-LOADED"); }); }\n`,
  );
  writeFileSync(join(agent, "AGENTS.md"), "DECOY-CONTEXT-FROM-AGENT-DIR\n");
  writeFileSync(join(agent, "SYSTEM.md"), "DECOY-SYSTEM-PROMPT\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "decoy" }));
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ decoy: { type: "api_key", key: "x" } }));
}

/** A cwd under HOME with its own decoys: the reviewed repo is untrusted input. */
function plantCwd(): string {
  const cwd = join(home, "work", "repo");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(cwd, ".agents", "skills", "repo-skill"), { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "DECOY-CONTEXT-FROM-REPO\n");
  writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "DECOY-REPO-SYSTEM-PROMPT\n");
  writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "DECOY-REPO-APPEND\n");
  writeFileSync(
    join(cwd, ".pi", "extensions", "planted.ts"),
    `export default function (pi) { pi.on("agent_start", () => { throw new Error("DECOY-REPO-EXTENSION"); }); }\n`,
  );
  writeFileSync(
    join(cwd, ".agents", "skills", "repo-skill", "SKILL.md"),
    "---\nname: repo-skill\ndescription: DECOY-SKILL-FROM-REPO\n---\nbody\n",
  );
  return cwd;
}

const STUB = { path: "/virtual/run/out/AGENTS.override.md", content: "REVIEWER-STUB-12-LINES\n" };

describe("[canary 4] the SDK host reads nothing from HOME", () => {
  it("decoys in HOME, the agentDir lookalike, the cwd and its ancestors never reach the session", async () => {
    plantDecoys();
    const cwd = plantCwd();
    const before = snapshot(home);
    rig = await createHostRig({ agentsFiles: [STUB] });
    const errors: string[] = [];
    const session = await rig.host.makeSession({
      cwd,
      env: { HOME: join(rig.dir, "bash-home"), PATH: process.env["PATH"] },
      model: rig.faux.getModel(),
      systemPrompt: "SYSTEM-FROM-SPEC",
      // `read` is what makes pi list skills in the prompt at all.
      tools: ["read", "bash"],
      onExtensionError: (e) => errors.push(e.error),
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo ran" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");

    const prompt = session.systemPrompt;
    expect(prompt).toContain("SYSTEM-FROM-SPEC");
    expect(prompt).toContain("REVIEWER-STUB-12-LINES");
    expect(prompt).not.toMatch(/DECOY/);
    expect(prompt).not.toContain("evil-skill");
    expect(prompt).not.toContain("repo-skill");
    expect(errors).toEqual([]);
    expect(session.getLastAssistantText()).toBe("done");
    // The agentDir the host was given is private; the lookalike under HOME is untouched.
    expect(snapshot(home)).toEqual(before);
    expect(rig.host.agentDir.startsWith(home)).toBe(false);
  });

  it("with HOME chmod 000 and PI_CODING_AGENT_DIR unset, no filesystem call touches HOME", async () => {
    const cwd = join(tmpdir(), "pi-canary-cwd-" + process.pid);
    mkdirSync(cwd, { recursive: true });
    chmodSync(home, 0o000);
    const spy = spyOnFs([home]);
    try {
      rig = await createHostRig({ agentsFiles: [STUB] });
      const session = await rig.host.makeSession({
        cwd,
        env: { PATH: process.env["PATH"] },
        model: rig.faux.getModel(),
        tools: ["read", "bash"],
      });
      rig.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("go");
      expect(session.getLastAssistantText()).toBe("done");
      rig.close();
      rig = undefined;
      // Background work (a provider availability refresh) lands after the prompt.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      spy.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
    expect(spy.touches, "pi reached into HOME").toEqual([]);
  });

  it("the spy would have caught it: a planted read of HOME is recorded", () => {
    const spy = spyOnFs([home]);
    try {
      try {
        readFileSync(join(home, "nothing"));
      } catch {
        /* absent, which is the point */
      }
    } finally {
      spy.restore();
    }
    expect(spy.touches[0]).toBe(`readFileSync ${join(home, "nothing")}`);
  });
});
