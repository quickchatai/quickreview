#!/usr/bin/env python3
"""Atomic, crash-durable posting receipts for guarded shell review posting.

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


# `deferred` is an attempted POST too: GitHub answered 5xx (or nothing), the
# marker read found no review, and delivery was handed to the daemon.
ATTEMPTED = ("prepared", "confirmed", "dryrun", "deferred")


def skip(path: Path, key: str, raw_pr: str, raw_round: str, head: str, intended: str, mode: str, raw_mark: str) -> None:
    """Record a guard-2 refusal as a terminal, identity-bound no-op.

    Written only before any attempt: an existing prepared/confirmed/dryrun
    receipt is an attempted POST and is never overwritten — the ambiguous
    window (prepared) and the confirmed identity both outrank a later claim
    that nothing was sent. An identical existing skip is idempotent. The
    standing mark is validated here too, so a record whose own evidence would
    not satisfy guard 2 cannot be written by this tool at all.
    """
    if mode not in ("live", "dryrun"):
        raise SystemExit(f"posting-receipt: bad mode {mode}")
    if intended not in ("APPROVE", "REQUEST_CHANGES", "COMMENT"):
        raise SystemExit(f"posting-receipt: bad intended event {intended}")
    try:
        mark = json.loads(raw_mark)
    except Exception as exc:
        raise SystemExit(f"posting-receipt: standing mark is not JSON: {exc}")
    if not isinstance(mark, dict):
        raise SystemExit("posting-receipt: standing mark must be an object")
    if str(mark.get("head_sha") or "").lower() != head.lower():
        raise SystemExit("posting-receipt: standing mark head does not match the refused head")
    reviewed_at = mark.get("reviewed_at")
    reply_at = mark.get("last_author_reply_at")
    if not isinstance(reviewed_at, str) or not reviewed_at:
        raise SystemExit("posting-receipt: standing mark lacks reviewed_at")
    if reply_at is not None and (not isinstance(reply_at, str) or reply_at >= reviewed_at):
        raise SystemExit("posting-receipt: standing mark carries an author reply — not a guard-2 refusal")
    if str(mark.get("verdict") or "").strip().upper() in ("NEEDS_HUMAN", "ESCALATE"):
        raise SystemExit("posting-receipt: standing mark is undecided — not a guard-2 refusal")
    round_no = mark.get("round_no")
    if round_no is not None and not isinstance(round_no, int):
        raise SystemExit("posting-receipt: standing mark round_no must be an integer or null")
    existing = base(path)
    if existing:
        if existing.get("posting_key") != key:
            raise SystemExit("posting-receipt: existing receipt key mismatch")
        if existing.get("status") in ATTEMPTED:
            raise SystemExit("posting-receipt: refusing to record a skip over an attempted post")
        if existing.get("status") == "skipped":
            return  # idempotent replay of the same identity
    value = {
        "version": 1,
        "posting_key": key,
        "marker": f"<!-- qcr-post:{key} -->",
        "pr": int(raw_pr),
        "round_no": int(raw_round),
        "head_sha": head.lower(),
        "status": "skipped",
        "skip_reason": "no-new-evidence",
        "intended_event": intended,
        "mode": mode,
        "skipped_at": now(),
        "standing_mark": {
            "head_sha": str(mark.get("head_sha")),
            "reviewed_at": reviewed_at,
            "verdict": mark.get("verdict") if isinstance(mark.get("verdict"), str) else None,
            "posted_event": mark.get("posted_event") if isinstance(mark.get("posted_event"), str) else None,
            "round_no": round_no,
            "last_author_reply_at": reply_at,
        },
    }
    atomic(path, value)


def enqueue(path: Path, key: str, raw_pr: str, raw_round: str, head: str, event: str,
            repo: str, mode: str, body_file: str, comments_file: str) -> None:
    """Snapshot replayable input before the first GitHub read, under shell lock."""
    if event not in ("APPROVE", "REQUEST_CHANGES", "COMMENT") or mode not in ("live", "dryrun"):
        raise SystemExit("posting-receipt: invalid delivery intent")
    body = Path(body_file).read_text() if body_file else "Automated review: approved."
    payload = {"commit_id": head.lower(), "event": event,
               "body": body + "\n\n" + f"<!-- qcr-post:{key} -->"}
    if comments_file:
        comments = json.loads(Path(comments_file).read_text())
        if not isinstance(comments, list):
            raise SystemExit("posting-receipt: comments file must be a JSON array")
        for c in comments:
            if not isinstance(c, dict) or not isinstance(c.get("path"), str) or type(c.get("line")) is not int or c["line"] < 1 or not isinstance(c.get("body"), str) or c.get("side", "RIGHT") not in ("RIGHT", "LEFT"):
                raise SystemExit("posting-receipt: invalid inline comment")
        payload["comments"] = [{k: c[k] for k in ("path", "line", "side", "body") if k in c} for c in comments]
    source_hash = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    existing = base(path)
    if existing:
        if existing.get("posting_key") != key or existing.get("repo") != repo or existing.get("mode") != mode:
            raise SystemExit("posting-receipt: delivery identity mismatch")
        if existing.get("source_sha256") != source_hash:
            raise SystemExit("posting-receipt: refusing to change queued review input")
        return
    if path.exists():
        raise SystemExit("posting-receipt: refusing to overwrite unreadable delivery intent")
    atomic(path, {"version": 1, "posting_key": key, "repo": repo, "mode": mode,
                  "pr": int(raw_pr), "round_no": int(raw_round), "head_sha": head.lower(),
                  "intended_event": event, "payload": payload, "payload_sha256": source_hash, "source_sha256": source_hash,
                  "status": "pending", "attempts": 0,
                  "created_at": now(), "next_attempt_at": now()})


def defer(path: Path, key: str, raw_pr: str, raw_round: str, head: str, intended: str,
          actual: str, payload: str, reason: str) -> None:
    """Hand an unanswered POST to the daemon.

    Written only over this attempt's own `prepared` receipt — same key, same
    head, same payload bytes — after GitHub answered 5xx or not at all AND a
    read of the PR's reviews found no review carrying this round's marker (or
    could not be read; the daemon reads it again before every attempt). The
    outbox job beside the receipt already holds the exact payload (`prepare`
    copied it there); it is marked pending with the first failure's time, and
    the daemon's retry schedule (state.db `posting_retries`) runs from that.
    Idempotent for a receipt already deferred under the same identity.
    """
    value = base(path)
    if not value or value.get("posting_key") != key:
        raise SystemExit("posting-receipt: no receipt for this posting key to defer")
    digest = hashlib.sha256(payload.encode()).hexdigest()
    if str(value.get("head_sha") or "").lower() != head.lower() or value.get("payload_sha256") != digest:
        raise SystemExit("posting-receipt: deferral does not match the prepared attempt")
    status = value.get("status")
    if status not in ("prepared", "deferred"):
        raise SystemExit(f"posting-receipt: refusing to defer a {status} receipt")
    if intended not in ("APPROVE", "REQUEST_CHANGES", "COMMENT") or actual not in ("APPROVE", "REQUEST_CHANGES", "COMMENT"):
        raise SystemExit("posting-receipt: bad event")
    queued_path = path.with_name(path.stem + ".outbox.json")
    queued = base(queued_path)
    if queued.get("posting_key") != key:
        raise SystemExit("posting-receipt: no delivery snapshot for this posting key — cannot hand off")
    first = value.get("deferred_at") or now()
    queued["payload"] = json.loads(payload)
    queued["payload_sha256"] = hashlib.sha256(json.dumps(queued["payload"], separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    queued["status"] = "pending"
    queued["deferred_at"] = first
    queued["next_attempt_at"] = first
    queued["last_error"] = reason
    queued.pop("negative_at", None)
    # The job first, then the receipt: a deferred receipt always has its
    # handoff on disk.
    atomic(queued_path, queued)
    value.update({"status": "deferred", "deferred_at": first, "defer_reason": reason,
                  "intended_event": intended, "actual_event": actual})
    atomic(path, value)


def withdraw(path: Path, key: str) -> None:
    """Take back this round's queued snapshot after a posting-time guard refused it.

    The shell snapshots its input before the guard reads; a refusal that the
    session answers with a different review (guard 4: APPROVE unavailable, so
    a COMMENT follows under the same key) must not leave that snapshot
    pending, or the next `enqueue` refuses the COMMENT and the daemon delivers
    the refused input later. Allowed only while no receipt exists beside it —
    a receipt of any status records an attempted, recorded or refused post,
    which this never erases. The job is renamed aside (kept as evidence, under
    a name no outbox reader picks up), never rewritten. Idempotent when there
    is nothing queued.
    """
    if path.exists():
        raise SystemExit("posting-receipt: refusing to withdraw — a posting was already attempted or recorded for this key")
    queued_path = path.with_name(path.stem + ".outbox.json")
    if not queued_path.exists():
        return
    queued = base(queued_path)
    if queued.get("posting_key") != key:
        raise SystemExit("posting-receipt: refusing to withdraw an unreadable or mismatched delivery snapshot")
    if queued.get("status") != "pending":
        raise SystemExit(f"posting-receipt: refusing to withdraw a {queued.get('status')} delivery snapshot")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    os.replace(queued_path, queued_path.with_name(f"{queued_path.name}.withdrawn-{stamp}"))
    fd = os.open(queued_path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "owner":
        pid = int(sys.argv[3])
        start = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()[19]
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        Path(sys.argv[2]).write_text(f"{pid} {start} {boot}\n")
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "enqueue":
        if len(sys.argv) != 12:
            raise SystemExit("usage: posting-receipt.py enqueue <path> <key> <pr> <round> <head> <event> <repo> <mode> <body> <comments>")
        enqueue(Path(sys.argv[2]), *sys.argv[3:12])
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "check":
        if len(sys.argv) != 4:
            raise SystemExit("usage: posting-receipt.py check <path> <key>")
        check(Path(sys.argv[2]), sys.argv[3])
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "defer":
        if len(sys.argv) != 11:
            raise SystemExit("usage: posting-receipt.py defer <path> <key> <pr> <round> <head> <intended> <actual> <payload-json> <reason>")
        defer(Path(sys.argv[2]), *sys.argv[3:11])
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "withdraw":
        if len(sys.argv) != 4:
            raise SystemExit("usage: posting-receipt.py withdraw <path> <key>")
        withdraw(Path(sys.argv[2]), sys.argv[3])
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "skip":
        if len(sys.argv) != 10:
            raise SystemExit("usage: posting-receipt.py skip <path> <key> <pr> <round> <head> <intended> <live|dryrun> <standing-mark-json>")
        skip(Path(sys.argv[2]), *sys.argv[3:10])
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
        if value.get("status") == "skipped":
            # This identity was refused by guard 2 and that refusal is
            # terminal for the key. The shell's `check` already turns a skip
            # into a refusal before it gets here; this is the fail-closed
            # second layer, so no attempt can be recorded over a skip either.
            raise SystemExit(f"posting-receipt: {key} was refused (no new evidence); refusing to record an attempted post over it")
        if action == "prepare" and value.get("status") in ATTEMPTED:
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
    queued_path = path.with_name(path.stem + ".outbox.json")
    queued = base(queued_path)
    if queued.get("posting_key") == key:
        queued["payload"] = json.loads(payload)
        queued["payload_sha256"] = hashlib.sha256(json.dumps(queued["payload"], separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if action == "prepare":
            queued["attempted_at"] = now()
            queued.pop("negative_at", None)
        elif action in ("confirm", "dryrun"):
            queued["status"] = "done"
        atomic(queued_path, queued)


if __name__ == "__main__":
    main()
