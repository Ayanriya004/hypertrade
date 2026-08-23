# Mobile release & compliance

HyperTrade is a **native mobile** Hyperliquid builder reference app (Expo / React Native).
This doc covers store distribution — separate from HL integration itself.

---

## Expo credentials (quick)

Before store builds, in **Expo → Project settings → Credentials**:

- **Android → Application identifier** — must match `expo.android.package` in `frontend/app.json` (HyperTrade: `com.hypertrade.app`).
- **iOS** — bundle identifier must match `expo.ios.bundleIdentifier` (HyperTrade: `com.exchange.hypertrade`).
- **Google Service Account Keys** in Expo are for EAS/FCM/Play automation — separate from the Firebase **client** files `google-services.json` / `GoogleService-Info.plist` (see [SETUP.md](./SETUP.md) §10).

---

## Why mobile-first?

Most retail users discover and trade on phones. Hyperliquid's API and WS stack work well on mobile; the hard parts are **wallet UX**, **deposits**, **push alerts**, and **store policy** — which this repo demonstrates.

**You do not need to copy our full asset universe.** Many successful builder apps will be **niche**:

- Only commodities (gold, silver, oil)
- Only equities in one region
- Only a single HIP-3 deployer ecosystem
- Only demo/testnet for education

Fork the infra patterns; narrow the product surface.

---

## Store status (HyperTrade)

| Store | Status | Notes |
|-------|--------|-------|
| **Google Play** | [Live](https://play.google.com/store/apps/details?id=com.hypertrade.app) | Primary distribution today |
| **Apple App Store** | Not live yet | Perpetuals and leveraged products face stricter review |

Apple is especially cautious about **perpetual / leveraged trading** in consumer apps. Common mitigations (none guaranteed):

- Geo-restrictions and eligibility checks
- Clear risk disclosures and non-custodial wallet flows
- Removing or gating perps in certain jurisdictions

**Do your own legal review** before submitting a perps app to Apple.

---

## What builders should expect

Publishing to **Google Play** and **Apple App Store** means your product enters **regulated consumer app** territory, not just DeFi. A **web-only** fork can avoid store org checks — a **mobile** fork of this codebase generally cannot.

### Business license + D-U-N-S (plan for this)

Because of the **financial / trading** nature of the product, store review commonly expects:

- A **registered business** (LLC / Ltd / equivalent) — not a bare personal hobby listing for this category
- A **[D-U-N-S](https://www.dnb.com/duns.html) number** — **free** to request from Dun & Bradstreet; used widely for org verification (Apple Developer organization accounts; Google Play org / financial-feature flows). Available in **most countries**, so you can form an entity where you operate and still obtain one. Paid “expedite” upsells are optional — the standard D-U-N-S itself is not a paid license.

Budget **entity formation** + annual filings as the real launch cost (see [COSTS.md](./COSTS.md)); D-U-N-S is free once you have a business. Cheap formation providers exist in many jurisdictions; examples only (not endorsements, not legal advice):

- UK: [1st Formations](https://www.1stformations.co.uk/)
- US (e.g. Wyoming LLC): [Northwest Registered Agent](https://www.northwestregisteredagent.com/llc/wyoming) (state filing fees are separate — Wyoming Articles are on the order of **$100** + ongoing annual report minimums; see their / state pages)

### Non-custodial Hyperliquid interface (say it clearly)

In store listings, terms, and review questionnaires, state that you are a **non-custodial interface** to Hyperliquid:

- Users hold keys (e.g. via Privy); you are **not** a broker holding customer assets
- Orders / withdrawals are user-authorized on HL; your backend sponsors gas / ops where documented (Bridge2 relayer, optional neobank partner) — do not imply custody of trading balances

This is how HyperTrade positions the product. It does **not** remove geo, licensing, or store rules in every jurisdiction — get your own legal review.

### Geo-fencing (USA / OFAC-style blocks)

HyperTrade’s backend geo-fences restricted regions (including the **US**) for faster / cleaner store approval paths; `APPLE_REVIEW_BYPASS` exists for App Review testing. Forks that ship mobile financial UX are **advised to keep similar geo / sanctions controls** unless counsel says otherwise.

**Regulatory posture changes.** Re-check Play / Apple financial policies and your counsel’s guidance before each major release — what worked “as of today” for HyperTrade may not hold forever.

### Financial / trading regulation

Requirements vary by country and product (spot vs perps vs prediction markets). You may need:

- Consumer disclosures, terms of service, privacy policy
- Age gating where required
- Entity + tax identifiers / business bank account as stores and payment partners require

**Neobank / UR path:** you do **not** build a separate KYC/AML stack. **UR (Fiat24) covers KYC/AML**; this repo already wires the **Sumsub SDK** on device (`frontend/src/lib/sumsubKyc.ts`). User identity docs go to **UR / their KYC provider** — HyperTrade’s servers do **not** store those documents (backend only orchestrates tokens / status). See [BANKING_UR.md](./BANKING_UR.md).

### App store policies

- Google Play **Financial features** declaration
- Apple **Guideline 3.1** (payments) and crypto-related review questions
- Accurate metadata — no misleading "guaranteed returns"
- Export compliance (`ITSAppUsesNonExemptEncryption` in `app.json`)

### Operational

- **EAS Build** or local release pipelines for signed binaries
- Firebase (or alternative) for push on production builds
- Incident response if API keys or relayer wallets are compromised

---

## Minimum path vs full production

| Goal | What you need |
|------|----------------|
| **Local dev / internal TestFlight** | Privy, backend, Supabase, HL testnet, dev client |
| **Play Store (crypto trading)** | Business entity, D-U-N-S, Play Console, policies, signed AAB, backend prod, geo/disclosures |
| **App Store (crypto trading)** | Org Apple account, D-U-N-S, stricter review, often legal counsel |
| **Web-only fork** | Still need legal/tax judgment; store D-U-N-S path may not apply |
| **Card spend (Visa/MC)** | UR (or similar) partner — KYC/AML via UR + Sumsub SDK already in-repo; see [BANKING_UR.md](./BANKING_UR.md) |

---

## Disclaimer

This repository is **reference software**, not legal advice. Consult qualified counsel for licensing, tax, and securities law in every jurisdiction you serve.
