#!/usr/bin/env python3
"""Put back the files the run archive stores once: every SOURCE-COPIES.json, restored.

    python3 bench/aacr/ext/restore_copies.py DIR [DIR ...] [--dry-run]

The archive stores a file that is identical to another shipped file only once
(the archive's README.md): a run derived from another one (the Martian
posting-policy variants, the assembled multi-lane Claude runs, the DeepSeek
mix, `whatif/`, ...) carries a `SOURCE-COPIES.json`, `{"files": {<path in the
run>: <archive path of the copy that ships>}}`, and the copy may sit in another
volume. Until the copies are back, such a run reads as if those files were
never written: a variant's case with no `case-summary.json` would score as a
silent review (martian_ingest.py refuses it instead).

Each DIR is where volumes were unpacked: the one directory the README's loop
unpacks every volume into, or one directory per volume. Every
SOURCE-COPIES.json under them is read; each listed file is copied from the
first DIR holding its archive path into the run, next to the
SOURCE-COPIES.json. A file already there with the same bytes is left alone; a
different one, a missing source, an absolute path or one that climbs out of
its root is refused, and nothing is followed through a symlink. --dry-run
checks every entry and copies nothing. Standard library only.
"""
from __future__ import annotations

import argparse
import filecmp
import json
import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional, Tuple

INDEX = "SOURCE-COPIES.json"


def inside(root: Path, rel: str) -> Path:
    """root/rel, refusing a path that is absolute, climbs out, or passes through a symlink."""
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts or not p.parts:
        sys.exit(f"{rel!r}: not a relative path inside the archive")
    out = root
    for part in p.parts:
        out = out / part
        if out.is_symlink():
            sys.exit(f"{out}: a symlink — refusing to follow it")
    return out


def source(dirs: List[Path], rel: str) -> Optional[Path]:
    for d in dirs:
        s = inside(d, rel)
        if s.is_file():
            return s
    return None


def plan(dirs: List[Path]) -> List[Tuple[Path, Path]]:
    """(source, target) for every entry of every SOURCE-COPIES.json under dirs."""
    out = []
    for d in dirs:
        for idx in sorted(d.rglob(INDEX)):
            if idx.is_symlink():
                sys.exit(f"{idx}: a symlink — refusing to follow it")
            files = json.loads(idx.read_text()).get("files")
            if not isinstance(files, dict):
                sys.exit(f"{idx}: no `files` map")
            for rel, src_rel in sorted(files.items()):
                src = source(dirs, src_rel)
                if src is None:
                    sys.exit(f"{idx}: {rel} -> {src_rel}: the source is in none of {', '.join(map(str, dirs))} "
                             "(unpack every volume first)")
                out.append((src, inside(idx.parent, rel)))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="+", type=Path, help="where the archive's volumes were unpacked")
    ap.add_argument("--dry-run", action="store_true", help="check every entry, copy nothing")
    a = ap.parse_args()
    for d in a.dirs:
        if not d.is_dir():
            sys.exit(f"{d}: not a directory")
    todo = plan(a.dirs)
    copied = same = 0
    for src, dst in todo:
        if dst.exists():
            if not dst.is_file() or not filecmp.cmp(src, dst, shallow=False):
                sys.exit(f"{dst} exists and differs from {src}: refusing to overwrite it")
            same += 1
            continue
        if not a.dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            os.chmod(dst, 0o644)
        copied += 1
    verb = "would copy" if a.dry_run else "copied"
    print(f"{len(todo)} listed files: {verb} {copied}, {same} already in place")


if __name__ == "__main__":
    main()
