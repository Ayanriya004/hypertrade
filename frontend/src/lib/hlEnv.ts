/**
 * Hyperliquid environment routing.
 *
 * Single source of truth for which HL endpoint, signing chainId, and bridge
 * the app talks to. Reads the current `tradingEnv` ('mainnet' | 'demo') from
 * the app store and exposes synchronous getters so non-React modules (the SDK
 * transport singleton, raw `fetch` callers, EIP-712 signers, the WebSocket
 * provider) can branch without React lifecycle.
 *
 * Demo mode points the entire HL stack at testnet — same SDK, same signing
 * shape, just different endpoints.
 *
 * User-signed actions (approveAgent, builder fee, usdClassTransfer, …) use
 * `signatureChainId` = the wallet's *active* chain. Hyperliquid accepts any
 * value as long as it matches the EIP-712 domain; `hyperliquidChain` binds
 * Mainnet vs Testnet. Official HL UI sends Arbitrum One `0xa4b1`. Hardcoding
 * `0x66eee` (Sepolia) makes MetaMask / WalletConnect reject while the user
 * is correctly on Arbitrum. L1 order signing still uses phantom chain 1337
 * via the local agent key — never the browser wallet.
 */

import { getTradingEnvSync, subscribeTradingEnv, type TradingEnv } from '../store/appStore';

const HL_MAINNET_API_URL = 'https://api.hyperliquid.xyz';
const HL_TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
const HL_MAINNET_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HL_TESTNET_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

// Fallback EIP-712 domain chainId for user-signed HL actions when the wallet
// cannot report `eth_chainId`. Live: Arbitrum One. Demo: Arbitrum Sepolia
// (typical testnet wallet). Prefer reading the wallet's active chain instead.
const HL_USER_SIGNED_CHAIN_ID_MAINNET = '0xa4b1' as const;
const HL_USER_SIGNED_CHAIN_ID_TESTNET = '0x66eee' as const;

export function getTradingEnv(): TradingEnv {
  return getTradingEnvSync();
}

export function isDemoEnv(): boolean {
  return getTradingEnvSync() === 'demo';
}

export function getHlApiUrl(): string {
  return isDemoEnv() ? HL_TESTNET_API_URL : HL_MAINNET_API_URL;
}

export function getHlInfoUrl(): string {
  return `${getHlApiUrl()}/info`;
}

export function getHlExchangeUrl(): string {
  return `${getHlApiUrl()}/exchange`;
}

export function getHlWsUrl(): string {
  return isDemoEnv() ? HL_TESTNET_WS_URL : HL_MAINNET_WS_URL;
}

/** Fallback EIP-712 chainId for user-signed HL actions (wallet chain unknown). */
export function getHlExchangeSignatureChainId(): `0x${string}` {
  return isDemoEnv() ? HL_USER_SIGNED_CHAIN_ID_TESTNET : HL_USER_SIGNED_CHAIN_ID_MAINNET;
}

/** Same fallback as other user-signed actions (withdraw3 included). */
export function getHlWithdrawSignatureChainId(): `0x${string}` {
  return getHlExchangeSignatureChainId();
}

/** True iff the SDK transport should be constructed with `isTestnet: true`. */
export function shouldUseTestnetTransport(): boolean {
  return isDemoEnv();
}

/**
 * Subscribe to env changes. Use this from non-React modules (SDK transport,
 * WS provider) to invalidate caches and rebuild connections on switch.
 * Returns an unsubscribe function.
 */
export function onTradingEnvChange(cb: (env: TradingEnv) => void): () => void {
  return subscribeTradingEnv(cb);
}

/**
 * Helper to namespace storage / cache keys by env so a user switching modes
 * never reads a key written under the other mode (e.g. an agent key approved
 * on mainnet must not be reused on testnet — HL would reject the signature).
 */
export function envScopedKey(baseKey: string, env: TradingEnv = getTradingEnvSync()): string {
  return `${baseKey}_${env}`;
}
