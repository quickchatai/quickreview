// [P7.12a] What tests/tool-uid-container.test.ts runs inside a container, as the
// engine's run uid, after docker/entrypoint.sh has taken the token handoff and
// made the tool uid split: `qcr review`'s SDK runtime over pi-ai's faux provider,
// whose scripted model makes the calls an attacker's model would. No network, no
// model. Everything it learns goes to $HARNESS_OUT, for the test to read.
//
//   HARNESS_DIST   the built tree's dist/src
//   HARNESS_OUT    a writable directory for the results
//   HARNESS_ROOT   the production tree (QCR_SANDBOX_ROOT)
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.env.HARNESS_DIST;
const out = process.env.HARNESS_OUT;
const write = (name, value) =>
  writeFileSync(
    join(out, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 1),
  );

const { takeHandoffToken, handedToken } = await import(`${dist}/ghcred.js`);
takeHandoffToken();
write("holder.json", {
  pid: process.pid,
  uid: process.getuid(),
  holdsToken: handedToken() !== null,
});
// what this process's env names, for "QCR_ALLOW_SHARED_TOOL_UID is nowhere"
write("node-env-names.json", Object.keys(process.env).sort());

const { reviewSdkRuntime } = await import(`${dist}/engine/reviewsdk.js`);
const { PiHost } = await import(`${dist}/engine/pisdk.js`);
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");

const base = mkdtempSync("/tmp/qcr-tu-");
chmodSync(base, 0o2775);
const work = join(base, "work");
const agentDir = join(base, "agent");
mkdirSync(work, { mode: 0o2775 });
chmodSync(work, 0o2775);
// the run's private agent dir, as src/hostroute.ts makes it: the run uid's alone
mkdirSync(agentDir, { mode: 0o700 });
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 3 * 3_600_000,
    },
  }),
  { mode: 0o600 },
);

const faux = fauxProvider();
const model = `${faux.getModel().provider}/${faux.getModel().id}`;
const makeHost = async (o) =>
  PiHost.create({
    ...o,
    ownsProcess: false,
    settings: { ...o.settings, compaction: { enabled: false }, retry: { enabled: false } },
    configureModels: async (r) => {
      await o.configureModels?.(r);
      r.registerNativeProvider(faux.provider);
    },
  });

// The session as the engine route builds it, without the round's bash-guard
// extension: the guard refuses `id` and the /proc reads before the kernel is
// asked, and what is checked here is the kernel's answer (D32 drops the guard
// in these containers).
const rt = reviewSdkRuntime({
  makeHost,
  extras: () => ({ tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] }),
});
const spec = (name) => ({
  cwd: work,
  env: {
    PATH: process.env.PATH,
    HOME: "/tmp",
    PI_CODING_AGENT_DIR: agentDir,
    QCR_SANDBOX_ROOT: process.env.HARNESS_ROOT,
  },
  model,
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  eventsFile: join(out, `${name}-events.jsonl`),
  stderrFile: join(out, `${name}-stderr.log`),
  limits: { timeoutMs: 60_000 },
});

let session;
try {
  session = await rt.create(spec("main"));
} catch (e) {
  write("refused.txt", String(e instanceof Error ? e.message : e));
  process.exit(0);
}

const pid = process.pid;
const calls = [];
const step = (label, tool, args) => calls.push({ label, tool, args });
step("id", "bash", { command: "echo uid=$(id -u) gid=$(id -g) groups=$(id -G)" });
step("environ", "bash", { command: `cat /proc/${pid}/environ 2>&1 | head -c 200; echo rc=$?` });
step("mem", "bash", { command: `head -c 4 /proc/${pid}/mem 2>&1; echo` });
step("cmdline", "bash", { command: `cat /proc/${pid}/cmdline 2>&1 | head -c 100; echo` });
step("env", "bash", { command: "env | sort" });
step("agentdir", "bash", { command: `cat ${agentDir}/auth.json 2>&1; ls ${agentDir} 2>&1` });
step("mount", "bash", { command: "ls -A /run/qcr-in 2>&1; echo" });
step("plant", "bash", {
  command: [
    `ln -s /proc/${pid}/environ env-link`,
    "ln -s /proc/self/environ self-link",
    "ln -s /run/qcr-in mount-link",
    `ln -s ${agentDir} agent-link`,
    `ln -s ${agentDir}/auth.json auth-link`,
    "ln -s /run/qcr-in/new dangling",
    "echo planted",
  ].join(" && "),
});
for (const [label, path] of [
  ["read-environ", "/proc/self/environ"],
  ["read-environ-pid", `/proc/${pid}/environ`],
  ["read-mount", "/run/qcr-in/gh-token"],
  ["read-agent", `${agentDir}/auth.json`],
  ["read-link-environ", "env-link"],
  ["read-link-self", "self-link"],
  ["read-link-mount", "mount-link/gh-token"],
  ["read-link-agent", "agent-link/auth.json"],
  ["read-link-auth", "auth-link"],
])
  step(label, "read", { path });
for (const link of ["env-link", "mount-link", "agent-link", "auth-link"]) {
  step(`grep-${link}`, "grep", { pattern: ".", path: link });
  step(`ls-${link}`, "ls", { path: link });
  step(`find-${link}`, "find", { pattern: "*", path: link });
  step(`edit-${link}`, "edit", { path: link, edits: [{ oldText: "a", newText: "b" }] });
  step(`write-${link}`, "write", { path: link, content: "pwn" });
}
step("write-dangling", "write", { path: "dangling", content: "pwn" });
step("write-into-mount", "write", { path: "mount-link/new", content: "pwn" });
// the ordinary work still works, across the two uids
step("bash-writes", "bash", { command: "echo from-bash > a.txt && echo wrote" });
step("read-ok", "read", { path: "a.txt" });
step("edit-ok", "edit", { path: "a.txt", edits: [{ oldText: "from-bash", newText: "edited" }] });
step("write-ok", "write", { path: "sub/b.txt", content: "from-write\n" });
step("bash-reads", "bash", { command: "cat a.txt sub/b.txt; ls -ln a.txt sub/b.txt" });
// a command that outlives its timeout is ended, as the tool uid
step("timeout", "bash", { command: "sleep 120 & echo $! > sleeper.pid; wait", timeout: 1 });
step("after-timeout", "bash", {
  // a killed process nobody reaps (no init in this container) stays a zombie: ended
  command:
    'p=$(cat sleeper.pid); s=$(sed -n "s/^State:[[:space:]]*\\(.\\).*/\\1/p" /proc/$p/status 2>/dev/null); ' +
    'if [ -z "$s" ] || [ "$s" = Z ]; then echo "ended $p"; else echo "still-running $p state=$s"; fi',
});

faux.setResponses([
  ...calls.map((c) =>
    fauxAssistantMessage([fauxToolCall(c.tool, c.args)], { stopReason: "toolUse" }),
  ),
  fauxAssistantMessage("done"),
]);
const t0 = Date.now();
const turn = await session.prompt("go");
write("turn.json", { code: turn.code, ms: Date.now() - t0 });
write(
  "labels.json",
  calls.map((c) => c.label),
);
await session.dispose();

// a second session of the same host: the split is the host's, not the session's
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("bash", { command: "echo uid=$(id -u)" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("done"),
]);
const second = await rt.create(spec("second"));
await second.prompt("go");
await second.dispose();
write("workdir.txt", work);
writeFileSync(join(out, "done"), "");
process.exit(0);
