// scripts/vm-postcutover-cleanup.sh — the owner's one-off cleanup after the
// release-image cutover, driven against a temp-dir VM tree and a FAKE docker
// (a bash script that keeps containers and images as files). The layout comes
// from the REAL deploy/qcr-update.sh `status --json`, run in its own test seam
// against the same fake docker. Nothing here touches a real docker or a VM.
//
// What is pinned:
//   - the dry run (the default) removes nothing and lists only allowlisted
//     checkout paths, the legacy images and the snapshots past the newest three
//   - `--apply <key>` removes exactly that list; every runtime dir, the state,
//     secrets, config homes, pihome, the memory stores and the pre-sidecar
//     OpenViking store survive; a second run has nothing to remove
//   - a stale or wrong key, and any layout but release, remove nothing
//   - every `$ROOT/sandbox/<dir>` the updater mounts is kept, derived from the
//     updater itself: MUTATION: a copy of the updater that also mounts
//     `$ROOT/sandbox/src` (a name on the checkout allowlist) — the dry run must
//     keep src. Drop the updater parse from the script and this fails.
//   - a container's bind mount (any container, stopped too) protects the path,
//     and an image a container uses is kept
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts", "vm-postcutover-cleanup.sh");
const realUpdater = join(repo, "deploy", "qcr-update.sh");

const DAEMON = "quickreview-sandbox";
const MEMORY = "quickreview-memory";
const CLONE = "reviewed-repo";
const RELEASE_LABELS = {
  "qcr.layout": "release",
  "qcr.build-sha": "abc1234",
  "qcr.preflight": "true",
  "qcr.runspec": "1",
};

const FAKE_DOCKER = `#!/bin/bash
F="$FAKE"
echo "docker $*" >> "$F/events"
cmd="$1"; shift
case "$cmd" in
  ps) ls -1 "$F/containers" ;;
  container)
    [ "$1" = inspect ] || exit 1
    fmt="$3"; d="$F/containers/$4"; [ -d "$d" ] || exit 1
    case "$fmt" in
      *Config.Labels*)
        l="$(sed -n 's/.*index \\.Config\\.Labels "\\([^"]*\\)".*/\\1/p' <<<"$fmt")"
        if [ -f "$d/labels/$l" ]; then cat "$d/labels/$l"; else echo '<no value>'; fi ;;
      '{{.Id}}') echo "id-$4" ;;
      '{{.Config.Image}}') cat "$d/ref" ;;
      '{{.State.Running}}') cat "$d/running" ;;
      '{{.Name}} {{.Image}}') echo "/$4 $(cat "$d/imageid")" ;;
      *Mounts*) cat "$d/mounts" ;;
      *) exit 1 ;;
    esac ;;
  image)
    case "$1" in
      ls) cat "$F/images" ;;
      rm)
        [ ! -f "$F/fail-rmi" ] || exit 1
        grep -q "^$2 " "$F/images" || exit 1
        grep -v "^$2 " "$F/images" > "$F/images.new"; mv "$F/images.new" "$F/images" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`;

interface Vm {
  dir: string;
  root: string;
  sandbox: string;
  backups: string;
  fake: string;
  conf: string;
  updater: string;
  memState: string;
}

let vm: Vm | undefined;
afterEach(() => {
  if (vm) rmSync(vm.dir, { recursive: true, force: true });
  vm = undefined;
});

