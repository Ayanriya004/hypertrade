# UR.APP neobank / banking (fork guide)

Short, implementation-accurate overview of HyperTrade’s optional IBAN/card (neobank-style) rails.  
Schema: [DATABASE.md](./DATABASE.md). Strip guide: [FORKING.md](./FORKING.md).  
Official docs / sandbox: [https://docs.ur.app/](https://docs.ur.app/).

---

## What this module is

HyperTrade integrates **UR** (Fiat24) in **External Wallet Access** mode:

- User’s Privy EOA owns the URID NFT; fiat tokens (e.g. USD24/EUR24) sit at that EOA under UR’s contract rules (`backend/ur_relayer.py` header comments).
- HyperTrade backend uses **partner-authenticated** UR OpenAPI calls (`backend/ur_api.py`) and sponsors gas via a **UR relayer pool** for selected flows (Add Money / FX via EIP-7702 + Ambire). Withdraw/payout use UR’s permit REST paths (UR submits settlement).
- **KYC/AML is provided by UR** (not something you run in-house). The app uses the **Sumsub mobile SDK** (`frontend/src/lib/sumsubKyc.ts`); your backend fetches Sumsub access tokens / status from UR APIs. **Identity documents are not stored on HyperTrade servers** — they go to UR / Sumsub. NFC capture needs a custom dev/prod build, not Expo Go.

This is **Tier 3 — optional** (separate from HL; AI agents are Tier 2). Core HL trading does not need it.

**Partner access:** setup always requires **manual communication with the UR team** for a partner ID. Docs: [https://docs.ur.app/](https://docs.ur.app/).

**Platform status (check before you build on crypto rails):** Fiat24 / UR has at times paused **crypto top-up / crypto on–off ramp** (crypto deposit & withdraw) features. In that situation, **fiat** bank deposits & withdrawals, **FX conversion**, and **P2P** have often remained available — but this can change. Builders should follow latest updates on [@Fiat24Official](https://x.com/Fiat24Official) and confirm with the UR team when onboarding.

### Stay current

UR docs and which rails are live change. Use these, not archived GitBook URLs:

| Source | Why |
|--------|-----|
| [docs.ur.app](https://docs.ur.app/) | Home — Quickstart, [integration guide](https://docs.ur.app/getting-started/integration-guide), KYC, [webhooks](https://docs.ur.app/developer-resources/webhook), [API reference](https://docs.ur.app/api-reference) |
| [@Fiat24Official](https://x.com/Fiat24Official) | Feature / ramp status (e.g. crypto on–off ramp maintenance) |
| `backend/ur_chain.py` | Contract addresses + ABIs this repo actually calls |
| [ur-app/ur-contracts](https://github.com/ur-app/ur-contracts) | Contract source + [Audits](https://github.com/ur-app/ur-contracts/tree/main/Audits) |

UR removed the public **smart-contracts** docs page. If they republish addresses, compare against `ur_chain.py`. Do not treat GitHub `deployments/*.json` as truth (the Mantle Sepolia file has listed mainnet addresses).

**Scale / cost:** neobank volume is **not** the same capacity story as “~1k HL traders.” Partner API limits, webhooks/`ur_jobs`, Mantle+Arb RPC, and UR relayer gas dominate long before Expo does — and commercial/KYC terms are a separate business. See [COSTS.md](./COSTS.md) and [HL_BUILDER.md — Scaling](./HL_BUILDER.md#scaling--rate-limits).

UR’s own model is three independent choices ([integration guide](https://docs.ur.app/getting-started/integration-guide)): **Account Mode**, **Card Mode**, and **KYC Mode**. This repo’s Account Mode is External Wallet Access; Card Mode is below.

---

## Card Mode: Fiat Only (what we use) vs Crypto Backed

UR **Card Mode** is orthogonal to Account Mode — it decides **where card spend draws funds from** when the user taps the co-branded debit card. Docs: [Choose your integration options → Card Mode](https://docs.ur.app/getting-started/integration-guide#card-mode).

| Card Mode | Brand signal (from `/api/v2/br` `debitCard`) | Where spend settles | Extra partner surfaces |
|-----------|-----------------------------------------------|---------------------|------------------------|
| **Fiat Only** | `MSTD` | User’s UR **fiat** balance (USD24/EUR24/CHF24, etc.) | Standard card endpoints for your Account Mode |
| **Crypto Backed** | `MSTC` | Partner **Prefund** + real-time **authorization callback** (and related webhooks) | Prefund account, auth callback ≤500ms, Crypto Backed APIs |

**HyperTrade uses Card Mode: Fiat Only.**

That matches the implementation notes in `backend/ur_api.py` (card spend against the user’s UR fiat balance; `/api/v1/token-permit` for the card contract) and UI/API comments (`MSTD` = Fiat-Only, `MSTC` = Crypto-Backed in `frontend/src/lib/urApi.ts` / `useUrCard.ts`). Crypto Backed’s partner auth-callback + prefund surfaces are **not** wired as the product path (`ur_api.py` explicitly notes Crypto-Backed extras are out of scope for the current strategy).

**Why this matters for forks**

- Your **partner programme** is configured with UR for a Card Mode. Getting Fiat Only vs Crypto Backed wrong means the wrong settlement model and missing APIs (especially the Crypto Backed callback).
- Confirm Card Mode with UR when you obtain your partner ID — same manual onboarding channel as partner activation.
- Switching later is a UR-side + integration change, not a flip of a single env flag in this repo.
- Crypto Backed reference (if you intentionally choose it later): [Card Mode: Crypto Backed](https://docs.ur.app/api-reference/cards/crypto-backed-card).

Users who want to spend crypto on a Fiat Only card still **off-ramp into UR fiat first** (Add Money), then spend from that fiat balance.

---

## Partner ID (required for real users)

To offer IBAN/card to users you need an **active UR partner ID** (and matching signer keys).

- Today: **manual onboarding with the UR team** — not a self-serve “get partner ID from the docs alone” path for production activation.
- Fees, commercial terms, and technical steps **can change**.
- Always follow the latest process at **[https://docs.ur.app/](https://docs.ur.app/)** (Quickstart, integration modes, sandbox, KYC, webhooks).

Until you have credentials, skip this module ([FORKING.md](./FORKING.md) §2).

---

## How to enable (what the code expects)

### 1. Database

```text
backend/migrations/ur_banking_v1.sql
```

Tables: `ur_links`, `ur_webhook_events`, `ur_jobs`, `ur_notifications`, `ur_p2p_recipients` (service-role / RLS deny-all). Helpers: `backend/ur_db.py`.

### 2. Backend env (used in code)

From `backend/ur_api.py`, `ur_relayer.py`, `ur_chain.py`, `server.py`:

| Var | Role |
|-----|------|
| `UR_ENV` | `testnet` (default) or `mainnet` — selects OpenAPI base URL + which signer/relayer key vars |
| `UR_PARTNER_ID` | Partner id for authenticated UR calls |
| `UR_API_SIGNER_PRIVKEY_TESTNET` / `UR_API_SIGNER_PRIVKEY_MAINNET` | EIP-191 partner signer (env-specific; do not reuse across envs) |
| `UR_RELAYER_PRIVKEY_TESTNET` or `UR_RELAYER_PRIVKEYS_TESTNET` (comma-separated) | Gas sponsors on testnet |
| `UR_RELAYER_PRIVKEY_MAINNET` or `UR_RELAYER_PRIVKEYS_MAINNET` | Gas sponsors on mainnet |
| `MANTLE_SEPOLIA_RPC_URL` / `MANTLE_MAINNET_RPC_URL` (or `MANTLE_RPC_URL`) | Mantle RPCs for chain ops |
| `UR_WEBHOOK_VERIFY` | Default on (`1`); set `0` only for local debugging |
| `UR_WEBHOOK_SIGNERS` | Optional extra allowed webhook signer addresses (comma-separated) |

OpenAPI bases (hardcoded defaults in `ur_api.py`):

- Testnet: `https://uropenapi-qa.ur-inc.xyz`
- Mainnet: `https://openapi.ur.app`

External v2 surface (cards / some flows), overridable:

- `UR_EXT_V2_BASE_URL_TESTNET` (default `https://urapi3-qa.ur-inc.xyz`)
- `UR_EXT_V2_BASE_URL_MAINNET` (default `https://api.ur.app`)

Relayer funding (from `ur_relayer.py`): native gas on chains it sponsors — **ETH on Arbitrum** (Add Money) and **MNT on Mantle** (FX). Withdraw/payout do not need that relayer funding (UR pays settlement).

### 3. Frontend

- Screens: `frontend/app/bank*.tsx`
- UI: `frontend/src/components/bank/`
- Client API: `frontend/src/lib/urApi.ts` → FastAPI `/api/ur/*`
- Provider: `frontend/src/providers/UrAccountProvider.tsx`
- Source chain for Add Money: `EXPO_PUBLIC_UR_SOURCE_CHAIN_ID` (`42161` = Arbitrum One; otherwise Arbitrum Sepolia in current code)
- Dev-only: `EXPO_PUBLIC_ENABLE_UR_TEST_WALLET_IMPORT=1` gates test wallet import (`AuthContext.tsx`)

### 4. Webhooks

Inbound UR webhooks are handled in `server.py` (verify + idempotent `ur_webhook_events`, then job/notification side effects). Point UR’s webhook config at your deployed backend URL (exact path as registered in your UR partner setup / code).

---

## Main API surface (FastAPI `/api/ur/*`)

Representative routes present in `server.py` (all scoped via Privy + `ur_links` where applicable):

| Area | Examples |
|------|----------|
| Link / profile | `GET/POST /ur/link`, `GET /ur/profile`, `GET /ur/balance`, `GET /ur/transactions` |
| Mint URID | `POST /ur/mint/prepare`, `POST /ur/mint` |
| KYC | `POST /ur/kyc/status`, `/ur/kyc/sumsub-token`, `/ur/kyc/form-a`, `/ur/kyc/form-a/submit` |
| Deposit (Add Money) | `/ur/deposit/currencies`, `/quote`, `/execute-7702`, `/7702/info` |
| Withdraw | `/ur/withdraw/info`, `/quote`, `/execute`, retry/liveness helpers |
| Payout (bank send) | `/ur/payout/*` |
| P2P transfer | `/ur/transfer/permit-info`, `/ur/transfer/execute` |
| FX | `/ur/fx/info`, `/quote`, `/execute-7702`, … |
| Card | `/ur/card/eligibility`, `/status`, `/create`, `/permit`, `/freeze`, `/currency` |
| Jobs | `/ur/jobs`, `/ur/jobs/{id}` |
| Statement | `/ur/statement/preview`, `/export` |

Banking inbox (webhook-fed): `/api/notifications/feed` (+ read helpers) over `ur_notifications`.

Job kinds in DB (`ur_db.py`): `deposit`, `withdraw`, `fx`, `payout`, `transfer`.

---

## Custody / compliance note (as implemented)

- Wallet USDC + Hyperliquid trading remain non-custodial UI over user keys (Privy).
- UR fiat tokens and IBAN/card rails are **partner-regulated**; KYC gates banking features.
- `ur_links.chain_status` / `kyc_current_step` are **analytics mirrors only** — authorization uses live UR API responses, not those columns.

---

## Rollout stages / how to disable

Builders use a **4-stage** UI path (full table in [FORKING.md](./FORKING.md) §3):

| Stage | Switches | User-facing |
|-------|----------|-------------|
| **0 — Off** | `EXPO_PUBLIC_ENABLE_BANKING=false` (default) | No banking UI (Wallet tab instead of Bank) |
| **1 — SOON / waitlist** | `ENABLE_BANKING=true` + `BANK_KYC_PAUSED=true` in `bankKycPause.ts` | Bank + guest pitch + email waitlist; **SOON** badge; no Start KYC |
| **2 — KYC live** | `ENABLE_BANKING=true` + `BANK_KYC_PAUSED=false` + `BANK_SERVICE_PAUSED=false` | Country selection → Start KYC when ready |
| **3 — Maintenance pause** | `ENABLE_BANKING=true` + `BANK_SERVICE_PAUSED=true` | **PAUSED** badge; guest banner + Follow on X; no new KYC |

Also for Stage 0 (or until partner is ready):

- Do not apply `ur_banking_v1.sql`
- Do not set `UR_PARTNER_ID` / signer / relayer keys

Leaving the code in the tree unused is fine for a trading-only fork.

---

## Key files

| Area | Path |
|------|------|
| Partner HTTP + env | `backend/ur_api.py` |
| Supabase helpers | `backend/ur_db.py` |
| Gas relayer | `backend/ur_relayer.py` |
| Chain IDs / contracts | `backend/ur_chain.py` |
| Webhook crypto | `backend/ur_webhook_crypto.py` |
| Routes | `backend/server.py` (`/ur/*`, webhook handlers) |
| SQL | `backend/migrations/ur_banking_v1.sql` |
| Mobile KYC | `frontend/src/lib/sumsubKyc.ts`, `useUrKyc.ts` |
| Mobile API | `frontend/src/lib/urApi.ts` |
