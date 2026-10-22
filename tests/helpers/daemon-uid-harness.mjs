// What tests/tool-uid-daemon-container.test.ts runs inside a container
// as the bot's daemon (dist/src/wire.js's stand-in), after docker/entrypoint.sh's
// daemon mode has probed the setid helper and exported the tool uid: the model's
// bash, through the real built tooluid.js, as an attacker would use it. No
// network, no model. Everything it learns goes to $HARNESS_OUT.
//
//   HARNESS_DIST   the built tree's dist/src
//   HARNESS_OUT    a writable directory for the results
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.env.HARNESS_DIST;
const out = process.env.HARNESS_OUT;
const write = (name, value) =>
  writeFileSync(
    join(out, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 1),
  );

write("daemon.json", {
  pid: process.pid,
  uid: process.getuid(),
  gid: process.getgid(),
  groups: process.getgroups(),
  toolUid: process.env.QCR_TOOL_UID ?? null,
  toolGid: process.env.QCR_TOOL_GID ?? null,
  setprivBin: process.env.QCR_SETPRIV_BIN ?? null,
  umask: process.umask(),
  modes: Object.fromEntries(
    ["/opt/qcr/state", "/opt/qcr/verdict", "/opt/qcr/commands", "/opt/qcr/wt"].map((d) => [
      d,
      spawnSync("stat", ["-c", "%a %g", d], { encoding: "utf8" }).stdout.trim(),
    ]),
  ),
});

const { toolIdsOf, isolatedBashOperations, TOOL_UMASK } = await import(`${dist}/engine/tooluid.js`);
const { StateStore } = await import(`${dist}/state.js`);

// The daemon's own database, opened as the daemon opens it, and a built agent.
const store = new StateStore("/opt/qcr/state/state.db");
write(
  "db-mode.txt",
  spawnSync("stat", ["-c", "%a", "/opt/qcr/state/state.db"], { encoding: "utf8" }).stdout,
);
spawnSync("mkdir", ["-p", "/opt/qcr/state/agents"]);

// The setid helper as the daemon holds it (its gate group): the tool identity,
// and nothing else — root, root's group, the daemon's own uid.
const helperRun = (reuid, regid, cmd) => {
  const r = spawnSync(
    "/usr/local/libexec/qcr/qcr-setid",
    [
      `--reuid=${reuid}`,
      `--regid=${regid}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
      ...cmd,
    ],
    { encoding: "utf8" },
  );
  return { code: r.status, text: r.stdout + r.stderr };
};
write("helper.json", {
  tool: helperRun(65534, 4749, ["sh", "-c", "id -u; id -g; id -G"]),
  root: helperRun(0, 0, ["id", "-u"]),
  rootGid: helperRun(65534, 0, ["id", "-u"]),
  daemon: helperRun(1001, 1001, ["id", "-u"]),
});
const { IpcServer } = await import(`${dist}/ipc/server.js`);
const { CapabilityStore, socketPathOf } = await import(`${dist}/ipc/capability.js`);

// The daemon's socket, opened to its group as the daemon opens it.
const sock = socketPathOf("/opt/qcr/state");
const server = new IpcServer({
  socketPath: sock,
  capabilities: new CapabilityStore(),
  commands: () => null,
  groupAccess: true,
});
await server.start();

// A worker sets the group-writable umask (src/botworker.ts); the model's bash
// runs through the helper the env names.
process.umask(TOOL_UMASK);
const ids = toolIdsOf(process.env);
const ops = isolatedBashOperations(ids);
const results = {};
const bash = async (label, command) => {
  let text = "";
  const r = await ops.exec(command, "/opt/qcr/wt/pr-1", {
    onData: (d) => (text += d.toString()),
    env: { PATH: process.env.PATH, HOME: "/opt/qcr/pihome" },
  });
  results[label] = { code: r.exitCode, text };
};
await bash("id", "id");
await bash("secret", "cat /opt/quickreview/secrets/app.pem");
await bash("secretsLs", "ls /opt/quickreview/secrets");
await bash("planted", "cat /opt/qcr/wt/pr-1/innocent.md");
await bash("login", "cat /home/qcr/.pi/agent/auth.json");
await bash("environ", `cat /proc/${process.pid}/environ`);
await bash("mem", `head -c 1 /proc/${process.pid}/mem`);
await bash("git", "git log --oneline -1 && git status --short && echo git-ok");
await bash(
  "verdict",
  "printf '{}' > /opt/qcr/verdict/pr-1-round-1.json.tmp && mv -f -T /opt/qcr/verdict/pr-1-round-1.json.tmp /opt/qcr/verdict/pr-1-round-1.json && stat -c '%a %u' /opt/qcr/verdict/pr-1-round-1.json",
);
await bash("state", "printf x > /opt/qcr/state/pr-1-round-1-review.md && echo state-ok");
await bash("worktreeWrite", "touch /opt/qcr/wt/pr-1/new-file");
await bash("readDb", "cat /opt/qcr/state/state.db");
await bash("renameDb", "mv /opt/qcr/state/state.db /opt/qcr/state/stolen.db");
await bash("renameRun", "mv /opt/qcr/state/run /opt/qcr/state/run-moved");
await bash("renameAgents", "mv /opt/qcr/state/agents /opt/qcr/state/agents-moved");
await bash("renameOperator", "mv /opt/qcr/commands/operator /opt/qcr/commands/operator-moved");
await bash(
  "socket",
  `node -e 'require("net").connect(${JSON.stringify(sock)}).on("connect",()=>{console.log("connected");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(1)})'`,
);
await bash(
  "mint",
  "QCR_SECRETS_MOUNT=/opt/quickreview/secrets QCR_CONFIG=/opt/qcr/config.example.toml bash /opt/qcr/scripts/mint-token.sh",
);
await bash(
  "helperBack",
  "/usr/local/libexec/qcr/qcr-setid --reuid=1001 --regid=1001 --clear-groups -- id -u",
);
write("bash.json", results);
await server.stop();
store.db.close();
// the daemon's own uid reads its secrets, as it must
write(
  "daemon-reads.txt",
  spawnSync("cat", ["/opt/quickreview/secrets/app.pem"], { encoding: "utf8" }).stdout,
);
write("done", "");
