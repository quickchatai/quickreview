// The webhook secret `qcr checklist` signs its tunnel probe with
// (src/cliops.ts `checklistWebhookSecret`, read by `cmdChecklist`). Under a
// token-file credential there is none to read: the person has no App, and a
// host-supplied installation's App is the host's. The reads are a fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checklistWebhookSecret } from "../src/cliops.js";
import { stripComments } from "./helpers/engine-fences.js";

const SECRETS = "/install/secrets";

/** A read that records what it was asked, and finds a secret there. */
function recordingRead(): { read: (path: string) => string; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: (path) => {
      asked.push(path);
      return "  s3cret-from-the-file\n";
    },
  };
}

describe("the checklist's webhook secret", () => {
  // MUTATION: drop the `usesTokenFile` check from checklistWebhookSecret —
  // under `auth = "installation"` the checklist reads the secrets dir's
  // webhook secret, and this fails.
  it('under auth = "installation" none is read, whatever the secrets dir holds', () => {
    const r = recordingRead();
    expect(checklistWebhookSecret({ auth: "installation", secrets_dir: SECRETS }, r.read)).toBe("");
    expect(r.asked).toEqual([]);
  });

  it('under auth = "user" none is read either', () => {
    const r = recordingRead();
    expect(checklistWebhookSecret({ auth: "user", secrets_dir: SECRETS }, r.read)).toBe("");
    expect(r.asked).toEqual([]);
  });

  // The control: the App's own install reads it, so the cases above fail for
  // the mode and for nothing else.
  it("an App install reads it from the secrets dir; a file it cannot read is none", () => {
    const r = recordingRead();
    expect(checklistWebhookSecret({ auth: "app", secrets_dir: SECRETS }, r.read)).toBe(
      "s3cret-from-the-file",
    );
    expect(r.asked).toEqual([join(SECRETS, "webhook_secret")]);
    const missing = (): string => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(checklistWebhookSecret({ auth: "app", secrets_dir: SECRETS }, missing)).toBe("");
  });

  // The checklist reads the secret through that one function and nowhere
  // else in its module: a second, unguarded read would bypass it.
  // MUTATION: read `webhook_secret` in cmdChecklist again with readFileSync —
  // this fails.
  it("cmdChecklist asks it, and its module reads the file in no other place", () => {
    const code = stripComments(
      readFileSync(join(import.meta.dirname, "..", "src", "cliops.ts"), "utf8"),
    );
    expect(code.match(/"webhook_secret"/g) ?? []).toHaveLength(1);
    const checklist = code.slice(code.indexOf("export async function cmdChecklist"));
    expect(checklist).toMatch(/checklistWebhookSecret\(cfg\.github\)/);
  });
});
