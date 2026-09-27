#!/usr/bin/env python3
"""Index every AACR-Bench reference by the benchmark's OWN labels.

    bench/aacr/reference_index.py <positive_samples.json> > bench/aacr/references.json

The harness's result files say, per reference and judge round, whether a
review matched it (`eval_res[].comments[].semantic_match`), but not what kind
of finding the reference is. The dataset does: each reference carries a
`category` (Code Defect / Maintainability and Readability / Performance /
Security Vulnerability) and a `context` (Diff / File / Repo Level). This file
keeps exactly those two labels per reference, keyed the way the harness
writes a reference (path, lines, note), so `compare.py --aacr` can break the
benchmark's recall down by its own dimensions — the counterpart of the
defect benchmark's high/medium/low. The benchmark has no severity; nothing
here invents one. Refuses any dataset but the pinned v1.0 (select_cases.py).
"""
import hashlib, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from select_cases import V1_SHA256, case_of  # noqa: E402


def note_key(path, start, end, note):
    """The key compare.py rebuilds from a harness eval_res comment."""
    h = hashlib.sha1(" ".join(str(note).split()).encode()).hexdigest()[:12]
    return f"{path}:{start}-{end}:{h}"


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    raw = open(sys.argv[1], "rb").read()
    if hashlib.sha256(raw).hexdigest() != V1_SHA256:
        raise SystemExit(f"{sys.argv[1]} is not AACR-Bench v1.0 — refusing")
    out = {}
    for rec in json.loads(raw):
        iid = case_of(rec)["instance_id"]
        out[iid] = {
            note_key(c["path"], c["from_line"], c["to_line"], c["note"]): [c["category"], c["context"]]
            for c in rec.get("comments") or []
        }
    json.dump({"dataset_sha256": V1_SHA256, "references": out}, sys.stdout, indent=0, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