function write(path: string, body = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function confText(root: string, backups: string, memState: string, upd: string): string {
  const body = [
    "RUNSPEC_VERSION=2",
    `SANDBOX_ROOT=${root}`,
    "APP_ROOT=/opt/qcr",
    `DAEMON_CONTAINER=${DAEMON}`,
    `MEMORY_CONTAINER=${MEMORY}`,
    "DAEMON_IMAGE_REPO=ghcr.io/example/quickreview",
    "MEMORY_IMAGE_REPO=ghcr.io/example/quickreview-memory",
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
    `OPENVIKING_HOME=${root}/state/openviking`,
    "OPENVIKING_PORT=1933",
    `BASE_CLONE_DIR=${CLONE}`,
    "LEGACY_SANDBOX_ROOT=/opt/quickreview/sandbox",
    `BACKUP_DIR=${backups}`,
    `UPDATE_STATE_DIR=${upd}`,
  ];
  const fp = createHash("sha256")
    .update(body.join("\n") + "\n")
    .digest("hex");
  return `# run spec (test)\n${body.join("\n")}\nRUNSPEC_FINGERPRINT=${fp}\n`;
}

function container(
  v: Vm,
  name: string,
  opts: {
    ref: string;
    id: string;
    labels?: Record<string, string>;
    mounts: string[];
    running?: boolean;
  },
): void {
  const d = join(v.fake, "containers", name);
  mkdirSync(join(d, "labels"), { recursive: true });
  write(join(d, "ref"), `${opts.ref}\n`);
  write(join(d, "imageid"), `${opts.id}\n`);
  write(join(d, "running"), `${opts.running ?? true}\n`);
  write(join(d, "mounts"), opts.mounts.map((m) => `${m}\n`).join(""));
  for (const [k, val] of Object.entries(opts.labels ?? {})) write(join(d, "labels", k), val);
}

const ID = (c: string): string => `sha256:${c.repeat(64)}`;

/** The `$ROOT/sandbox/<dir>` mounts of a qcr-update script, as this test reads them. */
function updaterSandboxMounts(updater: string): string[] {
  const text = readFileSync(updater, "utf8");
  const dirs = [...text.matchAll(/-v "\$ROOT\/sandbox\/([^:"]+):/g)].map((m) =>
    m[1]!.replace("${C[BASE_CLONE_DIR]}", CLONE),
  );
  return [...new Set(dirs)].sort();
}

/** The VM after the cutover: a realistic tree, the release containers, the legacy images. */
function setup(layout: "release" | "legacy" = "release"): Vm {
  const dir = mkdtempSync(join(tmpdir(), "qcr-cleanup-"));
  const root = join(dir, "opt-quickreview");
  const sandbox = join(root, "sandbox");
  const backups = join(dir, "backups");
  const fake = join(dir, "fake");
  const memState = join(root, "memory-state");
  const upd = join(dir, "upd-state");
  const updater = join(dir, "qcr-update");
  copyFileSync(realUpdater, updater);
  chmodSync(updater, 0o755);
  write(join(dir, "docker"), FAKE_DOCKER);
  chmodSync(join(dir, "docker"), 0o755);
  write(join(dir, "update.conf"), confText(root, backups, memState, upd));
  mkdirSync(join(fake, "containers"), { recursive: true });
  writeFileSync(join(fake, "events"), "");
  const v: Vm = {
    dir,
    root,
    sandbox,
    backups,
    fake,
    conf: join(dir, "update.conf"),
    updater,
    memState,
  };

  // outside the checkout: never touched
  write(join(root, "state", "state.db"), "DB");
  write(join(root, "state", "openviking", "vectors", "data.bin"), "PRE-SIDECAR STORE");
  write(join(root, "secrets", "app.pem"), "KEY");
  write(join(root, "config-home", "config.toml"));
  write(join(root, "config-home.prev", "config.toml"));
  write(join(root, "config-home.failed", "config.toml"));
  write(join(root, "pihome", "agent", "auth.json"));
  write(join(memState, "vectors", "data.bin"));
  write(join(root, "memory-state.rescued-20261020T101500Z", "data.bin"));
  write(join(root, "memory-state.rescued-20261020T131500Z", "data.bin"));

  // the runtime mounts (every one the updater names, and the base clone's git)
  for (const m of updaterSandboxMounts(realUpdater)) write(join(sandbox, m, ".keep"));
  write(join(sandbox, "wt", "pr-6075", "src", "app.py"));
  write(join(sandbox, "commands", "operator", ".sealed"));
  write(join(sandbox, "pihome", ".gitconfig"));
  write(join(sandbox, CLONE, ".git", "HEAD"), "ref: refs/heads/master\n");

  // the stale checkout the legacy rsync shipped, and what the VM built in it
  write(join(sandbox, "src", "daemon.ts"));
  write(join(sandbox, "dist", "src", "daemon.js"));
  write(join(sandbox, "node_modules", "smol-toml", "index.js"));
  write(join(sandbox, "package.json"), "{}");
  write(join(sandbox, "config.toml"));
  write(join(sandbox, "docs", "tui.md"));
  write(join(sandbox, ".github", "workflows", "ci.yml"));
  write(join(sandbox, "BUILD_SHA"), "deadbeef\n");

  // the legacy runtime data the rsync excluded, and a stranger
  write(join(sandbox, "state", ".gitkeep"));
  write(join(sandbox, "memory", "MEMORY.md"));
  write(join(sandbox, "notes", "n.md"));
  write(join(sandbox, "ledger.md"));
  write(join(sandbox, "AGENTS.override.md"));
  write(join(sandbox, "mystery.txt"));

  // the updater's snapshots: version order is not age order
  for (const s of [
    "1.0.10-20261019T000000Z",
    "1.0.1-20261020T100000Z",
    "1.0.2-20261020T120000Z",
    "1.0.3-20261021T090000Z",
    "1.0.4-20261021T150000Z",
    "1.0.5-20261021T200000Z",
  ])
    write(join(backups, s, "state.db"));
  write(join(backups, "README.txt"));

  writeFileSync(
    join(fake, "images"),
    [
      `quickreview-sandbox:v1 ${ID("1")}`,
      `quickreview-sandbox:dev ${ID("2")}`,
      `quickreview-memory:v1 ${ID("3")}`,
      `ghcr.io/example/quickreview:1.0.5 ${ID("a")}`,
      `ghcr.io/example/quickreview:1.0.4 ${ID("b")}`,
      `ghcr.io/example/quickreview-memory:1.0.5 ${ID("c")}`,
      `<none>:<none> ${ID("9")}`,
    ]
      .map((l) => `${l}\n`)
      .join(""),
  );

  const daemonMounts = [
    join(root, "state"),
    join(root, "secrets"),
    join(root, "config-home"),
    join(root, "pihome"),
    ...updaterSandboxMounts(realUpdater).map((m) => join(sandbox, m)),
  ];
  if (layout === "release") {
    container(v, DAEMON, {
      ref: "ghcr.io/example/quickreview@sha256:aa",
      id: ID("a"),
      labels: RELEASE_LABELS,
      mounts: daemonMounts,
    });
    container(v, `${DAEMON}-prev`, {
      ref: "ghcr.io/example/quickreview@sha256:bb",
      id: ID("b"),
      labels: RELEASE_LABELS,
      mounts: daemonMounts,
      running: false,
    });
  } else {
    container(v, DAEMON, {
      ref: "quickreview-sandbox:v1",
      id: ID("1"),
      mounts: [sandbox, join(root, "state")],
    });
  }
  container(v, MEMORY, {
    ref: "ghcr.io/example/quickreview-memory@sha256:cc",
    id: ID("c"),
    mounts: [memState, join(root, "secrets"), join(root, "config-home")],
  });
  return v;
}

