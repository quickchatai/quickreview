// The always-on bot under the tool uid split, in a real container: the
// repo's own entrypoint in daemon mode and the built tooluid.js in a stock node
// image, started the way deploy/qcr-update.sh starts the bot — its own uid
// (1001), the setid helper's gate group, and no capability in the bounding set
// but the run spec's. The helper is made as docker/Dockerfile makes it (python's
// setxattr stands in for setcap, which the stock image lacks). The model's bash
// is an attacker's: it tries the secrets mount, a symlink a PR committed to it,
// pi's login, the daemon's /proc, and minting a token, and does the round's own
// writes. No network, no model.
//
// Skipped where docker, the node image or the built tree is absent.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(root, "dist", "src");
const HARNESS = join(root, "tests", "helpers", "daemon-uid-harness.mjs");
const NODE_IMAGE = "node:22-bookworm";
const tmp = mkdtempSync(join(tmpdir(), "tool-uid-daemon-"));

const hasDist = existsSync(join(DIST, "engine", "tooluid.js"));
const hasDocker =
  spawnSync("docker", ["image", "inspect", NODE_IMAGE], { stdio: "ignore" }).status === 0;
const docker = (args: string[], timeout = 120_000): ReturnType<typeof spawnSync> =>
  spawnSync("docker", args, { encoding: "utf8", timeout });
const nodeModules = (): string =>
  execFileSync("readlink", ["-f", join(root, "node_modules")], { encoding: "utf8" }).trim();

afterAll(() => {
  // the container's uids own some of what it made
  docker([
    "run",
    "--rm",
    "--mount",
    `type=bind,src=${tmp},dst=/d`,
    NODE_IMAGE,
    "sh",
    "-c",
    "rm -rf /d/* /d/.[!.]* 2>/dev/null; true",
  ]);
  rmSync(tmp, { recursive: true, force: true });
});

/** As root: the image's helper and the VM's layout, then the bot's start. */
const SETUP = `set -euo pipefail
install -d -m 0755 /usr/local/libexec/qcr
install -o root -g 4748 -m 0750 "$(command -v setpriv)" /usr/local/libexec/qcr/setpriv
python3 -c 'import os, struct; os.setxattr("/usr/local/libexec/qcr/setpriv", "security.capability", struct.pack("<IIIII", 0x02000001, 0xc0, 0, 0, 0))'
mkdir -p /opt/quickreview/secrets
printf 'APP-KEY-MATERIAL' >/opt/quickreview/secrets/app.pem
printf '1' >/opt/quickreview/secrets/app_id
chown -R 1001:1001 /opt/quickreview/secrets
chmod 0700 /opt/quickreview/secrets
chmod 0400 /opt/quickreview/secrets/*
mkdir -p /home/qcr/.pi/agent
printf '{"refresh":"LOGIN-REFRESH-TOKEN"}' >/home/qcr/.pi/agent/auth.json
chown -R 1001:1001 /home/qcr
chmod 0700 /home/qcr/.pi
for d in state verdict commands wt pihome; do install -d -o 1001 -g 1001 -m 0755 /opt/qcr/$d; done
git init -q /opt/qcr/wt/pr-1
git -C /opt/qcr/wt/pr-1 -c user.email=a@b -c user.name=a commit -q --allow-empty -m base
ln -s /opt/quickreview/secrets/app.pem /opt/qcr/wt/pr-1/innocent.md
chown -R 1001:1001 /opt/qcr/wt
exec setpriv --reuid=1001 --regid=1001 --groups=4748 --inh-caps=-all \\
  --bounding-set=-all,+setuid,+setgid,+chown,+dac_override,+fowner \\
  -- /opt/qcr/docker/entrypoint.sh daemon
`;

