// scripts/cutover.sh (P8.21a) — the owner's cutover wizard, driven end to end
// against stubbed ssh, deploy.sh and qcr. Nothing here touches a VM, GitHub,
// docker or the network. Pinned:
//   - a resumed run skips finished stages and never repeats the release
//   - an undrained board blocks before anything is deployed
//   - a failed release stops with the output shown, and resumes at the release
//   - nothing runs without the explicit go (the typed version, the plan check)
//   - the drain is HELD after the release and lifted only on the owner's go:
//     the release's first boot keeps the operator's drain as the no-auto-lift
//     hold (P8.21b), the wizard checks that it still stands as a hold after
//     the first healthy reconcile, and stops loudly — never re-drains — when
//     it does not
//   - only an operator drain goes into the release (a session-bounded one
//     would be lifted by the boot)
//   - no force flag is ever passed or spelled
//   - stage 9: every tracked PR but the
//     chosen one is paused with the operator's pause BEFORE the lift, each one
//     recorded; the drain is lifted on the owner's go; on a good first worker
//     round exactly the PRs it paused are resumed, on a bad one they stay
//     paused; a resumed run never pauses a PR twice
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "cutover.sh");
const V = "1.0.0";
const NOW = 1_800_000_000;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function vmJson(o: { layout?: string; draining: boolean; rounds: number }): string {
  return (
    `{"layout":"${o.layout ?? "legacy"}","runspec":{"version":1,"fingerprint":"fp123"},` +
    `"drain":{"draining":${o.draining},"running_rounds":${o.rounds}}}`
  );
}

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Rig {
  dir: string;
  log: string;
  env: Record<string, string>;
  setVm(o: { layout?: string; draining: boolean; rounds: number }): void;
  calls(): string[];
  run(answers: string[], extra?: Record<string, string>): { code: number; out: string };
}