function run(
  v: Vm,
  args: string[] = [],
  env: Record<string, string> = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: v.dir,
      TMPDIR: v.dir,
      FAKE: v.fake,
      QCR_CLEANUP_CONF: v.conf,
      QCR_CLEANUP_UPDATER: v.updater,
      QCR_CLEANUP_DOCKER: join(v.dir, "docker"),
      // the real updater's own seam, for its `status --json`
      QCR_UPDATE_CONF: v.conf,
      QCR_UPDATE_DOCKER: join(v.dir, "docker"),
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file under the VM tree (root and backups), relative to the temp dir. */
function files(v: Vm): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(v.dir, p));
    }
  };
  walk(v.root);
  walk(v.backups);
  return out.sort();
}

function rows(stdout: string, verb: "remove" | "keep"): Array<{ kind: string; what: string }> {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith(`${verb} `))
    .map((l) => {
      const m = /^\S+\s+(\S+)\s+(.*?)(?: — .*)?$/.exec(l)!;
      return { kind: m[1]!, what: m[2]! };
    });
}

function planKey(stdout: string): string {
  const m = /^plan key: ([0-9a-f]{16})$/m.exec(stdout);
  expect(m, stdout).not.toBeNull();
  return m![1]!;
}

const CHECKOUT_REMOVED = [
  ".github",
  "BUILD_SHA",
  "config.toml",
  "dist",
  "docs",
  "node_modules",
  "package.json",
  "src",
];
const SNAPSHOTS_REMOVED = [
  "1.0.1-20261020T100000Z",
  "1.0.10-20261019T000000Z",
  "1.0.2-20261020T120000Z",
];
const IMAGES_REMOVED = [
  "quickreview-memory:v1",
  "quickreview-sandbox:dev",
  "quickreview-sandbox:v1",
];

function expectedRemovals(v: Vm): string[] {
  return [
    ...IMAGES_REMOVED.map((i) => `image ${i}`),
    ...CHECKOUT_REMOVED.map((n) => `checkout ${join(v.sandbox, n)}`),
    ...SNAPSHOTS_REMOVED.map((n) => `snapshot ${join(v.backups, n)}`),
  ].sort();
}

