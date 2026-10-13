"""The open models the DigitalOcean benchmark arm can run, one table.

Each id must also be registered in src/bench/auth.ts digitalOceanModels() (the
provider pi is given inside the sandbox); the prices there and here are the same
DigitalOcean list prices, $ per 1M tokens (2026-10-13).
"""

MODELS = {
    "glm-5.3-flash": {"slug": "glm53", "price": {"input": 0.15, "output": 0.50, "cacheRead": 0.03}},
    "gemma-4-31B-it": {"slug": "gemma4", "price": {"input": 0.18, "output": 0.50, "cacheRead": 0.036}},
    "deepseek-v4.1-flash": {"slug": "dsv41f", "price": {"input": 0.30, "output": 1.20, "cacheRead": 0.006}},
    "qwen3.8-max": {"slug": "qwen38max", "price": {"input": 2.00, "output": 6.00, "cacheRead": 0.20}},
}


def usd(usage: dict, model: str) -> float:
    price = MODELS[model]["price"]
    return sum((usage.get(k, 0) or 0) / 1e6 * p for k, p in price.items())


if __name__ == "__main__":
    import sys

    # `models.py slug <id>` for the shell driver; exit 1 on an unknown id.
    if len(sys.argv) == 3 and sys.argv[1] == "slug" and sys.argv[2] in MODELS:
        print(MODELS[sys.argv[2]]["slug"])
    else:
        print("known models: " + ", ".join(MODELS), file=sys.stderr)
        sys.exit(1)