function rig(opts: { lensPermits?: number } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "cutover-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const vmState = join(dir, "vm-state.json");
  writeFileSync(vmState, vmJson({ draining: false, rounds: 0 }));
  // The daemon's own status.json on the VM (what `status_field` greps) and the
  // count of `drain_hold_kept` lines in its log.
  const statusFile = join(dir, "status.json");
  writeFileSync(statusFile, "{}\n");
  const keptFile = join(dir, "hold-kept");
  writeFileSync(keptFile, "0\n");

  // origin: a bare repo whose path looks like quickchatai/quickreview.git, with the tag
  const bare = join(dir, "quickchatai", "quickreview.git");
  mkdirSync(dirname(bare), { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd,
      stdio: "pipe",
    });
  git(dir, "init", "-q", "--bare", bare);
  const co = join(dir, "co");
  git(dir, "clone", "-q", bare, co);
  writeFileSync(join(co, "f"), "x");
  git(co, "add", "f");
  git(co, "commit", "-q", "-m", "c");
  git(co, "tag", `v${V}`);
  git(co, "push", "-q", "origin", "HEAD:refs/heads/main", `v${V}`);

  const cfgHome = join(dir, "cfg");
  mkdirSync(join(cfgHome, "qcr", "default"), { recursive: true });
  writeFileSync(
    join(cfgHome, "qcr", "default", "config.toml"),
    `[daemon]\nlens_permits = ${opts.lensPermits ?? 20}\n`,
  );
  const expiry = join(dir, "expiry");
  writeFileSync(expiry, new Date((NOW + 90 * 86400) * 1000).toISOString() + "\n");

  stub(
    join(dir, "vm"),
    `echo "vm $1" >> "${log}"
case "$1" in
  *qcr-update*status*) cat "${vmState}" ;;
  *state/status.json*) c="\${1#sudo }"; bash -c "$(printf '%s' "$c" | sed "s#/opt/quickreview/state/status.json#${statusFile}#")" ;;
  *drain_hold_kept*) cat "${keptFile}" ;;
  *cli.js*status*)
    echo "quickreview — DRY-RUN — snapshot x"; cat "${dir}/qcr-status"
    if [ -s "${dir}/paused" ]; then
      echo
      while read -r n; do
        if [ -f "${dir}/session-pause" ]; then echo "#$n paused by a session, lapses 2026-10-21T12:00:00Z — x"
        else echo "#$n paused by the operator until resumed — cutover"; fi
      done < "${dir}/paused"
    fi ;;
  *docker*node*) echo 3 ;;
  *posting-receipts*) echo 1 ;;
esac`,
  );
  stub(
    join(dir, "qcr"),
    `echo "qcr $*" >> "${log}"
case "$1 $2" in
  "drain on")
    if [ -f "${dir}/stuck" ]; then exit 0; fi
    by=operator; [ -f "${dir}/session-drain" ] && by=session
    printf '{\n  "draining": true,\n  "draining_by": "%s"\n}\n' "$by" > "${statusFile}"
    echo '${vmJson({ draining: true, rounds: 0 })}' > "${vmState}" ;;
  "drain off")
    echo '{}' > "${statusFile}"
    echo '${vmJson({ layout: "release", draining: false, rounds: 0 })}' > "${vmState}" ;;
  "config check") [ -f "${dir}/badconfig" ] && { echo "retired key [engine] runtime"; exit 1; }; exit 0 ;;
esac
case "$1" in
  pause-pr) [ -f "${dir}/pause-fails" ] && exit 1; echo "$2" >> "${dir}/paused" ;;
  resume-pr) touch "${dir}/paused"; grep -vx "$2" "${dir}/paused" > "${dir}/paused.tmp"; mv "${dir}/paused.tmp" "${dir}/paused" ;;
esac
if [ "$1" = status ]; then cat "${dir}/qcr-status"; fi`,
  );
  writeFileSync(join(dir, "qcr-status"), "#12   reviewing         -      abcdef1234  a pr\n");
  stub(
    join(dir, "deploy"),
    `echo "deploy $* ACK=\${QCR_CUTOVER_ACK:-}" >> "${log}"
if [ "$1" = release ]; then
  if [ -f "${dir}/fail-release" ]; then echo "RESCUED: legacy bot back, drain re-sent"; exit 1; fi
  if [ -f "${dir}/fail-after-recreate" ]; then
    echo '${vmJson({ layout: "release", draining: true, rounds: 0 })}' > "${vmState}"
    echo "CHECK FAILED: memory sidecar search"; exit 1
  fi
  if [ -f "${dir}/boot-lifts" ]; then
    # a daemon that did not keep the drain: its first healthy reconcile lifted it
    echo '{}' > "${statusFile}"
    echo '${vmJson({ layout: "release", draining: false, rounds: 0 })}' > "${vmState}"
  else
    # the release's first boot carries the operator's drain over as the hold,
    # and its first healthy reconcile keeps it
    hold=true; [ -f "${dir}/no-hold" ] && hold=false
    printf '{\n  "draining": true,\n  "draining_by": "operator",\n  "draining_hold": %s\n}\n' "$hold" > "${statusFile}"
    [ -f "${dir}/no-kept" ] || echo 1 > "${keptFile}"
    echo '${vmJson({ layout: "release", draining: true, rounds: 0 })}' > "${vmState}"
  fi
fi
echo "deploy output $*"`,
  );
  writeFileSync(join(dir, "prs"), "12 abcdef1234567890\n");
  stub(join(dir, "dl"), `echo '{}' > "$2/deploy-manifest-$1.json"`);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    XDG_CONFIG_HOME: cfgHome,
    XDG_STATE_HOME: join(dir, "state"),
    CUTOVER_VM_CMD: `${join(dir, "vm")} "$1"`,
    CUTOVER_QCR: join(dir, "qcr"),
    CUTOVER_DEPLOY: join(dir, "deploy"),
    CUTOVER_GIT_DIR: co,
    CUTOVER_PRS_CMD: `cat ${join(dir, "prs")}`,
    QC_RELEASE_DOWNLOAD_CMD: `${join(dir, "dl")} "$1" "$2"`,
    QCR_GHCR_EXPIRY_FILE: expiry,
    QC_NOW_EPOCH: String(NOW),
    QC_VM_HOST: "vm.test",
    CUTOVER_POLL_S: "0",
    CUTOVER_MAX_POLLS: "2",
  };
  return {
    dir,
    log,
    env,
    setVm: (o) => writeFileSync(vmState, vmJson(o)),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    run(answers, extra = {}) {
      const r = spawnSync("bash", [script, V], {
        env: { ...env, ...extra },
        input: answers.join("\n") + "\n",
        encoding: "utf8",
        timeout: 60_000,
      });
      return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
    },
  };
}

