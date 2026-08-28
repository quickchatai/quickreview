#!/usr/bin/env python3
"""Atomic, crash-durable receipts for guarded shell review posting.

The shell owns the existing mutation route. This helper performs no network
access: it only records and inspects the before/after facts of that route.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import sys


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    with tmp.open("w") as fh:
        json.dump(value, fh, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    # Rename atomicity is not crash durability: persist the directory entry too.
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def base(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def check(path: Path, key: str) -> None:
    value = base(path)
    if not value:
        print("none")
    elif value.get("posting_key") != key:
        print("mismatch")
    else:
        print(value.get("status") or "invalid")


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "check":
        if len(sys.argv) != 4:
            raise SystemExit("usage: posting-receipt.py check <path> <key>")
        check(Path(sys.argv[2]), sys.argv[3])
        return
    if len(sys.argv) != 10:
        raise SystemExit("usage: posting-receipt.py <prepare|confirm|dryrun> <path> <key> <pr> <round> <head> <intended> <actual> <payload-json>")
    action, raw_path, key, raw_pr, raw_round, head, intended, actual, payload = sys.argv[1:]
    path = Path(raw_path)
    marker = f"<!-- qcr-post:{key} -->"
    value = base(path)
    if value:
        if value.get("posting_key") != key:
            raise SystemExit("posting-receipt: existing receipt key mismatch")
        if action == "prepare" and value.get("status") in ("prepared", "confirmed", "dryrun"):
            # Never turn confirmed back into prepared and never erase an
            # ambiguous POST window. The shell checks before calling too; this
            # is the fail-closed second layer.
            atomic(path, value)
            return
    prepared_at = value.get("prepared_at") or now()
    value.update({
        "version": 1,
        "posting_key": key,
        "marker": marker,
        "pr": int(raw_pr),
        "round_no": int(raw_round),
        "head_sha": head.lower(),
        "intended_event": intended,
        "actual_event": actual,
        "payload_sha256": hashlib.sha256(payload.encode()).hexdigest(),
        "prepared_at": prepared_at,
    })
    if action == "prepare":
        value["status"] = "prepared"
    elif action == "dryrun":
        value["status"] = "dryrun"
        value["confirmed_at"] = now()
    elif action == "confirm":
        response = json.loads(os.environ.get("QCR_POST_RESPONSE", "{}"))
        review_id = response.get("id")
        commit_id = response.get("commit_id")
        state = str(response.get("state") or "").upper()
        expected_state = {"APPROVE": "APPROVED", "REQUEST_CHANGES": "CHANGES_REQUESTED", "COMMENT": "COMMENTED"}[actual]
        if not isinstance(review_id, int) or not isinstance(commit_id, str):
            raise SystemExit("posting-receipt: GitHub response lacks returned id/commit_id")
        if commit_id.lower() != head.lower() or state != expected_state:
            raise SystemExit(f"posting-receipt: GitHub response mismatch (commit={commit_id}, state={state})")
        value.update({
            "status": "confirmed",
            "confirmed_at": now(),
            "gh_review_id": review_id,
            "gh_commit_id": commit_id.lower(),
            "gh_state": state,
        })
    else:
        raise SystemExit(f"posting-receipt: bad action {action}")
    atomic(path, value)


if __name__ == "__main__":
    main()