describe("vm-postcutover-cleanup: the dry run", () => {
  it("is the default: removes nothing and lists only allowlisted checkout paths, legacy images and old snapshots", () => {
    vm = setup();
    const before = files(vm);
    const r = run(vm);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(files(vm)).toEqual(before);
    expect(readFileSync(join(vm.fake, "events"), "utf8")).not.toMatch(/image rm/);

    const removed = rows(r.stdout, "remove").map((x) => `${x.kind} ${x.what}`);
    expect(removed.sort()).toEqual(expectedRemovals(vm));
    // every checkout removal is a direct child of sandbox/ on the allowlist
    for (const x of rows(r.stdout, "remove").filter((x) => x.kind === "checkout")) {
      expect(dirname(x.what)).toBe(vm.sandbox);
      expect(CHECKOUT_REMOVED).toContain(x.what.slice(vm.sandbox.length + 1));
    }

    const kept = rows(r.stdout, "keep");
    const keptWhat = (kind: string): string[] =>
      kept.filter((x) => x.kind === kind).map((x) => x.what.replace(`${vm!.dir}/`, ""));
    expect(keptWhat("runtime").sort()).toEqual(
      updaterSandboxMounts(realUpdater).map((m) => `opt-quickreview/sandbox/${m}`),
    );
    expect(keptWhat("legacy").sort()).toEqual(
      ["AGENTS.override.md", "ledger.md", "memory", "notes", "state"].map(
        (n) => `opt-quickreview/sandbox/${n}`,
      ),
    );
    expect(keptWhat("unknown").sort()).toEqual([
      "backups/README.txt",
      "opt-quickreview/sandbox/mystery.txt",
    ]);
    expect(keptWhat("snapshot").sort()).toEqual([
      "backups/1.0.3-20261021T090000Z",
      "backups/1.0.4-20261021T150000Z",
      "backups/1.0.5-20261021T200000Z",
    ]);
    expect(keptWhat("owner").sort()).toEqual([
      "opt-quickreview/memory-state.rescued-20261020T101500Z",
      "opt-quickreview/memory-state.rescued-20261020T131500Z",
      "opt-quickreview/state/openviking",
    ]);
    expect(r.stdout).toMatch(/state\/openviking — the daemon's pre-sidecar OpenViking store/);
    planKey(r.stdout);
  });

  it("protects every sandbox dir the updater mounts, derived from the updater (MUTATION: a new mount of src)", () => {
    vm = setup();
    // the containers mount nothing: only the updater's text and the baseline protect
    for (const c of readdirSync(join(vm.fake, "containers")))
      writeFileSync(join(vm.fake, "containers", c, "mounts"), "");
    const text = readFileSync(vm.updater, "utf8");
    const anchor = '  -v "$ROOT/sandbox/pihome:${C[APP_ROOT]}/pihome"\n';
    expect(text).toContain(anchor);
    writeFileSync(
      vm.updater,
      text.replace(anchor, `${anchor}  -v "$ROOT/sandbox/src:\${C[APP_ROOT]}/src"\n`),
    );
    expect(updaterSandboxMounts(vm.updater)).toContain("src");

    const r = run(vm);
    expect(r.status, r.stderr).toBe(0);
    const keptRuntime = rows(r.stdout, "keep")
      .filter((x) => x.kind === "runtime")
      .map((x) => x.what.slice(vm!.sandbox.length + 1));
    for (const m of updaterSandboxMounts(vm.updater)) expect(keptRuntime).toContain(m);
    expect(r.stdout).toMatch(/keep\s+runtime\s+\S+\/sandbox\/src — mounted by qcr-update/);
    expect(rows(r.stdout, "remove").map((x) => x.what)).not.toContain(join(vm.sandbox, "src"));
  });

  it("keeps a path any container mounts (stopped too) and an image a container uses", () => {
    vm = setup();
    container(vm, "leftover-legacy", {
      ref: "quickreview-sandbox:v1",
      id: ID("1"),
      mounts: [join(vm.sandbox, "docs", "sub"), join(vm.backups, "1.0.1-20261020T100000Z")],
      running: false,
    });
    const r = run(vm);
    expect(r.status, r.stderr).toBe(0);
    const removed = rows(r.stdout, "remove").map((x) => x.what);
    expect(removed).not.toContain(join(vm.sandbox, "docs"));
    expect(removed).not.toContain(join(vm.backups, "1.0.1-20261020T100000Z"));
    expect(removed).not.toContain("quickreview-sandbox:v1");
    expect(r.stdout).toMatch(
      /keep\s+runtime\s+\S+\/sandbox\/docs — mounted by container leftover-legacy/,
    );
    expect(r.stdout).toMatch(
      /keep\s+image\s+quickreview-sandbox:v1 — in use by container leftover-legacy/,
    );
  });
});

describe("vm-postcutover-cleanup: apply", () => {
  it("removes exactly the listed plan, keeps every runtime dir, and is idempotent", () => {
    vm = setup();
    const before = files(vm);
    const dry = run(vm);
    const r = run(vm, ["--apply", planKey(dry.stdout)]);
    expect(r.status, r.stderr).toBe(0);

    const gone = [
      ...CHECKOUT_REMOVED.map((n) => `opt-quickreview/sandbox/${n}`),
      ...SNAPSHOTS_REMOVED.map((n) => `backups/${n}`),
    ];
    const isGone = (f: string): boolean => gone.some((g) => f === g || f.startsWith(`${g}/`));
    expect(files(vm)).toEqual(before.filter((f) => !isGone(f)));
    for (const m of updaterSandboxMounts(realUpdater))
      expect(existsSync(join(vm.sandbox, m))).toBe(true);
    for (const p of [
      "sandbox/wt/pr-6075/src/app.py",
      "sandbox/commands/operator/.sealed",
      "sandbox/pihome/.gitconfig",
      `sandbox/${CLONE}/.git/HEAD`,
      "state/openviking/vectors/data.bin",
      "secrets/app.pem",
      "pihome/agent/auth.json",
      "memory-state/vectors/data.bin",
      "memory-state.rescued-20261020T101500Z/data.bin",
      "config-home.prev/config.toml",
    ])
      expect(existsSync(join(vm.root, p)), p).toBe(true);

    const images = readFileSync(join(vm.fake, "images"), "utf8");
    for (const i of IMAGES_REMOVED) expect(images).not.toContain(`${i} `);
    expect(images).toContain("ghcr.io/example/quickreview:1.0.5 ");
    expect(readFileSync(join(vm.fake, "events"), "utf8")).not.toMatch(/image rm (-f|--force)/);

    const again = run(vm);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("nothing to remove");
    expect(rows(again.stdout, "remove")).toEqual([]);
    const reapply = run(vm, ["--apply", planKey(dry.stdout)]);
    expect(reapply.status, reapply.stderr).toBe(0);
    expect(reapply.stdout).toContain("nothing to remove");
  });

  it("refuses a wrong key, and a plan that changed since the dry run, removing nothing", () => {
    vm = setup();
    const before = files(vm);
    const dry = run(vm);
    const wrong = run(vm, ["--apply", "0000000000000000"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/not the one the dry run listed/);
    expect(files(vm)).toEqual(before);

    write(join(vm.sandbox, "tests", "new.test.ts"));
    const stale = run(vm, ["--apply", planKey(dry.stdout)]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/Run the dry run again/);
    expect(files(vm)).toEqual([...before, "opt-quickreview/sandbox/tests/new.test.ts"].sort());
  });

  it("needs a key", () => {
    vm = setup();
    expect(run(vm, ["--apply"]).status).toBe(2);
  });
});

describe("vm-postcutover-cleanup: refusals", () => {
  it("refuses on the legacy layout, removing nothing", () => {
    vm = setup("legacy");
    const before = files(vm);
    for (const args of [[], ["--apply", "0000000000000000"]]) {
      const r = run(vm, args);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/layout 'legacy', not release/);
    }
    expect(files(vm)).toEqual(before);
  });

  it("refuses when the updater cannot report a layout", () => {
    vm = setup();
    const r = run(vm, [], { QCR_UPDATE_CONF: join(vm.dir, "missing.conf") });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/qcr-update status --json` failed/);
  });

  it("refuses an updater that names no sandbox mount", () => {
    vm = setup();
    writeFileSync(
      vm.updater,
      readFileSync(vm.updater, "utf8").replaceAll("$ROOT/sandbox/", "$ROOT/elsewhere/"),
    );
    const r = run(vm);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/found no \$ROOT\/sandbox\/ mount/);
  });

  it("refuses to run outside its seam unless root", () => {
    vm = setup();
    const r = run(vm, [], { QCR_CLEANUP_CONF: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/must run as root/);
  });
});
