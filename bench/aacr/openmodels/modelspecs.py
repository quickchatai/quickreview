"""The preflight's model check: no reviewer model spec may still name another model.

`modelspecs.py <levers> <provider/model>` reads a config.toml on stdin (the one
baked into the image), lays the run's `--config` levers over its [models]
specs, and prints one line: `ok` when every spec would run on the model, `FAIL`
with the keys that would not. Exit 1 on a FAIL.

A tier is named in either spelling on both sides, as the reviewer reads both:
the config's [models.tiers] keys and the levers' `models.tiers.<name>` keys are
folded to the ladder's names before they are compared. Compared as written, a
lever under one spelling never meets a config under the other, and the check
fails a run whose levers the reviewer does apply. LEGACY_TIERS is a hand-kept
copy of LEGACY_TIER_NAMES (packages/pi-plugin/src/types.ts), pinned equal to it
by tests/bench-apikey.test.ts.
"""

import sys
import tomllib

LEGACY_TIERS = {"terra-med": "light", "sol-med": "standard", "sol-high": "deep"}
TIERS = "models.tiers."


def fold_key(key: str) -> str:
    """`models.tiers.<tier>` with the tier in the ladder's spelling; any other key as it is."""
    if not key.startswith(TIERS):
        return key
    tier = key[len(TIERS):]
    return TIERS + LEGACY_TIERS.get(tier, tier)


def check(config_text: str, levers: str, want: str) -> tuple[list[str], int, int]:
    """(the spec keys that would run another model, specs read, per-lens pins read)."""
    m = tomllib.loads(config_text).get("models", {})
    over = {fold_key(k): v for k, v in (p.split("=", 1) for p in levers.split(","))}
    pins = m.get("pass_models", {})
    specs = {f"models.{k}": m.get(k) for k in ("default", "conversation", "overseer")}
    specs |= {fold_key(f"{TIERS}{k}"): v for k, v in m.get("tiers", {}).items()}
    specs |= {f"models.pass_models.{k}": v for k, v in pins.items()}
    bad = [k for k, v in specs.items()
           if v and not (over.get(k, v) == want or over.get(k, v).startswith(want + ":"))]
    return bad, len(specs), len(pins)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: modelspecs.py <levers> <provider/model>  (config.toml on stdin)", file=sys.stderr)
        sys.exit(2)
    want = sys.argv[2]
    bad, n_specs, n_pins = check(sys.stdin.read(), sys.argv[1], want)
    if bad:
        print("FAIL not %s: %s" % (want, ", ".join(bad)))
        sys.exit(1)
    print("ok   every reviewer model spec is %s (%d specs, %d per-lens pins re-pointed)" % (want, n_specs, n_pins))
