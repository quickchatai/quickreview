// The rubric-proposal verbs on the learning store: a rejection is put on
// record before its proposal is removed, never the other way round, and a
// proposal being accepted cannot be rejected under the accept.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryOp } from "../src/memory/store.js";
import { stripAnsi } from "../src/tui/paint.js";
import { FakeMemory, learningRig, settle } from "./helpers/tui-rig.js";

const SLUG = "baseline-mergebase-2026-08-20";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "qcr-proposals-"));
  roots.push(root);
  mkdirSync(join(root, "state", "rubric", SLUG), { recursive: true });
  writeFileSync(join(root, "state", "rubric", SLUG, "PROPOSAL.md"), "## Rationale\n");
  return root;
}

class RefusingMemory extends FakeMemory {
  override apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
    this.applied.push(op);
    return Promise.resolve({ ok: false, message: "memory write failed: transport" });
  }
}

describe("LearningStore.reject", () => {
  it("records the rejection, then removes the proposal", async () => {
    const root = checkout();
    const rig = learningRig({ repoRoot: root });
    const res = await rig.learning.store.reject(SLUG, "duplicates the merge-base lesson");
    expect(res.ok).toBe(true);
    expect(rig.mem.applied).toEqual([
      { op: "add", text: `#rejected-proposal ${SLUG} — duplicates the merge-base lesson` },
    ]);
    expect(existsSync(join(root, "state", "rubric", SLUG))).toBe(false);
  });

  it("a refused record leaves the proposal in place, to be rejected again", async () => {
    const root = checkout();
    const rig = learningRig({ repoRoot: root, mem: new RefusingMemory() });
    const res = await rig.learning.store.reject(SLUG, "no");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("the proposal stays");
    expect(existsSync(join(root, "state", "rubric", SLUG, "PROPOSAL.md"))).toBe(true);
  });

  it("refuses to reject the proposal an accept is committing", async () => {
    const root = checkout();
    let finish!: (r: { ok: boolean; message: string }) => void;
    const rig = learningRig({
      repoRoot: root,
      accept: () => new Promise((res) => (finish = res)),
    });
    const accepting = rig.learning.store.accept(SLUG);
    const res = await rig.learning.store.reject(SLUG, "no");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("is being accepted");
    expect(rig.mem.applied).toEqual([]);
    expect(existsSync(join(root, "state", "rubric", SLUG))).toBe(true);
    finish({ ok: true, message: "accepted" });
    await accepting;
    expect((await rig.learning.store.reject(SLUG, "changed my mind")).ok).toBe(true);
  });
});

describe("the feedback tab's PROPOSED pane", () => {
  it("a rubric directory that cannot be listed reads as unread, never as no proposals", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-proposals-"));
    roots.push(root);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "rubric"), "not a directory");
    const rig = learningRig({ repoRoot: root, fetchProposals: undefined });
    rig.app.tab = "feedback";
    const tab = rig.app.hooks.tabs.feedback!;
    tab.screen(rig.app, 140, 40);
    await settle();
    const screen = stripAnsi(tab.screen(rig.app, 140, 40).render());
    expect(screen).toContain("PROPOSED (—)");
    expect(screen).toContain("state/rubric/ could not be listed");
    expect(screen).not.toContain("PROPOSED (0)");
  });
});

it("refuses accept while rejection of the same proposal awaits its memory receipt", async () => {
  const root = checkout();
  let finish!: (r: { ok: boolean; message: string }) => void;
  let accepted = 0;
  const mem = new FakeMemory();
  mem.apply = () => new Promise((r) => (finish = r));
  const rig = learningRig({
    repoRoot: root,
    mem,
    accept: async () => {
      accepted++;
      return { ok: true, message: "accepted" };
    },
  });
  const rejecting = rig.learning.store.reject(SLUG, "no");
  expect((await rig.learning.store.accept(SLUG)).ok).toBe(false);
  expect(accepted).toBe(0);
  finish({ ok: true, message: "saved" });
  await rejecting;
});

it("defers the initial change-register refresh until after the first feedback frame", async () => {
  const rig = learningRig();
  let called = false;
  rig.changes.refresh = async () => {
    called = true;
    return undefined;
  };
  rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 40);
  expect(called).toBe(false);
  await settle();
  expect(called).toBe(true);
});

it("refreshes the change register after an accepted proposal", async () => {
  const rig = learningRig({ accept: async () => ({ ok: true, message: "accepted" }) });
  const tab = rig.app.hooks.tabs.feedback!;
  tab.screen(rig.app, 140, 40);
  await settle();
  let refreshes = 0;
  rig.changes.refresh = async () => {
    refreshes++;
    return undefined;
  };
  rig.learning.feedback.focus = "proposed";
  tab.key!(rig.app, { kind: "char", ch: "A" });
  await settle();
  expect(refreshes).toBe(1);
});

it("keeps the selected proposal slug when a reload removes an earlier row", async () => {
  let proposals = [
    { slug: "a", head: [] },
    { slug: "b", head: [] },
  ];
  const rig = learningRig({ fetchProposals: async () => ({ proposals, improvements: [] }) });
  const tab = rig.app.hooks.tabs.feedback!;
  tab.screen(rig.app, 140, 40);
  await settle();
  rig.learning.feedback.focus = "proposed";
  tab.key!(rig.app, { kind: "down" });
  proposals = [
    { slug: "b", head: [] },
    { slug: "c", head: [] },
  ];
  rig.learning.store.reloadProposals();
  await settle();
  expect(rig.learning.store.proposals[rig.learning.feedback.propSel]?.slug).toBe("b");
});

it("cancels an armed retirement when clicking a different memory row", async () => {
  const rig = learningRig();
  const tab = rig.app.hooks.tabs.memory!;
  tab.screen(rig.app, 140, 40);
  await settle();
  const frame = tab.screen(rig.app, 140, 40);
  rig.learning.memory.confirmRetire = "previous";
  const zone = frame.zones.find((z) => (z.action as { t?: string }).t === "mem")!;
  tab.click!(rig.app, zone.x1, zone.y1);
  expect(rig.learning.memory.confirmRetire).toBeUndefined();
});
