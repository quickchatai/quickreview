// The container-layout resolver: every TUI remote path is built from the app
// root inside the daemon container, and the container says which layout it is.
// A fake docker answers `docker inspect` from a mutable container (id + label),
// so a cutover recreate mid-connection is a state change the test makes.
import { beforeEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import { CommandDrainSender } from "../src/tui/deploy-drain.js";
import { digestListArgv } from "../src/tui/digesttab.js";
import {
  LEGACY_LAYOUT_ROOT,
  RELEASE_LAYOUT_ROOT,
  layoutProbeArgv,
  parseLayoutProbe,
  remoteSandboxRoot,
  resetLayoutCache,
  resolveLayout,
} from "../src/tui/layout.js";
import { InjectSender } from "../src/tui/msg.js";
import { Poller } from "../src/tui/poll.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { operatorCommandDirFor } from "../src/tui/unwedge.js";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });

interface FakeContainer {
  id: string;
  label: string;
}

/** A VM with one container; every argv is recorded. Probes answer from the
 * container; a write to a command directory is acknowledged and its result is
 * `drain on, no rounds`. */
function fakeVm(container: FakeContainer | undefined) {
  const state = { container, calls: [] as string[], probeFails: false };
  const ssh: SshRunner = async (_host, argv) => {
    const line = argv.join(" ");
    state.calls.push(line);
    if (argv.includes("inspect")) {
      if (state.probeFails || !state.container)
        return { ok: false, stdout: "", stderr: "Error: No such object", code: 1 };
      return ok(`${state.container.id} ${state.container.label}\n`);
    }
    if (line.includes("/results/") && line.includes("cat")) {
      return ok('{"ok":true,"draining":true,"running_rounds":0}');
    }
    if (line.includes("/inject/") && line.includes(".done")) return ok("consumed\n");
    return ok("");
  };
  return { state, ssh };
}

const lastWriteTo = (calls: string[], needle: string): string | undefined =>
  [...calls].reverse().find((c) => c.includes(needle));

beforeEach(() => resetLayoutCache());

describe("the layout probe", () => {
  it("is a read-only docker inspect of the configured container, through sudo when the VM needs it", () => {
    const argv = layoutProbeArgv(TUI_DEFAULTS);
    expect(argv.slice(0, 3)).toEqual(["sudo", "docker", "inspect"]);
    expect(argv.at(-1)).toBe("quickreview-sandbox");
    expect(argv.join(" ")).toContain('index .Config.Labels "qcr.layout"');
    expect(layoutProbeArgv({ ...TUI_DEFAULTS, sudo_docker: false })[0]).toBe("docker");
  });

  it("reads the id and the label; an absent label is the legacy layout; only 'release' is release", () => {
    expect(parseLayoutProbe(`${ID_A} release\n`)).toEqual({ id: ID_A, layout: "release" });
    expect(parseLayoutProbe(`${ID_A} \n`)).toEqual({ id: ID_A, layout: "legacy" });
    expect(parseLayoutProbe(`${ID_A}\n`)).toEqual({ id: ID_A, layout: "legacy" });
    expect(parseLayoutProbe(`${ID_A} something-else\n`)).toEqual({ id: ID_A, layout: "legacy" });
    for (const junk of ["", "Error: No such object", "release", "zz release", "<no value>"])
      expect(parseLayoutProbe(junk), junk).toBeUndefined();
  });
});

describe("the resolver", () => {
  it("a legacy-labelled (unlabelled) container gets the legacy root for drain and msg writes", async () => {
    const vm = fakeVm({ id: ID_A, label: "" });
    await new CommandDrainSender(TUI_DEFAULTS, vm.ssh, undefined, async () => undefined).set(true);
    const drainWrite = lastWriteTo(vm.state.calls, "mkdir -p")!;
    expect(drainWrite).toContain(`${LEGACY_LAYOUT_ROOT}/commands/operator'`);
    expect(drainWrite).not.toContain(RELEASE_LAYOUT_ROOT + "/");

    await new InjectSender(TUI_DEFAULTS, vm.ssh, undefined, async () => undefined).send(
      "pr-7",
      "hello",
      () => undefined,
    );
    expect(lastWriteTo(vm.state.calls, "cat > ")).toContain(`${LEGACY_LAYOUT_ROOT}/inject/pr-7/`);
  });

  it("a release-labelled container gets /opt/qcr for the same writes", async () => {
    const vm = fakeVm({ id: ID_A, label: "release" });
    await new CommandDrainSender(TUI_DEFAULTS, vm.ssh, undefined, async () => undefined).set(true);
    expect(lastWriteTo(vm.state.calls, "mkdir -p")).toContain(
      `${RELEASE_LAYOUT_ROOT}/commands/operator'`,
    );
    await new InjectSender(TUI_DEFAULTS, vm.ssh, undefined, async () => undefined).send(
      "pr-7",
      "hello",
      () => undefined,
    );
    expect(lastWriteTo(vm.state.calls, "cat > ")).toContain(`${RELEASE_LAYOUT_ROOT}/inject/pr-7/`);
    expect(digestListArgv(TUI_DEFAULTS).at(-1)).toContain(`${RELEASE_LAYOUT_ROOT}/digest`);
    expect(operatorCommandDirFor(TUI_DEFAULTS)).toBe(`${RELEASE_LAYOUT_ROOT}/commands/operator`);
  });

  it("a container id change mid-connection (legacy to release) re-resolves the root: the drain reaches the legacy container right up to the recreate", async () => {
    const vm = fakeVm({ id: ID_A, label: "" });
    const drain = new CommandDrainSender(TUI_DEFAULTS, vm.ssh, undefined, async () => undefined);
    await drain.set(true);
    expect(lastWriteTo(vm.state.calls, "mkdir -p")).toContain(LEGACY_LAYOUT_ROOT);

    // the cutover recreates quickreview-sandbox from the release image
    vm.state.container = { id: ID_B, label: "release" };
    await drain.set(true);
    const after = lastWriteTo(vm.state.calls, "mkdir -p")!;
    expect(after).toContain(`${RELEASE_LAYOUT_ROOT}/commands/operator'`);
    expect(after).not.toContain(LEGACY_LAYOUT_ROOT);
    expect(remoteSandboxRoot(TUI_DEFAULTS)).toBe(RELEASE_LAYOUT_ROOT);
  });

  it("the poll loop keeps the root current without any sender running", async () => {
    const vm = fakeVm({ id: ID_A, label: "" });
    const poller = new Poller(TUI_DEFAULTS, vm.ssh, () => undefined);
    await poller.tick();
    expect(remoteSandboxRoot(TUI_DEFAULTS)).toBe(LEGACY_LAYOUT_ROOT);
    vm.state.container = { id: ID_B, label: "release" };
    await poller.tick();
    expect(remoteSandboxRoot(TUI_DEFAULTS)).toBe(RELEASE_LAYOUT_ROOT);
  });

  it("an explicit [tui] remote_sandbox_root wins and is never probed", async () => {
    const vm = fakeVm({ id: ID_A, label: "release" });
    const cfg: TuiConfig = { ...TUI_DEFAULTS, remote_sandbox_root: "/srv/custom" };
    expect(await resolveLayout(cfg, vm.ssh)).toBe("/srv/custom");
    await new CommandDrainSender(cfg, vm.ssh, undefined, async () => undefined).set(true);
    expect(lastWriteTo(vm.state.calls, "mkdir -p")).toContain("/srv/custom/commands/operator'");
    expect(vm.state.calls.some((c) => c.includes("inspect"))).toBe(false);
    expect(remoteSandboxRoot(cfg)).toBe("/srv/custom");
  });

  it("the probe reads the label once per container: the same id is not re-derived", async () => {
    const vm = fakeVm({ id: ID_A, label: "release" });
    await resolveLayout(TUI_DEFAULTS, vm.ssh);
    // same id, label edited under it (impossible in docker): the held answer stands
    vm.state.container = { id: ID_A, label: "" };
    expect(await resolveLayout(TUI_DEFAULTS, vm.ssh)).toBe(RELEASE_LAYOUT_ROOT);
  });

  it("a probe that fails never forgets an answer, and before any answer the root is the legacy one", async () => {
    const vm = fakeVm({ id: ID_A, label: "release" });
    vm.state.probeFails = true;
    expect(await resolveLayout(TUI_DEFAULTS, vm.ssh)).toBe(LEGACY_LAYOUT_ROOT);
    vm.state.probeFails = false;
    expect(await resolveLayout(TUI_DEFAULTS, vm.ssh)).toBe(RELEASE_LAYOUT_ROOT);
    vm.state.probeFails = true;
    expect(await resolveLayout(TUI_DEFAULTS, vm.ssh)).toBe(RELEASE_LAYOUT_ROOT);
    // a runner that throws is a probe that did not answer
    expect(
      await resolveLayout(TUI_DEFAULTS, async () => {
        throw new Error("boom");
      }),
    ).toBe(RELEASE_LAYOUT_ROOT);
  });

  it("answers are per connection: another host or container does not inherit them", async () => {
    const a = fakeVm({ id: ID_A, label: "release" });
    await resolveLayout(TUI_DEFAULTS, a.ssh);
    const other: TuiConfig = { ...TUI_DEFAULTS, ssh_host: "other-vm" };
    expect(remoteSandboxRoot(other)).toBe(LEGACY_LAYOUT_ROOT);
    const third: TuiConfig = { ...TUI_DEFAULTS, container: "other-container" };
    expect(remoteSandboxRoot(third)).toBe(LEGACY_LAYOUT_ROOT);
  });

  it("the shipped default is auto, and a copy of the config shares the answer", async () => {
    expect(TUI_DEFAULTS.remote_sandbox_root).toBe("");
    const vm = fakeVm({ id: ID_A, label: "release" });
    await resolveLayout(TUI_DEFAULTS, vm.ssh);
    expect(remoteSandboxRoot({ ...TUI_DEFAULTS })).toBe(RELEASE_LAYOUT_ROOT);
  });
});
