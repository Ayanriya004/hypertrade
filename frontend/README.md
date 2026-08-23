# HyperTrade — Mobile frontend

This is the **Expo / React Native** app. Start with the **[root README](../README.md)** and **[Setup guide](../docs/SETUP.md)** — not the default Expo template below.

## Quick commands

```bash
npm install
cp .env.example .env          # set EXPO_PUBLIC_BACKEND_URL, RPC URL
npx expo start --dev-client   # requires a dev build (Privy + native modules)
```

## Key paths

| Path | Purpose |
|------|---------|
| `app/` | Expo Router screens |
| `src/lib/hyperliquid.ts` | HL SDK, agent wallet, orders |
| `src/providers/` | Privy auth, builder config |
| `src/components/DepositPanel.tsx` | Bridge2 USDC deposits |

## Docs

- [Setup](../docs/SETUP.md)
- [HL builder integration](../docs/HL_BUILDER.md)
- [Environment vars](../docs/ENVIRONMENT.md)
- [Mobile store compliance](../docs/MOBILE_RELEASE.md)

---

<details>
<summary>Original Expo starter notes (collapsed)</summary>

This project uses [Expo Router](https://docs.expo.dev/router/introduction/) file-based routing under `app/`.

Learn more: [Expo documentation](https://docs.expo.dev/)

</details>
