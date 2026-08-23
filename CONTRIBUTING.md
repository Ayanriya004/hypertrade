# Contributing

Thanks for interest in HyperTrade. This repo is a **mobile-first Hyperliquid builder** reference. Read these before opening a PR:

- [AGENTS.md](./AGENTS.md) — repo map for coding agents
- [docs/FORKING.md](./docs/FORKING.md) — Tier 1 vs optional AI / neobank
- [docs/SETUP.md](./docs/SETUP.md) — local run
- [SECURITY.md](./SECURITY.md) — what never to commit

## Product tiers

| Tier | Default for PRs? |
|------|------------------|
| Core HL trading | Yes — prefer changes that help this path |
| AI agents | Optional (Tier 2) — worker is a separate deploy |
| Neobank / UR banking | Optional (Tier 3) — don’t require it for Tier 1 features |

## Development

1. Fork / clone; copy `backend/.env.example`, `frontend/.env.example`, and (if shipping AI) `workers/ai-agent/.env.example`.
2. Use **your** Privy, Supabase, RPC, and Firebase files — not production HyperTrade secrets.
3. Run backend + Expo per [SETUP.md](./docs/SETUP.md).
4. Keep PRs focused; match existing style; English-only i18n unless asked otherwise.

## Pull requests

- Describe **why** the change matters (fork UX, security, bug fix, docs).
- Don’t commit `.env`, Firebase plist/json, relayer keys, or `service_role` keys.
- Don’t add exploit tooling or production HyperTrade credentials.
- Update docs when you change setup, env vars, or tier boundaries.

## Support / donations

Optional — if you want to support maintenance of this reference app:

`0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB`

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](./LICENSE)).
