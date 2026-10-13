"""Each lens's FINAL attempt in a case, read from its pi-events.jsonl.

A lens that hit a transient provider error and was retried successfully is
complete; only a lens whose last attempt ended in an error (or that never ran)
was lost. The session's own `executed_passes` cannot tell the two apart — it
may list a lens whose child failed — so the gate and the reports read this.
"""
import json
from pathlib import Path


def lens(agent: str) -> str:
    """`pass-x--tier`, folding a doubled tier suffix (`pass-x--tier--tier`)."""
    return "--".join((agent or "").split("--")[:2])


def finals(events: Path) -> dict:
    """lens → {"stop": stopReason, "error": message, "launches": n} of its last result."""
    out: dict = {}
    if not events.is_file():
        return out
    for line in events.open():
        if '"tool_execution_end"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("toolName") not in ("launch_plan", "subagent"):
            continue
        for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
            k = lens(r.get("agent"))
            prev = out.get(k, {"launches": 0})
            out[k] = {"stop": r.get("stopReason"), "error": r.get("errorMessage") or (r.get("stderr") or "")[:200],
                      "launches": prev["launches"] + 1}
    return out


def lost(planned: list, events: Path) -> list:
    """Planned lenses whose final attempt failed or that never ran: `[(lens, why)]`."""
    f = finals(events)
    bad = []
    for p in planned:
        r = f.get(lens(p))
        if r is None:
            bad.append((p, "never ran"))
        elif r["stop"] in ("error", "aborted") or r["stop"] is None:
            bad.append((p, (r["error"] or str(r["stop"]))[:160]))
    return bad