const HAPPY_TO_LIFT = [
  "", // banner
  "y", // the plan matches
  V, // typed go
  "y", // verify shows it
  "y", // surfaces
  "12", // the first PR
  "y", // lift
  "y", // round checked and good
  "y", // idle PR
];

describe("scripts/cutover.sh", () => {
  it("passes bash -n and never spells a force flag", () => {
    execFileSync("bash", ["-n", script]);
    expect(readFileSync(script, "utf8")).not.toMatch(/--force|\bforce=|\s-f\s+release/);
  });

  it("runs the window in order, holds the drain, lifts only on the go, and resumes past finished stages", () => {
    const r = rig();
    r.setVm({ draining: false, rounds: 0 });
    const first = r.run(HAPPY_TO_LIFT);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("Come back then");
    const c = r.calls();
    const seq = c.filter((l) => /^(qcr drain|deploy )/.test(l));
    expect(seq).toEqual([
      "qcr drain on",
      `deploy --dry-run release ${V} ACK=${V}`,
      `deploy release ${V} ACK=${V}`,
      "deploy verify ACK=",
      // no re-drain: the release's boot kept the operator's drain as the hold
      "qcr drain off", // the owner's go
    ]);
    expect(first.out).toContain("the first reconcile was healthy and kept the hold");
    // the counts were taken and recorded
    expect(
      readFileSync(join(r.dir, "state", "qcr", "default", `cutover-${V}.state`), "utf8"),
    ).toMatch(/kv:pending_wakes=3\nkv:outbox=1/);

    // 5 hours later: only the 4 h check is left, and nothing deploys again
    const before = r.calls().length;
    const second = r.run(["", "y"], { QC_NOW_EPOCH: String(NOW + 5 * 3600) });
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("already done, skipped");
    expect(second.out).toContain("Setup complete");
    const newCalls = r.calls().slice(before);
    expect(newCalls.filter((l) => /^deploy|^qcr drain/.test(l))).toEqual([]);
  });

  it("blocks on an undrained board before anything is deployed", () => {
    const r = rig();
    writeFileSync(join(r.dir, "stuck"), "");
    r.setVm({ draining: false, rounds: 2 });
    const res = r.run(["", "y"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("not drained");
    expect(r.calls().some((l) => l.startsWith("deploy"))).toBe(false);
  });

  it("re-checks the drain before the release on a resumed run, even with the drain stage done", () => {
    const r = rig();
    const first = r.run(["", "n"]); // stops at the plan check
    expect(first.code).toBe(1);
    r.setVm({ draining: true, rounds: 4 }); // rounds started meanwhile
    const res = r.run(["", "y", V]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("rounds are still running");
    expect(r.calls().some((l) => l === `deploy release ${V} ACK=${V}`)).toBe(false);
  });

  it("says a failure AFTER the recreate was not rescued (the VM's layout is release by then)", () => {
    const r = rig();
    writeFileSync(join(r.dir, "fail-after-recreate"), "");
    const res = r.run(["", "y", V]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("the release failed");
    expect(res.out).toContain("came AFTER the point of no return");
    expect(res.out).toContain("fix forward under the drain");
    expect(res.out).not.toContain("was RESCUED by the updater");
  });

  it("stops at a failed release with its output, and resumes at the release", () => {
    const r = rig();
    writeFileSync(join(r.dir, "fail-release"), "");
    const first = r.run(["", "y", V]);
    expect(first.code).toBe(1);
    expect(first.out).toContain("RESCUED: legacy bot back, drain re-sent");
    expect(first.out).toContain("the release failed");
    rmSync(join(r.dir, "fail-release"));
    r.setVm({ draining: true, rounds: 0 }); // the rescue re-sent the drain
    const before = r.calls().length;
    const second = r.run(["", V, "y", "y", "12", "n"]); // go, verify, surfaces, the first PR, then no lift
    const after = r
      .calls()
      .slice(before)
      .filter((l) => /^(deploy|qcr drain)/.test(l));
    expect(after).toEqual([`deploy release ${V} ACK=${V}`, "deploy verify ACK="]);
    expect(second.out).toContain("already done, skipped");
    expect(second.code).toBe(1);
    expect(second.out).toContain("The drain stays on");
    expect(r.calls().some((l) => l === "qcr drain off")).toBe(false);
  });

  it("stops LOUDLY when the drain is off after the new daemon's boot, and never re-drains on its own", () => {
    const r = rig();
    writeFileSync(join(r.dir, "boot-lifts"), "");
    const res = r.run(["", "y", V, "y"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("THE DRAIN IS OFF");
    expect(res.out).toContain("qcr drain on --hold");
    const drains = r.calls().filter((l) => l.startsWith("qcr drain"));
    expect(drains).toEqual(["qcr drain on"]); // stage 2's only; nothing after the release
    expect(
      readFileSync(join(r.dir, "state", "qcr", "default", `cutover-${V}.state`), "utf8"),
    ).not.toContain("done:reconcile");
  });

  it("stops when the drain stands but is not a hold (the boot would lift it)", () => {
    const r = rig();
    writeFileSync(join(r.dir, "no-hold"), "");
    const res = r.run(["", "y", V, "y"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("NOT a hold");
    expect(r.calls().filter((l) => l.startsWith("qcr drain"))).toEqual(["qcr drain on"]);
  });

  it("asks before going on when the hold stands but no healthy first reconcile was logged", () => {
    const r = rig();
    writeFileSync(join(r.dir, "no-kept"), "");
    const declined = r.run(["", "y", V, "y", "n"]);
    expect(declined.code).toBe(1);
    expect(declined.out).toContain("no healthy first reconcile was logged");
    const went = r.run(["", "y", "y", "12", "n"]); // healthy enough; surfaces; PR; no lift
    expect(went.out).toContain("the drain is held");
    expect(went.out).toContain("The drain stays on");
    expect(r.calls().some((l) => l === "qcr drain off")).toBe(false);
  });

  it("refuses to release over a drain that is not the operator's", () => {
    const r = rig();
    writeFileSync(join(r.dir, "session-drain"), "");
    const res = r.run(["", "y"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("the drain is not the operator's (draining_by=session)");
    expect(r.calls().some((l) => l.startsWith("deploy"))).toBe(false);
  });

  it("runs nothing without the explicit go", () => {
    const r = rig();
    const noPlanGo = r.run(["", "n"]);
    expect(noPlanGo.code).toBe(1);
    const wrongType = r.run(["", "y", "yes"]);
    expect(wrongType.code).toBe(1);
    expect(wrongType.out).toContain("No go given");
    const eof = r.run([]);
    expect(eof.code).toBe(1);
    expect(r.calls().some((l) => l === `deploy release ${V} ACK=${V}`)).toBe(false);
  });

  it("never lifts the drain without the owner's go", () => {
    const r = rig();
    const res = r.run(["", "y", V, "y", "y", "12", "n"]); // the first PR chosen, the lift declined
    expect(res.code).toBe(1);
    expect(res.out).toContain("The drain stays on");
    expect(r.calls().some((l) => l === "qcr drain off")).toBe(false);
  });

  it("refuses on a failed precondition: layout, lens_permits, retired keys, an expired login", () => {
    const layout = rig();
    layout.setVm({ layout: "release", draining: false, rounds: 0 });
    expect(layout.run([""]).out).toContain("not legacy");

    const permits = rig({ lensPermits: 8 });
    expect(permits.run([""]).out).toContain("lens_permits = 20");

    const retired = rig();
    writeFileSync(join(retired.dir, "badconfig"), "");
    const rr = retired.run([""]);
    expect(rr.out).toContain("retired key");
    expect(rr.code).toBe(1);

    const expired = rig();
    writeFileSync(
      expired.env.QCR_GHCR_EXPIRY_FILE!,
      new Date((NOW - 86400) * 1000).toISOString() + "\n",
    );
    expect(expired.run([""]).out).toContain("expired");
    for (const r of [layout, permits, retired, expired]) {
      expect(r.calls().some((l) => l.startsWith("deploy") || l === "qcr drain on")).toBe(false);
    }
  });

  it("waits for the reconcile backstop when a tracked PR's head lags", () => {
    const r = rig();
    writeFileSync(join(r.dir, "prs"), "12 ffffffffff0000\n");
    writeFileSync(join(r.dir, "qcr-status"), "#12   awaiting_author  -      abcdef1234  a pr\n");
    const res = r.run(["", "y", V, "y"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("has not caught up for: #12");
    expect(existsSync(join(r.dir, "state"))).toBe(true);
  });

  it("reads the backstop's daemon status in the daemon's container, never from the owner's machine", () => {
    const r = rig();
    const res = r.run(["", "y", V, "y"]);
    expect(res.code).toBe(1);
    const vmCalls = r.calls().filter((l) => l.startsWith("vm "));
    expect(
      vmCalls.some((l) =>
        l.includes("docker exec quickreview-sandbox node /opt/qcr/dist/src/cli.js status"),
      ),
    ).toBe(true);
    // the owner's own `qcr status` is not what the backstop compares against
    expect(r.calls()).not.toContain("qcr status");
  });

  describe("stage 9: pause all but one, lift, the first worker round, resume", () => {
    /** Up to and through stage 8: the banner, the plan, the typed go, verify, the surfaces. */
    const TO_STAGE_9 = ["", "y", V, "y", "y"];

    /** A board of five PRs: #12 awaiting the author, #13 tracked, #14 queued, #15 closed and
     * #16 already paused by the operator before the cutover. */
    function board(): Rig {
      const r = rig();
      writeFileSync(
        join(r.dir, "qcr-status"),
        [
          "#12    awaiting_author   -      abcdef1234  a pr",
          "#13    tracked           -      1111111111  b pr",
          "#14    queued            -      2222222222  c pr",
          "#15    closed            -      3333333333  d pr",
          "#16    awaiting_author   -      4444444444  e pr",
          "",
        ].join("\n"),
      );
      writeFileSync(join(r.dir, "paused"), "16\n");
      return r;
    }
    const levers = (r: Rig) => r.calls().filter((l) => /^qcr (pause-pr|resume-pr|drain)/.test(l));
    const stateOf = (r: Rig) =>
      readFileSync(join(r.dir, "state", "qcr", "default", `cutover-${V}.state`), "utf8");
    const pausedNow = (r: Rig) =>
      readFileSync(join(r.dir, "paused"), "utf8").split("\n").filter(Boolean);

    it("pauses every tracked PR but the chosen, records them, lifts, and on a good round resumes only those", () => {
      const r = board();
      const res = r.run([...TO_STAGE_9, "13", "y", "y", "y"]); // #13 first, lift, round good, idle PR
      expect(res.code, res.out).toBe(0);
      expect(levers(r).map((l) => l.replace(/ --reason .*/, " --reason …"))).toEqual([
        "qcr drain on",
        "qcr pause-pr 12 --reason …", // the closed #15, the operator's own #16 and the chosen #13 are not touched
        "qcr pause-pr 14 --reason …",
        "qcr drain off", // only after the pauses
        "qcr resume-pr 12",
        "qcr resume-pr 14",
      ]);
      expect(r.calls().find((l) => l.startsWith("qcr pause-pr 12"))).toContain(
        "first worker round runs on #13",
      );
      const st = stateOf(r);
      expect(st).toMatch(/^kv:first_pr=13$/m);
      expect(st).toMatch(/^paused:12$/m);
      expect(st).toMatch(/^paused:14$/m);
      expect(st).not.toMatch(/^paused:1[356]$/m);
      expect(st).toMatch(/^resumed:12$/m);
      expect(st).toMatch(/^resumed:14$/m);
      expect(st).toMatch(/^done:first_round$/m);
      expect(pausedNow(r)).toEqual(["16"]); // the operator's own pause stands
      expect(res.out).toContain('re-add the label "AI review requested"');
      expect(res.out).toContain("only #13 can start a round");
    });

    it("says a queued first PR starts at the lift with nothing to trigger", () => {
      const r = board();
      const res = r.run([...TO_STAGE_9, "14", "y", "y", "y"]);
      expect(res.code, res.out).toBe(0);
      expect(res.out).toContain("#14 has a pending trigger (queued): its round starts at the lift");
      expect(
        levers(r)
          .filter((l) => l.startsWith("qcr pause-pr"))
          .map((l) => l.split(" ")[2]),
      ).toEqual(["12", "13"]);
    });

    it("leaves the PRs paused when the round is not good, and a resume asks again without pausing or lifting twice", () => {
      const r = board();
      const bad = r.run([...TO_STAGE_9, "13", "y", "n"]); // lift, then the round is NOT good
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("The other PRs STAY PAUSED");
      expect(levers(r).filter((l) => /resume-pr/.test(l))).toEqual([]);
      expect(pausedNow(r).sort()).toEqual(["12", "14", "16"]);
      expect(stateOf(r)).not.toMatch(/^done:first_round$/m);

      const before = r.calls().length;
      const good = r.run(["", "y", "y"]); // banner, the round is good now, idle PR
      expect(good.code, good.out).toBe(0);
      expect(good.out).toContain("the first PR is #13 (chosen on an earlier run");
      expect(
        r
          .calls()
          .slice(before)
          .filter((l) => /^qcr (pause-pr|resume-pr|drain)/.test(l)),
      ).toEqual(["qcr resume-pr 12", "qcr resume-pr 14"]);
      expect(pausedNow(r)).toEqual(["16"]);
    });

    it("a resume before the lift does not pause a PR twice", () => {
      const r = board();
      const declined = r.run([...TO_STAGE_9, "13", "n"]); // the lift declined
      expect(declined.code).toBe(1);
      expect(declined.out).toContain("The drain stays on; the pauses stay recorded");
      expect(levers(r).filter((l) => l.startsWith("qcr pause-pr"))).toHaveLength(2);
      expect(r.calls()).not.toContain("qcr drain off");

      const before = r.calls().length;
      const res = r.run(["", "y", "y", "y"]); // banner, lift, round good, idle PR
      expect(res.code, res.out).toBe(0);
      expect(
        r
          .calls()
          .slice(before)
          .filter((l) => /^qcr (pause-pr|resume-pr|drain)/.test(l)),
      ).toEqual(["qcr drain off", "qcr resume-pr 12", "qcr resume-pr 14"]);
      expect(res.out).toContain("#12 already paused by this stage");
    });

    it("pauses nothing and keeps the drain when no PR is chosen", () => {
      const r = board();
      const res = r.run([...TO_STAGE_9, ""]);
      expect(res.code).toBe(1);
      expect(res.out).toContain("No PR chosen. Nothing was paused and the drain still holds.");
      expect(levers(r)).toEqual(["qcr drain on"]);
    });

    it("never lifts while a pause is not the operator's (a bounded one would lapse)", () => {
      const r = board();
      writeFileSync(join(r.dir, "session-pause"), "");
      const res = r.run([...TO_STAGE_9, "13", "y"]);
      expect(res.code).toBe(1);
      expect(res.out).toContain("does not show as paused by the operator");
      expect(r.calls()).not.toContain("qcr drain off");
    });

    it("stops with the drain held when a pause fails", () => {
      const r = board();
      writeFileSync(join(r.dir, "pause-fails"), "");
      const res = r.run([...TO_STAGE_9, "13", "y"]);
      expect(res.code).toBe(1);
      expect(res.out).toContain("`qcr pause-pr 12` failed: the drain still holds");
      expect(r.calls()).not.toContain("qcr drain off");
      expect(stateOf(r)).not.toMatch(/^paused:/m);
    });
  });
});
