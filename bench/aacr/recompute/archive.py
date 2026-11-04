"""Read files of the published run archive (`archive/` of the Hugging Face dataset).

    from archive import open_archive
    root = open_archive("<release>/archive", work="<scratch>", volumes=["answer-key", "analysis"])
    truth = root / "rest145-code" / "<instance id>" / "truth.json"

The archive ships one `quickreview-runs-<family>.tar.zst` volume per run family,
beside `MANIFEST.json`. `open_archive` unpacks the volumes a script names into
`<work>/archive/` (once: a volume already unpacked from the same file is not
unpacked again) and returns that directory, so every script reads the archive's
own paths (`runs/<run>/cases/<id>/...`, `rest145-code/<id>/...`, `analysis/...`).
Given a directory that is already an unpacked archive (it holds `runs/` or
`rest145-code/` and no volumes), it returns that directory unchanged.

A volume the archive does not hold is an error naming it, never an empty tree:
a recompute that cannot read its source must not print a number. Standard
library only (Python 3.14's `tarfile` reads zstd); `tar -I zstd` is the
fallback for an older Python.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path
from typing import Iterable

PREFIX = "quickreview-runs-"


def volume_path(archive: Path, family: str) -> Path:
    return archive / f"{PREFIX}{family}.tar.zst"


def is_unpacked(path: Path) -> bool:
    return not any(path.glob(f"{PREFIX}*.tar.zst")) and any(
        (path / d).is_dir() for d in ("runs", "rest145-code", "analysis", "open-models", "elo"))


def _unpack(vol: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(vol, "r:zst") as t:
            t.extractall(dest, filter="data")
        return
    except (tarfile.CompressionError, ValueError, ImportError):
        pass
    if not shutil.which("tar") or not shutil.which("zstd"):
        raise SystemExit(f"cannot unpack {vol}: this Python's tarfile has no zstd and no tar + zstd is on PATH")
    subprocess.run(["tar", "-I", "zstd", "-xf", str(vol), "-C", str(dest)], check=True)


def open_archive(archive: str, work: str, volumes: Iterable[str]) -> Path:
    """The directory holding the named volumes' files (see the module docstring)."""
    src = Path(archive).resolve()
    if is_unpacked(src):
        return src
    if not (src / "MANIFEST.json").exists():
        raise SystemExit(f"{src} is neither the release's archive/ (MANIFEST.json and volumes) nor an unpacked archive")
    dest = Path(work).resolve() / "archive"
    dest.mkdir(parents=True, exist_ok=True)
    for fam in volumes:
        vol = volume_path(src, fam)
        if not vol.exists():
            raise SystemExit(f"archive volume missing: {vol.name}")
        st = vol.stat()
        stamp = {"volume": vol.name, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
        mark = dest / f".{vol.name}.unpacked"
        try:
            if json.loads(mark.read_text()) == stamp:
                continue
        except (OSError, ValueError):
            pass
        _unpack(vol, dest)
        mark.write_text(json.dumps(stamp))
    return dest


def read_json(path: Path):
    with open(path) as f:
        return json.load(f)


def iter_jsonl(path: Path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("{"):
                yield json.loads(line)


def exists(root: Path, rel: str) -> bool:
    return os.path.exists(root / rel)


def volumes_for(runs_rows, units) -> list:
    """The archive volume families holding the given run units (the HF `runs` table's `archive_volumes`)."""
    by = {r["unit"]: r for r in runs_rows}
    out = set()
    for u in units:
        if u not in by:
            raise SystemExit(f"run unit {u!r} is not in the runs table")
        out.update(v.removeprefix(PREFIX).removesuffix(".tar.zst") for v in by[u].get("archive_volumes") or [])
    return sorted(out)
