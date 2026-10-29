"""Read one table of the published Hugging Face dataset as a list of dicts.

    from tables import load_table
    rows = load_table("<hf-dataset>/data", "defect_verdicts")

`data_dir` is the dataset's `data/` directory (or the dataset root, which holds
`data/`). A table is `<name>.parquet`, read with pyarrow (imported only then),
or `<name>.jsonl`, one JSON object per line — the form the repo's tests use for
small fixtures, standard library only. A missing table is an error naming the
path, never an empty list: a recompute that cannot read its source must not
print a number.
"""
from __future__ import annotations

import json
import os
from typing import Dict, List


def data_dir_of(path: str) -> str:
    """The directory that holds the tables: `path` itself, or `path/data`."""
    sub = os.path.join(path, "data")
    return sub if os.path.isdir(sub) else path


def load_table(path: str, name: str) -> List[Dict]:
    d = data_dir_of(path)
    pq_path, jl_path = os.path.join(d, f"{name}.parquet"), os.path.join(d, f"{name}.jsonl")
    if os.path.exists(pq_path):
        import pyarrow.parquet as pq  # only for the published parquet files

        return pq.read_table(pq_path).to_pylist()
    if os.path.exists(jl_path):
        with open(jl_path) as f:
            return [json.loads(line) for line in f if line.strip()]
    raise SystemExit(f"table {name!r} not found: neither {pq_path} nor {jl_path}")


def percentile_ci(values: List[float]) -> tuple:
    """The papers' percentile 95% interval over B resamples: the sorted values
    at index int(0.025*B) and int(0.975*B)-1 (250 and 9749 for B=10,000)."""
    v = sorted(values)
    b = len(v)
    return v[int(0.025 * b)], v[int(0.975 * b) - 1]
