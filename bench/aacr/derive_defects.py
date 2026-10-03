#!/usr/bin/env python3
"""The defect key of a derived set: its parent's key cut to the set's cases.

  derive_defects.py defects/<parent>.json sets/<set>.json > <key>.json

Defects are copied unchanged; `set` names the derived set and `method` says
where the key came from. A case of the set missing from the parent's key is an
error — a derived set is only ever a subset (bench.sh judge, `defects_from`).
"""
import json
import sys


def derive(parent: dict, case_set: dict) -> dict:
    ids = [c["instance_id"] for c in case_set["cases"]]
    missing = [i for i in ids if i not in parent["cases"]]
    if missing:
        raise SystemExit(f"cases not in the parent key: {', '.join(missing)}")
    out = dict(parent)
    out["set"] = case_set["name"]
    out["method"] = (f"Subset of {parent['set']} (version {parent.get('version', '?')}) for the "
                     f"{len(ids)} {case_set['name']} PRs; defects unchanged. " + parent.get("method", ""))
    out["cases"] = {i: parent["cases"][i] for i in ids}
    return out


if __name__ == "__main__":
    parent = json.load(open(sys.argv[1]))
    case_set = json.load(open(sys.argv[2]))
    json.dump(derive(parent, case_set), sys.stdout, indent=1)
    sys.stdout.write("\n")
