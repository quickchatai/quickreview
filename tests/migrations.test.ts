// Migration-number collision pre-check: the pure half — parsing,
// detection against the base branch, and the COMMENT text.
import { describe, expect, it } from "vitest";
import {
  collisionFingerprint,
  detectMigrationCollisions,
  parseMigrationPath,
  renderMigrationCollisionComment,
} from "../src/migrations.js";

const BASE = [
  "backend/chat/migrations/__init__.py",
  "backend/chat/migrations/0041_add_index.py",
  "backend/chat/migrations/0042_add_widget_flag.py",
  "backend/billing/migrations/0007_invoice.py",
  "backend/chat/models.py",
];

function added(filename: string) {
  return { filename, status: "added" };
}

describe("parseMigrationPath", () => {
  it("splits app, number and name", () => {
    expect(parseMigrationPath("backend/chat/migrations/0042_add_thing.py")).toEqual({
      path: "backend/chat/migrations/0042_add_thing.py",
      app: "backend/chat",
      app_label: "chat",
      number: 42,
      digits: "0042",
      name: "add_thing",
    });
  });

  it("ignores non-migrations, __init__ and unnumbered files", () => {
    expect(parseMigrationPath("backend/chat/models.py")).toBeUndefined();
    expect(parseMigrationPath("backend/chat/migrations/__init__.py")).toBeUndefined();
    expect(parseMigrationPath("docs/migrations/plan.md")).toBeUndefined();
  });
});

