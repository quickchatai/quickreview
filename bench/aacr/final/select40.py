#!/usr/bin/env python3
"""The 40-PR selection set of the best-shot study, and its 145-PR complement.

    python3 bench/aacr/final/select40.py            # print both specs (arm.sh --cases syntax)
    python3 bench/aacr/final/select40.py --check    # verify select40.txt / other145.txt

The rule, fixed before any run: sort rest145's PRs by
sha1("fairness-2026-09-30|" + instance_id) and take the first 40. The other
145 are every other PR of the 185 (smoke10, dev10, holdout10, fresh10 and the
rest of rest145), in the order arm.sh was given them.
"""
import hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SETS = os.path.join(HERE, "..", "sets")
SEED = "fairness-2026-09-30|"


def ids(name):
    return [c["instance_id"] for c in json.load(open(os.path.join(SETS, f"{name}.json")))["cases"]]


def specs():
    rest = ids("rest145")
    pick = sorted(rest, key=lambda i: hashlib.sha1((SEED + i).encode()).hexdigest())[:40]
    chosen = set(pick)
    groups = [f"{s}:{','.join(ids(s))}" for s in ("smoke10", "dev10", "holdout10", "fresh10")]
    groups.append("rest145:" + ",".join(i for i in rest if i not in chosen))
    return "rest145:" + ",".join(pick), "+".join(groups)


if __name__ == "__main__":
    a, b = specs()
    if "--check" in sys.argv:
        ok = open(os.path.join(HERE, "select40.txt")).read().strip() == a \
            and open(os.path.join(HERE, "other145.txt")).read().strip() == b
        print("select40.txt and other145.txt match the rule" if ok else "MISMATCH")
        sys.exit(0 if ok else 1)
    print(a)
    print(b)
