# Security

HyperTrade handles user authentication, hot relayer wallets, and database access.
Treat this repo as **sensitive infrastructure**, not a toy demo.

---

## Never commit

- `.env`, `.env.local`, or any file containing secrets (keep `*.env.example`)
- `BRIDGE2_RELAYER_PRIVATE_KEY` or `HL_TESTNET_MASTER_PK`
- Supabase **service_role** key
- Privy app secrets (server-side `PRIVY_APP_SECRET`)
- Alchemy / RPC URLs that embed API keys (use env, not `app.json`)
- Firebase `GoogleService-Info.plist` / `google-services.json` (gitignored; use `*.example`)
- Production AppsFlyer / analytics keys

`.gitignore` excludes `*.env` / `*.env.*` but **allows** `*.env.example`. Double-check before pushing.

---

## Key handling

| Secret | Where it lives | Exposure |
|--------|----------------|----------|
| User EOA | Privy embedded wallet | User device |
| HL agent key | Expo SecureStore | User device |
| Relayer EOA | Backend env only | Server |
| Supabase service_role | Backend env only | Server |
| Privy App ID | `EXPO_PUBLIC_PRIVY_APP_ID` + backend `PRIVY_APP_ID` | Public-ish; still use **your** Privy app |
| Privy Client ID | `EXPO_PUBLIC_PRIVY_CLIENT_ID` | Public-ish; still use **your** Privy app |
| Builder address/fee | Hardcoded HyperTrade defaults; forks set `EXPO_PUBLIC_HL_BUILDER_*` (Expo/EAS) + matching `BUILDER_*` | Client pins address on orders — see HL_BUILDER.md |

**Relayer wallet:** use a dedicated EOA with minimal ETH. Rotate immediately if leaked.

**Testnet master PK:** testnet funds only. Never reuse mainnet keys.

---

## Reporting vulnerabilities

If you discover a security issue in this repository, please **do not** open a public GitHub issue with exploit details.

Contact the maintainers privately with:

- Description and impact
- Steps to reproduce
- Suggested fix (optional)

---

## Forking safely

1. Create **new** Privy, Supabase, and Railway projects — do not reuse HyperTrade production credentials.
2. Register your **own** HL builder code.
3. Run `backend/supabase_schema.sql` on a fresh Supabase project.
4. Review [ENVIRONMENT.md](./docs/ENVIRONMENT.md) for deprecated vars before copying old env dumps.

---

## Disclaimer

This software is provided as-is. You are responsible for securing your deployment, complying with applicable law, and protecting user funds.
