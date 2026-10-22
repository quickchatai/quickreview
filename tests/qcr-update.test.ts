// deploy/qcr-update.sh — the thin updater, driven end to end against a FAKE
// docker (a bash script that keeps containers and images as files) and a fake
// daemon (this process: it answers the operator channel and keeps status.json).
// Nothing here touches a real docker, a real VM or the network. The updater
// runs as the test user, in its test seam (QCR_UPDATE_CONF and friends, which
// root ignores); chown is skipped there.
//
// What is pinned:
//   - the happy path in the ticket's order, and the container flags it builds
//   - every refusal before the stop changes NOTHING
//   - a failure injected at every step between the stop and the recreate is
//     RESCUED, in the ticket's order: old config back, the new sidecar gone,
//     the old daemon started, its first reconcile awaited, `drain on` re-sent
//     through the operator channel and confirmed, a non-zero exit naming the step
//   - a failure after the recreate keeps the drain on and is fixed forward
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updater = join(root, "deploy", "qcr-update.sh");

const DAEMON_REPO = "ghcr.io/quickchatai/quickreview";
const MEMORY_REPO = "ghcr.io/quickchatai/quickreview-memory";
const DAEMON_DIGEST = `sha256:${"a".repeat(64)}`;
const MEMORY_DIGEST = `sha256:${"b".repeat(64)}`;
const OLD_DAEMON_DIGEST = `sha256:${"c".repeat(64)}`;
const OLD_MEMORY_DIGEST = `sha256:${"d".repeat(64)}`;
const DAEMON_REF = `${DAEMON_REPO}@${DAEMON_DIGEST}`;
const MEMORY_REF = `${MEMORY_REPO}@${MEMORY_DIGEST}`;
const OLD_DAEMON_REF = `${DAEMON_REPO}@${OLD_DAEMON_DIGEST}`;
const OLD_MEMORY_REF = `${MEMORY_REPO}@${OLD_MEMORY_DIGEST}`;
const LEGACY_IMAGE = "quickreview-sandbox:v1";
const DAEMON = "quickreview-sandbox";
const MEMORY = "quickreview-memory";

const FAKE_DOCKER = `#!/bin/bash
F="$FAKE"
echo "docker $*" >> "$F/events"
key() { printf '%s' "$1" | tr '/:@' '___'; }
labelname() { sed -n 's/.*index \\.Config\\.Labels "\\([^"]*\\)".*/\\1/p' <<<"$1"; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000000000Z; }
label_of() { # <dir> <fmt>
  local l; l="$(labelname "$2")"
  if [ -f "$1/labels/$l" ]; then cat "$1/labels/$l"; else echo '<no value>'; fi
}
cmd="$1"; shift
case "$cmd" in
  inspect|container)
    # a bare \`docker inspect\` resolves ANY object by name, and the memory
    # network shares the sidecar's name: real docker answers {{.Id}} for it
    if [ "$cmd" = container ]; then [ "$1" = inspect ] || exit 1; shift; bare=""; else bare=1; fi
    fmt="$2"; name="$3"; d="$F/containers/$name"
    if [ ! -d "$d" ]; then
      if [ -n "$bare" ] && [ -f "$F/network" ] && [ "$name" = quickreview-memory ] && [ "$fmt" = '{{.Id}}' ]; then
        echo "net-$name"; exit 0
      fi
      exit 1
    fi
    case "$fmt" in
      *Config.Labels*) label_of "$d" "$fmt" ;;
      '{{.Id}}') echo "id-$name" ;;
      '{{.Config.Image}}') cat "$d/image" ;;
      '{{.State.Running}}') cat "$d/running" ;;
      '{{.State.StartedAt}}') cat "$d/started" ;;
    esac ;;
  image)
    [ "$1" = inspect ] || exit 1
    fmt="$3"; ref="$4"; d="$F/images/$(key "$ref")"; [ -d "$d" ] || exit 1
    case "$fmt" in
      *Config.Labels*) label_of "$d" "$fmt" ;;
      *RepoDigests*) cat "$d/repodigests" ;;
    esac ;;
  pull)
    [ ! -f "$F/fail-pull" ] || { echo "pull access denied" >&2; exit 1; }
    [ -d "$F/images/$(key "$1")" ] || exit 1 ;;
  tag) : ;;
  network)
    case "$1" in
      inspect) [ -f "$F/network" ] ;;
      create) touch "$F/network" ;;
    esac ;;
  stop)
    [ ! -f "$F/fail-stop" ] || exit 1
    name="\${@: -1}"; echo false > "$F/containers/$name/running" ;;
  start)
    name="$1"; d="$F/containers/$name"; [ -d "$d" ] || exit 1
    echo true > "$d/running"; now > "$d/started"
    # a healthy boot of the OLD daemon: its first reconcile lifts the drain
    if [ "$name" = "$FAKE_DAEMON" ] && [ -n "$FAKE_STATUS" ]; then
      # the real heartbeat carries "draining" only while draining; a lifted drain omits the key
      if [ -n "$FAKE_START_DRAINING" ]; then dr='"draining":true,'; else dr=''; fi
      printf '{"written_at":"%s",%s"running_rounds":0}\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$dr" > "$FAKE_STATUS"
    fi ;;
  rm) name="\${@: -1}"; rm -rf "$F/containers/$name" ;;
  rename)
    [ -d "$F/containers/$1" ] || exit 1
    [ ! -e "$F/containers/$2" ] || exit 1
    mv "$F/containers/$1" "$F/containers/$2" ;;
  exec)
    [ -f "$F/ready-rc" ] && exit "$(cat "$F/ready-rc")"
    exit 0 ;;
  run)
    args="$*"
    case "$args" in
      *"config check"*)
        [ -f "$F/config-check-out" ] && cat "$F/config-check-out"
        exit "$( [ -f "$F/config-check-rc" ] && cat "$F/config-check-rc" || echo 0 )" ;;
      *"daemon --preflight"*)
        prev=""
        for a in "$@"; do
          if [ "$prev" = -v ]; then case "$a" in *:*/state) ls -A "\${a%%:*}" > "$F/preflight-scratch" ;; esac; fi
          prev="$a"
        done
        printf '%s\\n' "$@" > "$F/preflight.argv"
        exit "$( [ -f "$F/preflight-rc" ] && cat "$F/preflight-rc" || echo 0 )" ;;
    esac
    name=""; image=""; prev=""
    for a in "$@"; do
      [ "$prev" = --name ] && name="$a"
      case "$a" in *@sha256:*) image="$a" ;; esac
      prev="$a"
    done
    [ -n "$name" ] || exit 1
    [ ! -f "$F/fail-run-$name" ] || { echo "cannot create $name" >&2; exit 125; }
    [ ! -e "$F/containers/$name" ] || { echo "name $name in use" >&2; exit 125; }
    d="$F/containers/$name"; mkdir -p "$d/labels"
    echo "$image" > "$d/image"
    [ -d "$F/images/$(key "$image")/labels" ] && cp -r "$F/images/$(key "$image")/labels/." "$d/labels/"
    echo true > "$d/running"; now > "$d/started"
    printf '%s\\n' "$@" > "$F/run-$name.argv"
    echo "container-$name" ;;
  *) exit 1 ;;
esac
`;