describe("detectMigrationCollisions", () => {
  it("flags a PR migration on a number the base branch already took", () => {
    const out = detectMigrationCollisions({
      files: [
        added("backend/chat/migrations/0042_add_rate_limit.py"),
        added("backend/chat/views.py"),
      ],
      baseFiles: BASE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      app_label: "chat",
      pr_path: "backend/chat/migrations/0042_add_rate_limit.py",
      base_path: "backend/chat/migrations/0042_add_widget_flag.py",
      number: 42,
      target_number: 43,
      target_path: "backend/chat/migrations/0043_add_rate_limit.py",
      dependency: '("chat", "0042_add_widget_flag")',
    });
  });

  it("is silent when the PR's numbers are free", () => {
    expect(
      detectMigrationCollisions({
        files: [added("backend/chat/migrations/0043_add_rate_limit.py")],
        baseFiles: BASE,
      }),
    ).toEqual([]);
  });

  it("is silent for a PR with no migrations at all", () => {
    expect(
      detectMigrationCollisions({
        files: [added("backend/chat/views.py"), added("frontend/app.tsx")],
        baseFiles: BASE,
      }),
    ).toEqual([]);
  });

  it("does not flag a migration the PR merely edits in place", () => {
    expect(
      detectMigrationCollisions({
        files: [
          { filename: "backend/chat/migrations/0042_add_widget_flag.py", status: "modified" },
        ],
        baseFiles: BASE,
      }),
    ).toEqual([]);
  });

  it("ignores deleted PR files", () => {
    expect(
      detectMigrationCollisions({
        files: [{ filename: "backend/chat/migrations/0042_other.py", status: "removed" }],
        baseFiles: BASE,
      }),
    ).toEqual([]);
  });

  it("only collides within the same app", () => {
    // 0007 is taken in billing, free in chat.
    expect(
      detectMigrationCollisions({
        files: [added("backend/chat/migrations/0007_early.py")],
        baseFiles: BASE,
      }),
    ).toEqual([]);
  });

  it("renumbers two colliding migrations into a chain", () => {
    const out = detectMigrationCollisions({
      files: [
        added("backend/chat/migrations/0042_first.py"),
        added("backend/chat/migrations/0041_zeroth.py"),
      ],
      baseFiles: BASE,
    });
    expect(out.map((c) => [c.pr_path, c.target_path, c.dependency])).toEqual([
      [
        "backend/chat/migrations/0041_zeroth.py",
        "backend/chat/migrations/0043_zeroth.py",
        '("chat", "0042_add_widget_flag")',
      ],
      [
        "backend/chat/migrations/0042_first.py",
        "backend/chat/migrations/0044_first.py",
        '("chat", "0043_zeroth")',
      ],
    ]);
  });

  it("skips past a free number the PR itself already uses", () => {
    // The PR adds 0042 (collides) and 0043 (free): the remedy must not land on
    // the PR's own 0043.
    const out = detectMigrationCollisions({
      files: [
        added("backend/chat/migrations/0042_first.py"),
        added("backend/chat/migrations/0043_second.py"),
      ],
      baseFiles: BASE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.target_path).toBe("backend/chat/migrations/0044_first.py");
  });

  it("names the follow-up dependency edit when a later migration depends on a renamed one", () => {
    // The chained shape: the PR adds 0042_a (collides with the base's
    // 0042) and 0043_b whose `dependencies` reference "0042_a". The advice must
    // rename 0042_a → 0044_a AND tell the author to repoint 0043_b at the new
    // name — and since 0043 would now sit below its own dependency, renumber
    // 0043_b too.
    const out = detectMigrationCollisions({
      files: [
        added("backend/chat/migrations/0042_a.py"),
        {
          filename: "backend/chat/migrations/0043_b.py",
          status: "added",
          patch: '@@\n+    dependencies = [\n+        ("chat", "0042_a"),\n+    ]',
        },
      ],
      baseFiles: BASE,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: "base-collision",
      pr_path: "backend/chat/migrations/0042_a.py",
      target_path: "backend/chat/migrations/0044_a.py",
      dependency: '("chat", "0042_add_widget_flag")',
    });
    expect(out[1]).toMatchObject({
      kind: "renamed-dependency",
      pr_path: "backend/chat/migrations/0043_b.py",
      stale_dependency: "0042_a",
      dependency: '("chat", "0044_a")',
      renumber: true,
      target_path: "backend/chat/migrations/0045_b.py",
    });

    const body = renderMigrationCollisionComment({
      collisions: out,
      base_ref: "master",
      base_sha: "cafebabe0000",
    });
    expect(body).toContain("backend/chat/migrations/0044_a.py");
    expect(body).toContain('reference `"0042_a"`');
    expect(body).toContain('`[("chat", "0044_a")]`');
    expect(body).toContain("backend/chat/migrations/0045_b.py");
  });

  it("cascades: a follow-up depending on a renumbered follow-up renumbers too", () => {
    const out = detectMigrationCollisions({
      files: [
        added("backend/chat/migrations/0042_a.py"),
        {
          filename: "backend/chat/migrations/0043_b.py",
          status: "added",
          patch: '+    dependencies = [("chat", "0042_a")]',
        },
        {
          filename: "backend/chat/migrations/0044_c.py",
          status: "added",
          patch: '+    dependencies = [("chat", "0043_b")]',
        },
      ],
      baseFiles: BASE,
    });
    expect(out.map((c) => [c.pr_path, c.target_path, c.dependency])).toEqual([
      [
        "backend/chat/migrations/0042_a.py",
        "backend/chat/migrations/0045_a.py",
        '("chat", "0042_add_widget_flag")',
      ],
      [
        "backend/chat/migrations/0043_b.py",
        "backend/chat/migrations/0046_b.py",
        '("chat", "0045_a")',
      ],
      [
        "backend/chat/migrations/0044_c.py",
        "backend/chat/migrations/0047_c.py",
        '("chat", "0046_b")',
      ],
    ]);
  });

  it("does not invent a follow-up when the later migration references nothing renamed", () => {
    const out = detectMigrationCollisions({
      files: [
        added("backend/chat/migrations/0042_a.py"),
        {
          filename: "backend/chat/migrations/0043_b.py",
          status: "added",
          patch: '@@\n+    dependencies = [("chat", "0042_add_widget_flag")]',
        },
      ],
      baseFiles: BASE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("base-collision");
  });

  it("keeps the on-disk padding width", () => {
    const out = detectMigrationCollisions({
      files: [added("svc/migrations/009_x.py")],
      baseFiles: ["svc/migrations/009_y.py"],
    });
    expect(out[0]?.target_path).toBe("svc/migrations/010_x.py");
  });
});

describe("renderMigrationCollisionComment", () => {
  const collisions = detectMigrationCollisions({
    files: [added("backend/chat/migrations/0042_add_rate_limit.py")],
    baseFiles: BASE,
  });

  it("names the exact target number and dependencies value", () => {
    const body = renderMigrationCollisionComment({
      collisions,
      base_ref: "master",
      base_sha: "abcdef1234567890",
    });
    expect(body).toContain("backend/chat/migrations/0043_add_rate_limit.py");
    expect(body).toContain('`[("chat", "0042_add_widget_flag")]`');
    expect(body).toContain("**0043**");
    expect(body).toContain("abcdef123456");
  });

  it("says plainly that it is not a blocker and consumes no verdict", () => {
    const body = renderMigrationCollisionComment({
      collisions,
      base_ref: "master",
      base_sha: "abc",
    });
    expect(body.toLowerCase()).toContain("not a blocker");
    expect(body.toLowerCase()).toContain("consumes no review verdict");
  });
});

describe("collisionFingerprint", () => {
  const collisions = detectMigrationCollisions({
    files: [added("backend/chat/migrations/0042_add_rate_limit.py")],
    baseFiles: BASE,
  });

  it("is stable per head sha and changes with it", () => {
    expect(collisionFingerprint("head1", collisions)).toBe(
      collisionFingerprint("head1", collisions),
    );
    expect(collisionFingerprint("head2", collisions)).not.toBe(
      collisionFingerprint("head1", collisions),
    );
  });
});
