"""The models the open-model benchmark arm can run, one table.

Each id must also be registered in src/bench/auth.ts (digitalOceanModels() or
googleModels(), the models.json pi is given inside the sandbox); the prices
there and here agree, $ per 1M tokens: DigitalOcean list prices (2026-10-13),
Gemini API introductory prices (2026-10-14; they double on 2026-12-01).
`provider` is the pi provider and QCR_BENCH_PROVIDER route; `key` the key file
in bench/aacr/ and the variable it must set.
"""

DO = {"provider": "digitalocean", "key": ("digitalocean.env", "DIGITALOCEAN_API_KEY")}
GOOGLE = {"provider": "google", "key": ("google.env", "GEMINI_API_KEY")}

MODELS = {
    "glm-5.3-flash": {**DO, "slug": "glm53", "price": {"input": 0.15, "output": 0.50, "cacheRead": 0.03}},
    "gemma-4-31B-it": {**DO, "slug": "gemma4", "price": {"input": 0.18, "output": 0.50, "cacheRead": 0.036}},
    "deepseek-v4.1-flash": {**DO, "slug": "dsv41f", "price": {"input": 0.30, "output": 1.20, "cacheRead": 0.006}},
    "gemini-4-argon": {**GOOGLE, "slug": "argon4", "price": {"input": 2.00, "output": 10.00, "cacheRead": 0.10}},
}


def usd(usage: dict, model: str) -> float:
    price = MODELS[model]["price"]
    return sum((usage.get(k, 0) or 0) / 1e6 * p for k, p in price.items())


if __name__ == "__main__":
    import sys

    # `models.py slug|provider|keyfile|keyvar <id>` for the shell driver; exit 1 on an unknown id.
    fields = {"slug": lambda m: m["slug"], "provider": lambda m: m["provider"],
              "keyfile": lambda m: m["key"][0], "keyvar": lambda m: m["key"][1]}
    if len(sys.argv) == 3 and sys.argv[1] in fields and sys.argv[2] in MODELS:
        print(fields[sys.argv[1]](MODELS[sys.argv[2]]))
    else:
        print("known models: " + ", ".join(MODELS), file=sys.stderr)
        sys.exit(1)
