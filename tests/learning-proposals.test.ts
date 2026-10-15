// The rubric-proposal verbs on the learning store: a rejection is put on
// record before its proposal is removed, never the other way round, and a
// proposal being accepted cannot be rejected under the accept.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryOp } from "../src/memory/store.js";
import { FakeMemory, learningRig } from "./helpers/tui-rig.js";

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
