// [P7.12a] What tests/tool-uid-container.test.ts runs inside a container, as the
// engine's run uid, to see a debug round (`qcr review --debug-pi`) start its
// interactive pi under the tool uid split: the REAL pi CLI in a pty over a local
// OpenAI-compatible endpoint (loopback; no model, nothing leaves the machine),
// the wave run as SDK sessions of that pi, every JSONL kept. It is the smoke of
// tests/debug-pi.test.ts, without vitest. Node strips the TypeScript of the test
// helpers it imports.
//
//   HARNESS_DIST   the built tree's dist/src
//   HARNESS_CORE_DIST  the review core's, packages/pi-plugin/dist/src
//   HARNESS_OUT    a writable directory for the results
//   HARNESS_ROOT   the repo (read-only)
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const dist = process.env.HARNESS_DIST;
const core = process.env.HARNESS_CORE_DIST;
const out = process.env.HARNESS_OUT;
const repo = process.env.HARNESS_ROOT;
process.env.QCR_CONFIG = join(repo, "tests", "fixtures", "config.toml");
const write = (name, value) =>
  writeFileSync(
    join(out, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 1),
  );

const { startFakeOpenAI, writeFakeProvider, FAKE_MODEL } = await import(
  `${repo}/tests/helpers/fake-openai.ts`
);
const { mkRoot, mkTree, FILES, TARGET } = await import(`${repo}/tests/helpers/round-rig.ts`);
const { runDebugRound } = await import(`${dist}/engine/debugpi.js`);
const { benchConfig } = await import(`${dist}/bench/runner.js`);
const { ecosystemFor } = await import(`${core}/ecosystem.js`);
const { mainSessionOf, lensSessionsOf } = await import(`${core}/engine/openable.js`);
const { REVIEWER_STUB, HOST_CONTEXT_STUB } = await import(`${dist}/hostroute.js`);

write("holder.json", { uid: process.getuid(), toolUid: process.env.QCR_TOOL_UID ?? null });

const server = await startFakeOpenAI();
const base = mkdtempSync("/tmp/qcr-dbg-");
chmodSync(base, 0o2775);
const agentDir = join(base, "agent");
// the run's private agent dir, as src/hostroute.ts makes it: the run uid's alone
writeFakeProvider(agentDir, server.baseUrl);
chmodSync(agentDir, 0o700);
writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
mkdirSync(join(agentDir, "agents"), { recursive: true });
for (const a of ["pass-a", "pass-b"])
  writeFileSync(
    join(agentDir, "agents", `${a}.md`),
    `---\nname: ${a}\ndescription: ${a}\nmodel: ${FAKE_MODEL}\ntools: read, bash\n---\nYou are ${a}.\n`,
  );
chmodSync(join(agentDir, "agents"), 0o700);
const root = mkRoot(base, "root");
const tree = mkTree(base, "tree");
const outDir = join(base, "out");
const cwd = join(base, "work");
mkdirSync(cwd);
copyFileSync(join(repo, REVIEWER_STUB), join(cwd, HOST_CONTEXT_STUB));
const cfg = benchConfig("");
cfg.models.conversation = FAKE_MODEL;
server.script(Array.from({ length: 12 }, () => ({ text: "ok" })));

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const seen = {};
const result = await runDebugRound(
  {
    root,
    cwd,
    agentScope: "user",
    agentDir,
    tree,
    files: FILES,
    target: TARGET,
    outDir,
    cfg,
    ecosystem: ecosystemFor("none"),
    timeoutMs: 60_000,
    prompts: {
      system: "You are the reviewer.",
      order: "ROUND ORDER: review the PR.",
      plannedLenses: ["pass-a", "pass-b"],
      passPlan: [],
      taskFiles: ["01-pass-a.md", "02-pass-b.md"].map((f) => ({
        path: join(outDir, "tasks", f),
        text: `task ${f}\n`,
      })),
    },
  },
  {
    piBin: join(repo, "node_modules", ".bin", "pi"),
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" },
    // The pty: `script` gives pi a terminal; this plays the person.
    run: (cmd) =>
      new Promise((done) => {
        seen.bin = cmd.bin;
        seen.args = cmd.args.slice(0, 8);
        const line = `stty cols 140 rows 50; exec ${[cmd.bin, ...cmd.args].map(q).join(" ")}`;
        const child = spawn("script", ["-qefc", line, "/dev/null"], {
          cwd: cmd.cwd,
          env: cmd.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let screen = "";
        child.stdout.on("data", (d) => (screen += d.toString()));
        const t0 = Date.now();
        const poll = setInterval(() => {
          let wave = 0;
          try {
            wave = JSON.parse(readFileSync(join(outDir, "debug-round.json"), "utf8")).wave_settled;
          } catch {
            // not written yet
          }
          const main = mainSessionOf(outDir);
          const answered =
            main !== null && readFileSync(main, "utf8").includes('"role":"assistant"');
          if ((wave >= 2 && answered) || Date.now() - t0 > 45_000) {
            clearInterval(poll);
            // ^D on an empty editor: the person leaves pi
            child.stdin.write("\x04");
            setTimeout(() => child.kill("SIGKILL"), 10_000);
          }
        }, 250);
        child.on("close", (c) => {
          clearInterval(poll);
          write("screen.txt", screen.slice(-4000));
          done(c ?? 1);
        });
      }),
  },
);

const main = mainSessionOf(outDir);
write("launch.json", seen);
write("result.json", {
  code: result.piRun.code,
  error: result.error ?? null,
  requests: server.requests.length,
  status: JSON.parse(readFileSync(join(outDir, "debug-round.json"), "utf8")),
  main: main,
  // who wrote the files pi kept: the uid of the process that ran as the tool uid
  mainOwner: main ? statSync(main).uid : null,
  lensOwners: lensSessionsOf(outDir).map((l) => statSync(l.file).uid),
  lenses: lensSessionsOf(outDir).length,
  selfUid: process.getuid(),
});
await server.close();
writeFileSync(join(out, "done"), "");
process.exit(0);