function runBot(): { status: number | null; stderr: string; out: string } {
  const dir = mkdtempSync(join(tmp, "bot-"));
  chmodSync(dir, 0o755);
  const app = join(dir, "app");
  const out = join(dir, "out");
  const cfg = parseConfig(readFileSync(join(root, "config.example.toml"), "utf8"));
  const put = (rel: string, text: string, mode = 0o644): void => {
    mkdirSync(dirname(join(app, rel)), { recursive: true });
    writeFileSync(join(app, rel), text, { mode });
  };
  for (const f of [
    "docker/entrypoint.sh",
    "scripts/install-locator.sh",
    "scripts/mint-token.sh",
    "config.example.toml",
    "docker/vm/tmux.conf",
  ])
    put(f, readFileSync(join(root, f), "utf8"));
  chmodSync(join(app, "docker/entrypoint.sh"), 0o755);
  put(
    join("node_modules", cfg.pi.package, "package.json"),
    JSON.stringify({ version: cfg.pi.version }),
  );
  put("package.json", JSON.stringify({ type: "module", version: "1.0.0" }));
  put("dist/src/wire.js", `await import(${JSON.stringify(HARNESS)});\n`);
  // no tmux in the stock image: the daemon's tmux server is not what is tested
  put("bin/tmux", '#!/bin/sh\n[ "$1" = has-session ] && exit 1\nexit 0\n', 0o755);
  copyFileSync(join(root, "deploy/reviewer/AGENTS.override.md"), join(dir, "stub.md"));
  mkdirSync(out, { mode: 0o777 });
  chmodSync(out, 0o777);
  const r = docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      ...["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "SETFCAP"].flatMap((c) => [
        "--cap-add",
        c,
      ]),
      "-e",
      "HOME=/home/qcr",
      "-e",
      "PATH=/opt/qcr/bin:/usr/local/bin:/usr/bin:/bin",
      "-e",
      "QCR_APP_ROOT=/opt/qcr",
      "-e",
      "QCR_CONFIG=/opt/qcr/config.example.toml",
      "-e",
      `HARNESS_DIST=${DIST}`,
      "-e",
      "HARNESS_OUT=/out",
      "--tmpfs",
      "/tmp:mode=1777",
      "--mount",
      `type=bind,src=${app},dst=/opt/qcr`,
      "--mount",
      `type=bind,src=${root},dst=${root},readonly`,
      "--mount",
      `type=bind,src=${nodeModules()},dst=${nodeModules()},readonly`,
      "--mount",
      `type=bind,src=${out},dst=/out`,
      "--entrypoint",
      "bash",
      NODE_IMAGE,
      "-c",
      SETUP,
    ],
    170_000,
  );
  return { status: r.status, stderr: String(r.stderr), out };
}

describe.skipIf(!hasDocker || !hasDist)(
  "the bot's model tools run as the tool uid (docker, no network)",
  () => {
    it("cannot read the secrets, the login or the daemon; can do the round's writes and reach the socket", () => {
      const r = runBot();
      expect(r.status, r.stderr).toBe(0);
      const read = (f: string): string => readFileSync(join(r.out, f), "utf8");
      expect(existsSync(join(r.out, "done")), r.stderr).toBe(true);

      // the daemon: its own uid and the gate group, the tool uid named, its umask kept
      const daemon = JSON.parse(read("daemon.json")) as Record<string, unknown>;
      expect(daemon).toMatchObject({
        uid: 1001,
        gid: 1001,
        toolUid: "65534",
        toolGid: "1001",
        setprivBin: "/usr/local/libexec/qcr/setpriv",
        umask: 0o022,
      });
      expect(daemon["groups"]).toContain(4748);
      // the directories the model's scripts write are open to the group; the
      // worktrees are not
      expect(daemon["modes"]).toEqual({
        "/opt/qcr/state": "775",
        "/opt/qcr/verdict": "775",
        "/opt/qcr/commands": "775",
        "/opt/qcr/wt": "755",
      });
      // and it reads its own secrets
      expect(read("daemon-reads.txt")).toBe("APP-KEY-MATERIAL");

      const bash = JSON.parse(read("bash.json")) as Record<string, { code: number; text: string }>;
      expect(bash["id"]!.text).toMatch(/^uid=65534\(nobody\) gid=1001 groups=1001\s*$/);
      for (const label of ["secret", "secretsLs", "planted", "login", "environ", "mem"]) {
        expect(bash[label]!.code, label).not.toBe(0);
        expect(bash[label]!.text, label).toMatch(/Permission denied/);
      }
      const all = JSON.stringify(bash);
      expect(all).not.toContain("APP-KEY-MATERIAL");
      expect(all).not.toContain("LOGIN-REFRESH-TOKEN");
      // it cannot mint, and the helper is not its to run
      expect(bash["mint"]!.code).not.toBe(0);
      expect(bash["mint"]!.text).toContain("unreadable app id");
      expect(bash["helperBack"]!.code).not.toBe(0);
      expect(bash["helperBack"]!.text).toMatch(/Permission denied/);
      // the round's own work: git in the run uid's worktree, a verdict published
      // by rename (group-writable, the daemon can take it over), a state file, the
      // daemon's socket — and no write into the worktree
      expect(bash["git"]!.text).toContain("base");
      expect(bash["git"]!.text).toContain("git-ok");
      expect(bash["verdict"]!.text.trim()).toBe("664 65534");
      expect(bash["state"]!.text.trim()).toBe("state-ok");
      expect(bash["socket"]!.text.trim()).toBe("connected");
      expect(bash["worktreeWrite"]!.code).not.toBe(0);
    });
  },
);
