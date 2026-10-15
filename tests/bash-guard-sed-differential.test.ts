// The sed parser in the bash guard, checked against GNU sed's OWN parser.
//
// `checkSedInvocation` decides from its reading of a script whether sed would
// run a command or touch another file. GNU sed's `--sandbox` makes sed itself
// refuse exactly those verbs (the e/w/W/r/R commands and s///e, s///w) when it
// COMPILES the script — so the two can be compared without anything running:
// the input is /dev/null, and a script the sandbox refuses is never executed.
// Where they disagree about where a command ends (a label, an a/i/c text, a
// comment, an s flag cluster), the grid below finds it: every script the guard
// allows must compile under the sandbox.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../extensions/bash-guard.js";

const probe = spawnSync("sed", ["--sandbox", "-n", "-e", "p", "/dev/null"], { encoding: "utf8" });
const gnuSandbox = probe.status === 0;

/** Whether GNU sed, compiling `script` in sandbox mode over no input, refuses
 * it AS a run/read/write verb — not for any other compile error (a jump to a
 * label that is not there is an error too, and says nothing about exec). */
function sandboxRefusesVerb(script: string): boolean {
  const r = spawnSync("sed", ["--sandbox", "-n", "-e", script, "/dev/null"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return r.status !== 0 && /disabled in sandbox mode/.test(r.stderr);
}

const ADDRESSES = [
  "",
  "1",
  "$",
  "1!",
  "1 !",
  "1~2",
  "0~3",
  "/x/",
  "/x/I",
  "\\%x%",
  "1,+2",
  "1,/x/",
  "/a/,/b/!",
];
const COMMANDS = [
  "p",
  "d",
  "=",
  "l",
  "q",
  "{p}",
  "y/a/b/",
  "s/x/y/",
  "s/x/y/gp",
  "s|x|y|I",
  "s/x\\/e/y/p",
  "a foo",
  "a\\",
  "i foo;e",
  "c\\\nfoo",
  ":lbl",
  "b lbl",
  "t",
  "# a comment",
  // The verbs the guard must never allow, in every shape it parses.
  "e",
  "e true",
  "w f",
  "wf",
  "W f",
  "r f",
  "R f",
  "s/x/y/e",
  "s|x|y|e",
  "s/x/y/pe",
  "s/x/y/w f",
  "s#x#y#ge",
];
const JOINS = [";", "\n", " ; "];
const VERBS = ["e", "w f", "r f", "s/x/y/e", "s/x/y/w f"];

function* scripts(): Generator<string> {
  for (const a of ADDRESSES) for (const c of COMMANDS) yield `${a}${c}`;
  for (const c1 of COMMANDS)
    for (const j of JOINS) for (const c2 of ["p", ...VERBS]) yield `${c1}${j}${c2}`;
  // A command after an a/i/c text, a label or a comment — where the parsers
  // most easily disagree about where the next command starts.
  for (const lead of ["1a foo", "1a\\\nfoo", "1i\\", ":lbl", "b lbl", "#c", "1{p", "s/x/y/g"])
    for (const j of [...JOINS, "\n\n", "}\n"]) for (const verb of VERBS) yield `${lead}${j}${verb}`;
}

describe.skipIf(!gnuSandbox)("the guard's sed parser against GNU sed --sandbox", () => {
  it("allows no script that GNU sed's own parser reads as running a command or touching a file", () => {
    const missed: string[] = [];
    let allowed = 0;
    for (const script of scripts()) {
      if (script.includes("'")) continue;
      const verdict = checkBashCommand(`sed -n '${script}' input.txt`);
      if (!verdict.allowed) continue;
      allowed++;
      if (sandboxRefusesVerb(script)) missed.push(JSON.stringify(script));
    }
    expect(missed, `guard allowed what sed --sandbox refuses:\n${missed.join("\n")}`).toEqual([]);
    // The grid is not vacuous: the guard allows the plain reads in it.
    expect(allowed).toBeGreaterThan(100);
  });
});