interface Sb {
  dir: string;
  root: string;
  conf: string;
  fake: string;
  backups: string;
  upd: string;
  memState: string;
  events: string;
  status: string;
  stopDaemon: () => void;
}

let sb: Sb | undefined;
afterEach(() => {
  sb?.stopDaemon();
  if (sb) rmSync(sb.dir, { recursive: true, force: true });
  sb = undefined;
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function image(fake: string, ref: string, labels: Record<string, string>, digest: string): void {
  const d = join(fake, "images", ref.replace(/[/:@]/g, "_"));
  for (const [k, v] of Object.entries(labels)) write(join(d, "labels", k), v);
  mkdirSync(join(d, "labels"), { recursive: true });
  write(join(d, "repodigests"), `${ref.split("@")[0]}@${digest}\n`);
}

function container(
  fake: string,
  name: string,
  img: string,
  labels: Record<string, string>,
  running = true,
): void {
  const d = join(fake, "containers", name);
  mkdirSync(join(d, "labels"), { recursive: true });
  write(join(d, "image"), `${img}\n`);
  write(join(d, "running"), `${running}\n`);
  write(join(d, "started"), "2026-10-20T08:00:00.000000000Z\n");
  for (const [k, v] of Object.entries(labels)) write(join(d, "labels", k), v);
}

const NEW_LABELS: Record<string, string> = {
  "qcr.layout": "release",
  "qcr.build-sha": "abc1234",
  "qcr.preflight": "true",
  "qcr.runspec": "2",
  "qcr.setid-gid": "4748",
  "qcr.tool-uid": "65534",
  "qcr.tool-gid": "4749",
};

function confText(
  sandbox: Sb["root"],
  dir: string,
  memState: string,
  upd: string,
  backups: string,
): string {
  const body = [
    "RUNSPEC_VERSION=2",
    `SANDBOX_ROOT=${sandbox}`,
    "APP_ROOT=/opt/qcr",
    `DAEMON_CONTAINER=${DAEMON}`,
    `MEMORY_CONTAINER=${MEMORY}`,
    `DAEMON_IMAGE_REPO=${DAEMON_REPO}`,
    `MEMORY_IMAGE_REPO=${MEMORY_REPO}`,
    "MEMORY_NETWORK=quickreview-memory",
    "WEBHOOK_PORT=8787",
    "CONTAINER_UID=1001",
    "TOOL_UID=65534",
    "TOOL_GID=4749",
    "TZ=Europe/Warsaw",
    "DAEMON_CPUS=2",
    "DAEMON_MEMORY=8g",
    "MEMORY_CPUS=1",
    "MEMORY_MEMORY=3g",
    `MEMORY_STATE_DIR=${memState}`,
    `OPENVIKING_HOME=${sandbox}/state/openviking`,
    "OPENVIKING_PORT=1933",
    "BASE_CLONE_DIR=repo",
    "LEGACY_SANDBOX_ROOT=/opt/quickreview/sandbox",
    `BACKUP_DIR=${backups}`,
    `UPDATE_STATE_DIR=${upd}`,
    "MEMORY_READY_TIMEOUT_S=2",
    "SIDECAR_ENV_TZ=Europe/Warsaw",
    "SIDECAR_ENV_QCR_OPENVIKING_AUTH_MODE=api_key",
    "SIDECAR_ENV_QCR_OPENVIKING_PORT=1933",
  ];
  const fp = createHash("sha256")
    .update(body.join("\n") + "\n")
    .digest("hex");
  void dir;
  return `# run spec (test)\n${body.join("\n")}\nRUNSPEC_FINGERPRINT=${fp}\n`;
}

/** The VM: a drained, idle board and a running daemon container of the given layout. */
function setup(layout: "release" | "legacy" | "none"): Sb {
  const dir = mkdtempSync(join(tmpdir(), "qcr-upd-"));
  const rootDir = join(dir, "vm");
  const fake = join(dir, "fake");
  const backups = join(dir, "backups");
  const upd = join(dir, "upd-state");
  const memState = join(dir, "memory-state");
  const events = join(fake, "events");
  const status = join(rootDir, "state", "status.json");
  mkdirSync(join(fake, "containers"), { recursive: true });
  mkdirSync(join(fake, "images"), { recursive: true });
  writeFileSync(events, "");
  write(join(dir, "docker"), FAKE_DOCKER);
  chmodSync(join(dir, "docker"), 0o755);
  write(join(dir, "update.conf"), confText(rootDir, dir, memState, upd, backups));

  // state the snapshot reads, the old config, the legacy store
  write(join(rootDir, "state", "state.db"), "SQLITE-DB");
  write(join(rootDir, "state", "state.db-wal"), "WAL");
  write(join(rootDir, "state", "state.db-shm"), "SHM");
  write(join(rootDir, "state", "pi-sessions", "pr-7", "round.jsonl"), '{"turn":1}\n');
  write(join(rootDir, "state", "openviking", "vectors", "data.bin"), "VECTORS");
  write(join(rootDir, "config-home", "config.toml"), "# OLD CONFIG\n");
  write(join(rootDir, "config-home", "profiles", "p", "profile.toml"), "# old profile\n");
  mkdirSync(join(rootDir, "sandbox", "commands", "operator"), { recursive: true });
  mkdirSync(join(rootDir, "sandbox", "commands", "results"), { recursive: true });
  write(
    status,
    JSON.stringify({ written_at: "2026-10-20T08:00:00.000Z", draining: true, running_rounds: 0 }),
  );

  image(fake, DAEMON_REF, NEW_LABELS, DAEMON_DIGEST);
  image(fake, MEMORY_REF, {}, MEMORY_DIGEST);
  if (layout === "release") {
    image(fake, OLD_DAEMON_REF, { ...NEW_LABELS, "qcr.build-sha": "old1234" }, OLD_DAEMON_DIGEST);
    image(fake, OLD_MEMORY_REF, {}, OLD_MEMORY_DIGEST);
    container(fake, DAEMON, OLD_DAEMON_REF, { ...NEW_LABELS, "qcr.build-sha": "old1234" });
    container(fake, MEMORY, OLD_MEMORY_REF, {});
    write(join(fake, "network"), "");
  } else if (layout === "legacy") {
    container(fake, DAEMON, LEGACY_IMAGE, {});
  }

  const stopDaemon = fakeDaemon(rootDir, events, status);
  return {
    dir,
    root: rootDir,
    conf: join(dir, "update.conf"),
    fake,
    backups,
    upd,
    memState,
    events,
    status,
    stopDaemon,
  };
}

/** The daemon, as far as the updater can see it: answers `drain on` in the
 * operator channel (a receipt, and status.json draining again). */
function fakeDaemon(rootDir: string, events: string, status: string): () => void {
  const opDir = join(rootDir, "sandbox", "commands", "operator");
  const resDir = join(rootDir, "sandbox", "commands", "results");
  const handled = new Set<string>();
  const t = setInterval(() => {
    let names: string[] = [];
    try {
      names = readdirSync(opDir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith(".json") || n.startsWith(".") || handled.has(n)) continue;
      handled.add(n);
      const cmd = JSON.parse(readFileSync(join(opDir, n), "utf8")) as {
        command: string;
        on: boolean;
      };
      if (cmd.command === "drain" && cmd.on === true) {
        appendFileSync(events, "daemon: drain-on\n");
        const cur = JSON.parse(readFileSync(status, "utf8")) as Record<string, unknown>;
        writeFileSync(status, JSON.stringify({ ...cur, draining: true }));
        writeFileSync(
          join(resDir, `${n.replace(/\.json$/, "")}.result.json`),
          JSON.stringify({ ok: true, draining: true, running_rounds: 0, issuer: "operator" }),
        );
      }
    }
  }, 30);
  return () => clearInterval(t);
}

/** A config tar: config.toml and profiles/ unless the files say otherwise. */
function tarOf(
  files: Record<string, string> = {
    "config.toml": "# NEW CONFIG\n",
    "profiles/p/profile.toml": "# new profile\n",
  },
  opts: { symlinks?: Record<string, string>; absolute?: boolean } = {},
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "qcr-tar-"));
  try {
    for (const [rel, body] of Object.entries(files)) write(join(dir, rel), body);
    for (const [rel, target] of Object.entries(opts.symlinks ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      symlinkSync(target, join(dir, rel));
    }
    const names = [
      ...new Set(
        [...Object.keys(files), ...Object.keys(opts.symlinks ?? {})].map((f) => f.split("/")[0]!),
      ),
    ];
    return execFileSync("tar", [...(opts.absolute ? ["-P"] : []), "-C", dir, "-cf", "-", ...names]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function runUpdater(
  s: Sb,
  args: string[],
  stdin: Buffer | null = tarOf(),
  env: Record<string, string> = {},
): Promise<Out> {
  return new Promise((resolveRun) => {
    const child = spawn("bash", [updater, ...args], {
      env: {
        ...process.env,
        QCR_UPDATE_CONF: s.conf,
        QCR_UPDATE_DOCKER: join(s.dir, "docker"),
        QCR_UPDATE_POLL_S: "1",
        QCR_UPDATE_NAP_S: "0.1",
        QCR_RESCUE_WAIT_S: "3",
        FAKE: s.fake,
        FAKE_DAEMON: DAEMON,
        FAKE_STATUS: s.status,
        TMPDIR: s.dir,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const GOOD = [`1.2.3@${DAEMON_DIGEST}`, "--memory-digest", MEMORY_DIGEST];
const events = (s: Sb): string[] => readFileSync(s.events, "utf8").split("\n").filter(Boolean);
const idxOf = (lines: string[], needle: string, from = 0): number => {
  const i = lines.findIndex((l, n) => n >= from && l.includes(needle));
  expect(i, `${needle} in the events`).toBeGreaterThan(-1);
  return i;
};
const operatorFiles = (s: Sb): string[] =>
  readdirSync(join(s.root, "sandbox", "commands", "operator")).filter((n) => n.endsWith(".json"));
const configText = (s: Sb): string =>
  readFileSync(join(s.root, "config-home", "config.toml"), "utf8");
const running = (s: Sb, name: string): string | null => {
  const f = join(s.fake, "containers", name, "running");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
};
const imageOf = (s: Sb, name: string): string | null => {
  const f = join(s.fake, "containers", name, "image");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
};

/** The VM exactly as it was: nothing stopped, renamed, started, swapped or written. */
function expectUntouched(s: Sb, layout: "release" | "legacy"): void {
  const lines = events(s);
  for (const forbidden of [
    "docker stop",
    "docker rename",
    "docker rm",
    "docker start",
    "docker run -d",
  ]) {
    expect(
      lines.filter((l) => l.startsWith(forbidden)),
      forbidden,
    ).toEqual([]);
  }
  expect(configText(s)).toBe("# OLD CONFIG\n");
  expect(existsSync(join(s.root, "config-home.next")), "no staged config left").toBe(false);
  expect(existsSync(join(s.root, "config-home.prev"))).toBe(false);
  expect(operatorFiles(s)).toEqual([]);
  expect(existsSync(s.backups) ? readdirSync(s.backups) : []).toEqual([]);
  expect(running(s, DAEMON)).toBe("true");
  expect(imageOf(s, DAEMON)).toBe(layout === "release" ? OLD_DAEMON_REF : LEGACY_IMAGE);
}

describe("qcr-update — arguments and the run spec", () => {
  it("must run as root unless the test seam is set", () => {
    const r = spawnSync("bash", [updater, ...GOOD], {
      encoding: "utf8",
      env: { ...process.env, QCR_UPDATE_CONF: "" },
      input: "",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("must run as root");
  });

  it("is syntactically valid bash and prints its usage on nonsense", async () => {
    expect(() => execFileSync("bash", ["-n", updater])).not.toThrow();
    sb = setup("release");
    for (const args of [[], ["1.2.3"], ["notaversion@x"]]) {
      const r = await runUpdater(sb, args, null);
      expect(r.code, args.join(" ")).not.toBe(0);
    }
  });

  it("refuses a version that is not X.Y.Z, a bad digest and a missing memory digest", async () => {
    sb = setup("release");
    for (const [args, msg] of [
      [[`latest@${DAEMON_DIGEST}`, "--memory-digest", MEMORY_DIGEST], "is not a version"],
      [["1.2.3@sha256:short", "--memory-digest", MEMORY_DIGEST], "daemon digest must be sha256"],
      [[`1.2.3@${DAEMON_DIGEST}`], "--memory-digest sha256"],
      [[`1.2.3@${DAEMON_DIGEST}`, "--memory-digest", "nope"], "--memory-digest sha256"],
    ] as const) {
      const r = await runUpdater(sb, [...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(msg);
    }
    expectUntouched(sb, "release");
  });

  it("refuses a run spec edited by hand (fingerprint), one that lacks a key, and a line it will not read", async () => {
    sb = setup("release");
    const original = readFileSync(sb.conf, "utf8");
    writeFileSync(sb.conf, original.replace("WEBHOOK_PORT=8787", "WEBHOOK_PORT=9999"));
    let r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("RUNSPEC_FINGERPRINT");
    expect(r.stderr).toContain("re-run provision");
    writeFileSync(sb.conf, original.replace(/^BACKUP_DIR=.*\n/m, ""));
    r = await runUpdater(sb, GOOD);
    expect(r.stderr).toContain("lacks BACKUP_DIR");
    writeFileSync(sb.conf, original + "RUN=$(touch /tmp/pwned)\n");
    r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("will not read");
    expectUntouched(sb, "release");
  });
});

describe("qcr-update status", () => {
  it("reports the layout, the images' labels, the run spec, the drain and the last run — as JSON and as text", async () => {
    sb = setup("release");
    let r = await runUpdater(sb, ["status", "--json"], null);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as {
      layout: string;
      daemon: { build_sha: string; runspec: string; preflight: string; running: boolean };
      memory: { image: string };
      runspec: { version: string; fingerprint: string };
      drain: { draining: boolean; running_rounds: number };
      last_run: unknown;
    };
    expect(j.layout).toBe("release");
    expect(j.daemon.build_sha).toBe("old1234");
    expect(j.daemon.runspec).toBe("2");
    expect(j.daemon.preflight).toBe("true");
    expect(j.daemon.running).toBe(true);
    expect(j.memory.image).toBe(OLD_MEMORY_REF);
    expect(j.runspec.version).toBe("2");
    expect(j.runspec.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(j.drain).toEqual({ draining: true, running_rounds: 0 });
    expect(j.last_run).toBeNull();
    r = await runUpdater(sb, ["status"], null);
    expect(r.stdout).toContain("layout        release");
    expect(r.stdout).toContain("draining=true running_rounds=0");
    // after a run, the last run is reported
    const ok = await runUpdater(sb, GOOD);
    expect(ok.code, ok.stderr).toBe(0);
    const after = JSON.parse((await runUpdater(sb, ["status", "--json"], null)).stdout) as {
      last_run: { result: string; version: string };
    };
    expect(after.last_run.result).toBe("ok");
    expect(after.last_run.version).toBe("1.2.3");
  });

  it("calls a legacy container legacy, a missing one none, and an unreadable heartbeat null", async () => {
    sb = setup("legacy");
    expect(
      (JSON.parse((await runUpdater(sb, ["status", "--json"], null)).stdout) as { layout: string })
        .layout,
    ).toBe("legacy");
    rmSync(sb.status);
    const j = JSON.parse((await runUpdater(sb, ["status", "--json"], null)).stdout) as {
      drain: { draining: null; running_rounds: null };
    };
    expect(j.drain).toEqual({ draining: null, running_rounds: null });
    rmSync(join(sb.fake, "containers", DAEMON), { recursive: true });
    expect(
      (JSON.parse((await runUpdater(sb, ["status", "--json"], null)).stdout) as { layout: string })
        .layout,
    ).toBe("none");
  });
});

describe("qcr-update — the happy path", () => {
  it("runs pull, check, stop, snapshot, preflight, swap, sidecar and recreate in the ticket's order", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    const lines = events(sb);
    const order = [
      `docker pull ${DAEMON_REF}`,
      `docker pull ${MEMORY_REF}`,
      "config check --json",
      `docker stop -t 90 ${DAEMON}`,
      "daemon --preflight",
      `docker stop -t 90 ${MEMORY}`,
      `docker rename ${MEMORY} ${MEMORY}-prev`,
      `docker run -d --name ${MEMORY}`,
      `docker exec ${MEMORY} curl -fsS http://127.0.0.1:1933/ready`,
      `docker rename ${DAEMON} ${DAEMON}-prev`,
      `docker run -d --name ${DAEMON}`,
    ].map((needle) => idxOf(lines, needle));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // nothing is built, rsynced or installed
    expect(lines.filter((l) => /docker (build|buildx|compose)/.test(l))).toEqual([]);

    // the new config is current, the previous kept; the staging dir is gone
    expect(configText(sb)).toBe("# NEW CONFIG\n");
    expect(readFileSync(join(sb.root, "config-home.prev", "config.toml"), "utf8")).toBe(
      "# OLD CONFIG\n",
    );
    expect(existsSync(join(sb.root, "config-home.next"))).toBe(false);
    // both new containers run on the new images; the old ones are kept, stopped
    expect(imageOf(sb, DAEMON)).toBe(DAEMON_REF);
    expect(imageOf(sb, MEMORY)).toBe(MEMORY_REF);
    expect(running(sb, `${DAEMON}-prev`)).toBe("false");
    // the drain is NOT touched: the new boot's first healthy reconcile lifts it
    expect(operatorFiles(sb)).toEqual([]);
    expect(JSON.parse(readFileSync(sb.status, "utf8")).draining).toBe(true);
    expect(r.stderr).toContain("The drain stays on");
  });

  it("snapshots state.db with -wal/-shm and a tar of state/pi-sessions into <version>-<ts>/, root-only", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    const dirs = readdirSync(sb.backups);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^1\.2\.3-\d{8}T\d{6}Z$/);
    const b = join(sb.backups, dirs[0]!);
    expect(readdirSync(b).sort()).toEqual([
      "pi-sessions.tar.gz",
      "state.db",
      "state.db-shm",
      "state.db-wal",
    ]);
    expect(readFileSync(join(b, "state.db"), "utf8")).toBe("SQLITE-DB");
    expect(readFileSync(join(b, "state.db-wal"), "utf8")).toBe("WAL");
    expect(statSync(b).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(b)) expect(statSync(join(b, f)).mode & 0o777, f).toBe(0o600);
    // pihome is never included
    const listing = execFileSync("tar", ["-tzf", join(b, "pi-sessions.tar.gz")], {
      encoding: "utf8",
    });
    expect(listing).toContain("pi-sessions/pr-7/round.jsonl");
    expect(listing).not.toContain("pihome");
  });

  it("runs the new image's `daemon --preflight` with --network none on a scratch COPY of the snapshot, never the live state", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    const argv = readFileSync(join(sb.fake, "preflight.argv"), "utf8").split("\n").filter(Boolean);
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv).toContain(DAEMON_REF);
    expect(argv.slice(-2)).toEqual(["daemon", "--preflight"]);
    const mounts = argv.filter((a) => /:\/opt\/qcr\/state$/.test(a));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).not.toContain(join(sb.root, "state"));
    // the scratch held the snapshot's files and the sessions
    expect(
      readFileSync(join(sb.fake, "preflight-scratch"), "utf8").split("\n").filter(Boolean).sort(),
    ).toEqual(["pi-sessions", "state.db", "state.db-shm", "state.db-wal"]);
    // the live state is as it was
    expect(readFileSync(join(sb.root, "state", "state.db"), "utf8")).toBe("SQLITE-DB");
  });

  it("builds the daemon container on the new image with the run spec's mounts, caps, network and env — and the sidecar with no published port", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    const argv = readFileSync(join(sb.fake, `run-${DAEMON}.argv`), "utf8")
      .split("\n")
      .filter(Boolean);
    const pair = (flag: string): string => argv[argv.indexOf(flag) + 1]!;
    expect(argv.slice(-2)).toEqual([DAEMON_REF, "daemon"]);
    expect(pair("--user")).toBe("1001:1001");
    // the bot stays uid 1001 (a `docker exec` lands as it) and runs the
    // model's tools as TOOL_UID:TOOL_GID through the image's setid helper; it
    // is given the helper's gate group and the tool gid; no capability but the
    // helper's two (the operator channel is root's own directory), and no
    // no-new-privileges (it would void the helper)
    const groups = argv.filter((_a, i) => argv[i - 1] === "--group-add");
    expect(groups).toEqual(["4748", "4749"]);
    const caps = argv.filter((_a, i) => argv[i - 1] === "--cap-add").sort();
    expect(caps).toEqual(["SETGID", "SETUID"]);
    expect(pair("--cap-drop")).toBe("ALL");
    expect(argv.join(" ")).not.toContain("no-new-privileges");
    expect(argv.filter((_a, i) => argv[i - 1] === "-e")).toContain("QCR_TOOLS_AS=65534");
    expect(pair("-p")).toBe("127.0.0.1:8787:8787");
    expect(pair("--network")).toBe("quickreview-memory");
    expect(pair("--cpus")).toBe("2");
    expect(pair("--memory")).toBe("8g");
    expect(pair("--memory-swap")).toBe("8g");
    expect(pair("--restart")).toBe("unless-stopped");
    expect(argv).toContain("--init");
    const vols = argv.filter((_a, i) => argv[i - 1] === "-v");
    for (const v of [
      `${sb.root}/state:/opt/qcr/state`,
      `${sb.root}/secrets:/opt/quickreview/secrets:ro`,
      `${sb.root}/config-home:/opt/quickreview/config-home:ro`,
      `${sb.root}/pihome:/home/qcr/.pi`,
      `${sb.root}/sandbox/wt:/opt/qcr/wt`,
      `${sb.root}/sandbox/commands:/opt/qcr/commands`,
      // the sessions' HOME: the daemon builds it as <app root>/pihome (sessions.ts)
      `${sb.root}/sandbox/pihome:/opt/qcr/pihome`,
      `${sb.root}/sandbox/repo:/opt/qcr/repo`,
      `${sb.root}/sandbox/wt:/opt/quickreview/sandbox/wt`,
      `${sb.root}/sandbox/repo:/opt/quickreview/sandbox/repo`,
    ]) {
      expect(vols, v).toContain(v);
    }
    const envs = argv.filter((_a, i) => argv[i - 1] === "-e");
    expect(envs).toContain("QCR_CONFIG=/opt/quickreview/config-home/config.toml");
    expect(envs).toContain("QC_BIND_HOST=0.0.0.0");
    expect(envs.join(" ")).not.toMatch(/TOKEN|SECRET|PEM/);
    expect(vols.join(" ")).not.toMatch(/docker\.sock|\.ssh/);

    const mem = readFileSync(join(sb.fake, `run-${MEMORY}.argv`), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(mem).not.toContain("-p");
    expect(mem.slice(-1)).toEqual([MEMORY_REF]);
    expect(mem.filter((_a, i) => mem[i - 1] === "-e")).toContain(
      "QCR_OPENVIKING_AUTH_MODE=api_key",
    );
    expect(mem.filter((_a, i) => mem[i - 1] === "-v")).toContain(
      `${sb.memState}:${sb.root}/state/openviking`,
    );
  });

  it("creates the network when it is missing, and tags nothing the VM lacks", async () => {
    sb = setup("release");
    rmSync(join(sb.fake, "network"));
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    expect(events(sb).some((l) => l === "docker network create quickreview-memory")).toBe(true);
  });
});

describe("qcr-update — the legacy layout and the cutover", () => {
  it("refuses without --cutover-ack <this version>, changing nothing", async () => {
    sb = setup("legacy");
    for (const args of [GOOD, [...GOOD, "--cutover-ack", "9.9.9"]]) {
      const r = await runUpdater(sb, args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("legacy layout");
      expect(r.stderr).toContain("--cutover-ack 1.2.3");
      expectUntouched(sb, "legacy");
    }
    expect(events(sb).filter((l) => l.startsWith("docker pull"))).toEqual([]);
  });

  it("with the ack: seeds the sidecar store once (copy + checksum verify), leaves the old store untouched, and recreates", async () => {
    sb = setup("legacy");
    const r = await runUpdater(sb, [...GOOD, "--cutover-ack", "1.2.3"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(sb.memState, "vectors", "data.bin"), "utf8")).toBe("VECTORS");
    expect(readFileSync(join(sb.memState, ".seeded-from-daemon"), "utf8")).toContain("seeded from");
    expect(readFileSync(join(sb.root, "state", "openviking", "vectors", "data.bin"), "utf8")).toBe(
      "VECTORS",
    );
    const lines = events(sb);
    // the seed sits between the preflight and the sidecar, with the daemon already stopped
    expect(idxOf(lines, `docker stop -t 90 ${DAEMON}`)).toBeLessThan(
      idxOf(lines, "daemon --preflight"),
    );
    expect(r.stderr).toContain("sidecar store seeded");
    // no sidecar existed: nothing renamed for it; the legacy daemon is kept as -prev
    expect(lines.some((l) => l.startsWith(`docker rename ${MEMORY}`))).toBe(false);
    expect(imageOf(sb, `${DAEMON}-prev`)).toBe(LEGACY_IMAGE);
    expect(imageOf(sb, DAEMON)).toBe(DAEMON_REF);
  });

  it("the cutover with the memory network already there (provision made it): the network's name is no sidecar to rename", async () => {
    // The 1.0.2 cutover failed here: a bare `docker inspect quickreview-memory` matched the network.
    sb = setup("legacy");
    write(join(sb.fake, "network"), "");
    const r = await runUpdater(sb, [...GOOD, "--cutover-ack", "1.2.3"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = events(sb);
    expect(lines.some((l) => l.startsWith(`docker rename ${MEMORY}`))).toBe(false);
    expect(lines.some((l) => l.startsWith(`docker stop -t 90 ${MEMORY}`))).toBe(false);
    expect(imageOf(sb, MEMORY)).toBe(MEMORY_REF);
    expect(imageOf(sb, DAEMON)).toBe(DAEMON_REF);
    // status reads no sidecar from the network either
    const st = await runUpdater(sb, ["status", "--json"]);
    expect(JSON.parse(st.stdout).memory.image).toBe(MEMORY_REF);
  });

  it("status reads no sidecar from the memory network's name", async () => {
    sb = setup("legacy");
    write(join(sb.fake, "network"), "");
    const st = await runUpdater(sb, ["status", "--json"]);
    expect(JSON.parse(st.stdout).memory).toBeNull();
  });

  it("seeds once: an existing marker means the store is not copied again", async () => {
    sb = setup("legacy");
    write(join(sb.memState, ".seeded-from-daemon"), "seeded earlier\n");
    const r = await runUpdater(sb, [...GOOD, "--cutover-ack", "1.2.3"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(sb.memState, "vectors"))).toBe(false);
    expect(r.stderr).toContain("already seeded");
  });
});

describe("qcr-update — every refusal before the stop changes nothing", () => {
  it("an undrained or busy board, or an unreadable heartbeat", async () => {
    sb = setup("release");
    const set = (v: Record<string, unknown>) => writeFileSync(sb!.status, JSON.stringify(v));
    set({ written_at: "x", draining: false, running_rounds: 0 });
    let r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not drained");
    set({ written_at: "x", draining: true, running_rounds: 2 });
    r = await runUpdater(sb, GOOD);
    expect(r.stderr).toContain("2 round(s) still running");
    rmSync(sb.status);
    r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not drained");
    writeFileSync(sb.status, "{ nope");
    r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expectUntouched(sb, "release");
    expect(events(sb).filter((l) => l.startsWith("docker pull"))).toEqual([]);
  });

  it("a pull that fails, an image at the wrong digest, a non-release image, an unstamped one", async () => {
    sb = setup("release");
    writeFileSync(join(sb.fake, "fail-pull"), "");
    let r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not pull");
    expect(r.stderr).toContain("vm-ghcr-login");
    rmSync(join(sb.fake, "fail-pull"));
    // RepoDigests says another digest
    writeFileSync(
      join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "repodigests"),
      `${DAEMON_REPO}@sha256:${"9".repeat(64)}\n`,
    );
    r = await runUpdater(sb, GOOD);
    expect(r.stderr).toContain("does not carry the digest");
    image(sb.fake, DAEMON_REF, { ...NEW_LABELS }, DAEMON_DIGEST);
    // not the release layout
    rmSync(join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels", "qcr.layout"));
    r = await runUpdater(sb, GOOD);
    expect(r.stderr).toContain("not a release-layout image");
    write(
      join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels", "qcr.layout"),
      "release",
    );
    // unstamped
    write(
      join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels", "qcr.build-sha"),
      "unstamped",
    );
    r = await runUpdater(sb, GOOD);
    expect(r.stderr).toContain("no CI build stamp");
    expectUntouched(sb, "release");
  });

  it("REFUSES an image without the qcr.preflight label: the preflight step is required", async () => {
    sb = setup("release");
    rmSync(join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels", "qcr.preflight"));
    const r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no qcr.preflight label");
    expect(events(sb).some((l) => l.includes("daemon --preflight"))).toBe(false);
    expectUntouched(sb, "release");
  });

  it("REFUSES an image whose qcr.runspec is newer than update.conf's: re-run provision", async () => {
    sb = setup("release");
    write(join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels", "qcr.runspec"), "3");
    const r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("needs run spec v3");
    expect(r.stderr).toContain("re-run provision");
    expectUntouched(sb, "release");
    // an older or equal one is fine
    write(join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels", "qcr.runspec"), "2");
    expect((await runUpdater(sb, GOOD)).code).toBe(0);
  });

  it("an image from before the setid helper (run spec v1) runs with no gate group", async () => {
    sb = setup("release");
    const labels = join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels");
    write(join(labels, "qcr.runspec"), "1");
    rmSync(join(labels, "qcr.setid-gid"));
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    const argv = readFileSync(join(sb.fake, `run-${DAEMON}.argv`), "utf8").split("\n");
    expect(argv).not.toContain("--group-add");
  });

  it("REFUSES a v2 image without a numeric setid gate group, before anything stops", async () => {
    sb = setup("release");
    const labels = join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels");
    // MUTATION: drop the qcr.setid-gid check from qcr-update.sh — this recreates
    for (const bad of ["", "x", "1001"]) {
      if (bad === "") rmSync(join(labels, "qcr.setid-gid"), { force: true });
      else write(join(labels, "qcr.setid-gid"), bad);
      const r = await runUpdater(sb, GOOD);
      expect(r.code, bad).toBe(1);
      expect(r.stderr, bad).toMatch(/qcr\.setid-gid|setid gate group/);
      expectUntouched(sb, "release");
    }
  });

  it("REFUSES a run spec whose tool identity is not the one compiled into the image, before anything stops", async () => {
    // MUTATION: drop the qcr.tool-uid/gid check from qcr-update.sh — this recreates
    sb = setup("release");
    const labels = join(sb.fake, "images", DAEMON_REF.replace(/[/:@]/g, "_"), "labels");
    for (const [label, bad] of [
      ["qcr.tool-uid", "1000"],
      ["qcr.tool-gid", "4242"],
    ] as const) {
      write(join(labels, label), bad);
      const r = await runUpdater(sb, GOOD);
      expect(r.code, label).toBe(1);
      expect(r.stderr, label).toMatch(
        /runs the model's tools as tool (uid|gid) .*re-run provision/,
      );
      expectUntouched(sb, "release");
      write(join(labels, label), NEW_LABELS[label]!);
    }
  });

  it("seals the operator channel as root before the bot starts, and never through a symlink", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD);
    expect(r.code, r.stderr).toBe(0);
    expect(statSync(join(sb.root, "sandbox", "commands", "operator")).isDirectory()).toBe(true);
  });

  it("REFUSES a config tar that contains secrets/, an escaping path, a link, or any other top-level name", async () => {
    sb = setup("release");
    const bad: [string, Buffer][] = [
      ["secrets/", tarOf({ "config.toml": "x\n", "secrets/app.pem": "KEY\n" })],
      ["secrets/", tarOf({ "config.toml": "x\n", secrets: "file named secrets\n" })],
      ["only config.toml and profiles/", tarOf({ "config.toml": "x\n", "notes.txt": "n\n" })],
      ["a link", tarOf({ "config.toml": "x\n" }, { symlinks: { "profiles/evil": "/etc" } })],
      ["absolute or parent", tarOf({ "config.toml": "x\n" }, { absolute: true })],
    ];
    // an absolute-path member: build it with -P from a real absolute file
    const abs = join(sb.dir, "abs.toml");
    writeFileSync(abs, "x\n");
    bad[4] = ["absolute or parent", execFileSync("tar", ["-P", "-cf", "-", abs])];
    for (const [msg, tar] of bad) {
      const r = await runUpdater(sb, GOOD, tar);
      expect(r.code, msg).toBe(1);
      expect(r.stderr, msg).toContain("refusing the config tar");
      expect(r.stderr, msg).toContain(msg);
    }
    const empty = await runUpdater(sb, GOOD, Buffer.alloc(0));
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("no config tar on stdin");
    const noConfig = await runUpdater(sb, GOOD, tarOf({ "profiles/p/profile.toml": "x\n" }));
    expect(noConfig.stderr).toContain("no config.toml");
    expectUntouched(sb, "release");
    // …and secrets never reach the VM's config home
    expect(existsSync(join(sb.root, "config-home", "secrets"))).toBe(false);
  });

  it("REFUSES a config the new image's `qcr config check` fails on, and prints what it found", async () => {
    sb = setup("release");
    writeFileSync(join(sb.fake, "config-check-rc"), "1");
    writeFileSync(
      join(sb.fake, "config-check-out"),
      JSON.stringify({
        ok: false,
        errors: [{ where: "config.toml", message: "retired key [slack] inbound" }],
      }),
    );
    const r = await runUpdater(sb, GOOD);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qcr config check");
    expect(r.stderr).toContain("retired key [slack] inbound");
    expectUntouched(sb, "release");
    // the check ran on the NEW image, with no network, on the STAGED config, read-only
    const check = events(sb).find((l) => l.includes("config check --json"))!;
    expect(check).toContain(DAEMON_REF);
    expect(check).toContain("--network none");
    expect(check).toContain("config-home.next:/cfg:ro");
  });

  it("takes a flock: a second updater is refused while the first holds it", async () => {
    sb = setup("release");
    mkdirSync(sb.upd, { recursive: true });
    mkdirSync(join(sb.root, "config-home.next"));
    write(join(sb.root, "config-home.next", "staged.txt"), "the other run's staging\n");
    const holder = spawn("flock", [join(sb.upd, "update.lock"), "sleep", "5"]);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await runUpdater(sb, GOOD);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("another qcr-update is running");
      // …and the refused run never touches what the running one stages
      expect(readFileSync(join(sb.root, "config-home.next", "staged.txt"), "utf8")).toContain(
        "other run",
      );
      rmSync(join(sb.root, "config-home.next"), { recursive: true });
      expectUntouched(sb, "release");
    } finally {
      holder.kill();
    }
  });

  for (const step of [
    "lock",
    "read-config",
    "drain",
    "layout",
    "pull",
    "check-images",
    "runspec",
    "stage-config",
    "config-check",
  ]) {
    it(`a failure injected at '${step}' changes nothing`, async () => {
      sb = setup("release");
      const r = await runUpdater(sb, GOOD, tarOf(), { QCR_UPDATE_FAIL_AT: step });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`step '${step}'`);
      expect(r.stderr).toContain("nothing was changed");
      expect(r.stderr).not.toContain("RESCUE");
      expectUntouched(sb, "release");
    });
  }
});

describe("qcr-update — the rescue", () => {
  // the steps at or after the legacy layout's seed
  const SEEDED_BY = ["swap", "sidecar-start", "sidecar-ready", "recreate"];
  const RESCUED_STEPS = [
    "stop",
    "snapshot",
    "preflight",
    "seed",
    "swap",
    "sidecar-start",
    "sidecar-ready",
    "recreate",
  ];

  /** The rescue's contract, in the ticket's order. */
  function expectRescued(s: Sb, layout: "release" | "legacy", out: Out, step: string): void {
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain(`step '${step}'`);
    expect(out.stderr).toContain("RESCUE complete");
    // 1. the old config is back (the failed new one is kept aside)
    expect(configText(s)).toBe("# OLD CONFIG\n");
    expect(readFileSync(join(s.root, "config-home", "profiles", "p", "profile.toml"), "utf8")).toBe(
      "# old profile\n",
    );
    // 2. the newly started sidecar is gone; the old one is back, running, on its own image
    if (layout === "release") {
      expect(imageOf(s, MEMORY)).toBe(OLD_MEMORY_REF);
      expect(running(s, MEMORY)).toBe("true");
      expect(existsSync(join(s.fake, "containers", `${MEMORY}-prev`))).toBe(false);
    } else {
      expect(existsSync(join(s.fake, "containers", MEMORY))).toBe(false);
      // a store this run seeded is set aside, never deleted, so the next run seeds afresh
      const aside = readdirSync(dirname(s.memState)).filter((n) =>
        n.startsWith("memory-state.rescued-"),
      );
      if (SEEDED_BY.includes(step)) {
        expect(existsSync(s.memState)).toBe(false);
        expect(aside).toHaveLength(1);
        expect(
          readFileSync(join(dirname(s.memState), aside[0]!, "vectors", "data.bin"), "utf8"),
        ).toBe("VECTORS");
      } else {
        expect(aside).toHaveLength(0);
      }
    }
    // 3. the OLD daemon container runs again, on its own image, under its own name
    expect(imageOf(s, DAEMON)).toBe(layout === "release" ? OLD_DAEMON_REF : LEGACY_IMAGE);
    expect(running(s, DAEMON)).toBe("true");
    expect(existsSync(join(s.fake, "containers", `${DAEMON}-prev`))).toBe(false);
    // 4. the order: old daemon started, THEN (after its first reconcile lifted the
    //    drain) drain on re-sent through the operator channel
    const lines = events(s);
    const started = lines.lastIndexOf(`docker start ${DAEMON}`);
    const drained = lines.indexOf("daemon: drain-on");
    expect(started, "the old daemon was started").toBeGreaterThan(-1);
    expect(drained, "drain on was re-sent").toBeGreaterThan(started);
    if (layout === "release") {
      // the old sidecar is back up before the old daemon boots against it
      const sidecar = lines.findIndex((l) => l === `docker start ${MEMORY}`);
      if (sidecar >= 0) expect(sidecar).toBeLessThan(started);
    }
    // 5. the drain command is the sealed channel's `drain on`, confirmed in status.json
    const files = operatorFiles(s);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/qcr-update-drain\.json$/);
    expect(
      JSON.parse(readFileSync(join(s.root, "sandbox", "commands", "operator", files[0]!), "utf8")),
    ).toEqual({
      command: "drain",
      on: true,
    });
    expect(JSON.parse(readFileSync(s.status, "utf8")).draining).toBe(true);
    expect(out.stderr).toContain("drain on confirmed");
    // 6. the run is recorded as rescued
    const last = JSON.parse(readFileSync(join(s.upd, "last-run.json"), "utf8")) as {
      result: string;
      step: string;
    };
    expect(last.result).toBe("rescued");
    expect(last.step).toBe(step);
  }

  for (const layout of ["release", "legacy"] as const) {
    for (const step of RESCUED_STEPS) {
      it(`${layout} layout: a failure injected at '${step}' is rescued — old config, old containers, drain re-sent, non-zero`, async () => {
        sb = setup(layout);
        const args = layout === "legacy" ? [...GOOD, "--cutover-ack", "1.2.3"] : GOOD;
        const r = await runUpdater(sb, args, tarOf(), { QCR_UPDATE_FAIL_AT: step });
        expectRescued(sb, layout, r, step);
      });
    }
  }

  it("a real docker failure at the stop is rescued the same way", async () => {
    sb = setup("release");
    writeFileSync(join(sb.fake, "fail-stop"), "");
    const r = await runUpdater(sb, GOOD);
    expectRescued(sb, "release", r, "stop");
  });

  it("a failing `daemon --preflight` (the new image rejects the snapshot) is rescued", async () => {
    sb = setup("release");
    writeFileSync(join(sb.fake, "preflight-rc"), "3");
    const r = await runUpdater(sb, GOOD);
    expect(r.stderr).toContain("`daemon --preflight` failed");
    expectRescued(sb, "release", r, "preflight");
    // the live state was never touched by the scratch run
    expect(readFileSync(join(sb.root, "state", "state.db"), "utf8")).toBe("SQLITE-DB");
  });

  it("a sidecar that never becomes ready is rescued: the new sidecar removed, the old one back", async () => {
    sb = setup("release");
    writeFileSync(join(sb.fake, "ready-rc"), "22");
    const r = await runUpdater(sb, GOOD, tarOf(), { QCR_MEMORY_READY_TIMEOUT_S: "2" });
    expect(r.stderr).toContain("was not ready within 2s");
    expectRescued(sb, "release", r, "sidecar-ready");
  });

  it("a daemon container that cannot be created is rescued: the old container is renamed back and started", async () => {
    sb = setup("legacy");
    writeFileSync(join(sb.fake, `fail-run-${DAEMON}`), "");
    const r = await runUpdater(sb, [...GOOD, "--cutover-ack", "1.2.3"]);
    expectRescued(sb, "legacy", r, "recreate");
  });

  it("a cutover retried after a rescue seeds the sidecar store again from the legacy store as it now is", async () => {
    sb = setup("legacy");
    const args = [...GOOD, "--cutover-ack", "1.2.3"];
    const first = await runUpdater(sb, args, tarOf(), { QCR_UPDATE_FAIL_AT: "sidecar-start" });
    expectRescued(sb, "legacy", first, "sidecar-start");
    // the legacy daemon ran again and wrote to its store meanwhile
    write(join(sb.root, "state", "openviking", "vectors", "data.bin"), "VECTORS-NEWER");
    writeFileSync(
      sb.status,
      JSON.stringify({ written_at: "x", draining: true, running_rounds: 0 }),
    );
    const second = await runUpdater(sb, args);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain("sidecar store seeded");
    expect(readFileSync(join(sb.memState, "vectors", "data.bin"), "utf8")).toBe("VECTORS-NEWER");
  });

  it("waits for the old daemon's first reconcile before re-sending the drain (the heartbeat shows the lift)", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD, tarOf(), { QCR_UPDATE_FAIL_AT: "swap" });
    expect(r.stderr).toContain("the old daemon's first reconcile has run");
    const lines = r.stderr.split("\n");
    expect(lines.findIndex((l) => l.includes("first reconcile has run"))).toBeLessThan(
      lines.findIndex((l) => l.includes("drain on confirmed")),
    );
  });

  it("if the old daemon's first reconcile never comes, the drain is still re-sent after the wait", async () => {
    sb = setup("release");
    // a start that does not touch status.json: the heartbeat stays draining=true, from before
    const r = await runUpdater(sb, GOOD, tarOf(), { QCR_UPDATE_FAIL_AT: "swap", FAKE_STATUS: "" });
    expect(r.stderr).toContain("no first reconcile from the old daemon within 3s");
    expectRescued(sb, "release", r, "swap");
  });

  it("a fresh heartbeat that still says draining=true is not a first reconcile: the wait runs out", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD, tarOf(), {
      QCR_UPDATE_FAIL_AT: "swap",
      FAKE_START_DRAINING: "1",
    });
    expect(r.stderr).toContain("no first reconcile from the old daemon within 3s");
    expect(r.stderr).not.toContain("first reconcile has run");
    expectRescued(sb, "release", r, "swap");
  });

  it("a rescue whose drain cannot be confirmed says so, and still exits non-zero", async () => {
    sb = setup("release");
    sb.stopDaemon();
    const r = await runUpdater(sb, GOOD, tarOf(), { QCR_UPDATE_FAIL_AT: "swap" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("COULD NOT CONFIRM drain on");
    expect(r.stderr).toContain("RESCUE INCOMPLETE");
    expect(configText(sb)).toBe("# OLD CONFIG\n");
    sb.stopDaemon = () => {};
  }, 30_000);

  it("nothing is rescued on a fresh VM with no daemon container: it fails non-zero, naming the step", async () => {
    sb = setup("none");
    const r = await runUpdater(sb, GOOD, tarOf(), { QCR_UPDATE_FAIL_AT: "swap" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("step 'swap'");
    expect(configText(sb)).toBe("# OLD CONFIG\n");
    expect(operatorFiles(sb)).toEqual([]);
  });
});

describe("qcr-update — a failure AFTER the recreate", () => {
  it("keeps the drain on, rescues nothing, keeps the previous container, and exits non-zero (fix forward)", async () => {
    sb = setup("release");
    const r = await runUpdater(sb, GOOD, tarOf(), { QCR_UPDATE_FAIL_AT: "post-recreate" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("AFTER the recreate");
    expect(r.stderr).toContain("the drain stays on");
    expect(r.stderr).not.toContain("RESCUE");
    // the new version is what runs; the old config and container are kept for the operator
    expect(configText(sb)).toBe("# NEW CONFIG\n");
    expect(imageOf(sb, DAEMON)).toBe(DAEMON_REF);
    expect(existsSync(join(sb.fake, "containers", `${DAEMON}-prev`))).toBe(true);
    expect(operatorFiles(sb)).toEqual([]);
    expect(JSON.parse(readFileSync(sb.status, "utf8")).draining).toBe(true);
    const last = JSON.parse(readFileSync(join(sb.upd, "last-run.json"), "utf8")) as {
      result: string;
    };
    expect(last.result).toBe("failed-forward");
  });
});
