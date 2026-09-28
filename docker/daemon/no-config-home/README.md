# no-config-home

The default source of the daemon container's read-only `config-home` mount
(`docker-compose.yml`) when `.env` names no `QCR_CONFIG_HOME` — a
compose run by hand, before the onboarding bring-up step has written one.

It deliberately holds no `config.toml`, so the entrypoint finds nothing to name
and the in-container locator falls back to the sandbox's own config, exactly as
before the install locator existed. Defaulting to `~/.config/qcr/default`
instead would have Docker create that directory, owned by root, on every host
that does not have it yet — and a root-owned config home then refuses
`qcr install migrate` and the wizard's own writes.
