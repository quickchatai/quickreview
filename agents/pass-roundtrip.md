---
name: pass-roundtrip
description: Persisted-bytes round-trip pass (sub-lens of data-safety) — traces sample files through read, detect, decode, edit, encode and write, and checks the bytes that land on disk.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

# Lens: persisted-bytes round trip (sub-lens of data-safety)

Selected because the diff reads, decodes, transforms and writes back files or
stored data — encodings, charset detection, line endings, serialization. The
one question: does content come back out byte for byte, except for exactly
the change the user asked for?

Trace each sample below through the path the PR adds or changes — read →
detect/parse → decode → edit → encode/serialize → write — using the real
functions and the real library code. When the task string lists third-party
sources, read the library there; never assume what a library names an
encoding, supports, or defaults to. One row per sample in your notes: the
bytes that end up on disk, and whether that is what the user had plus their
edit.

Samples:

- a pure-ASCII file to which the user adds one non-ASCII character;
- a valid UTF-8 file with only a few non-ASCII characters — the case charset
  detectors most often misjudge;
- UTF-8 with a byte-order mark; UTF-16 LE and BE with a byte-order mark;
- CRLF line endings, with and without a final newline, with trailing blank
  lines;
- a legacy single-byte or multi-byte encoding (Windows-1252, Shift-JIS);
- an encoding name the detector can return but the codec cannot handle, and a
  name spelled differently by the two libraries;
- binary content to which a detector assigns a charset;
- a file larger than any size limit on the path — is the limit checked before
  the whole file is read into memory?

Then check the paths around the write: the revert/reject/undo path restores
the ORIGINAL bytes; anything normalised only for display or comparison
(trimmed whitespace, converted line endings) never reaches the bytes written;
and every other entry point that reads the same files makes the same
decision.

A sample whose output differs from input-plus-edit is a finding — name the
sample in the claim. `NONE` when every sample round-trips.
