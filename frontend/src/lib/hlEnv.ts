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
 * shape, just different endpoints. The signing chainId on testnet is the same
 * `0x66eee` value as mainnet because HL's signing domain chainId is fixed
 * across networks (per HL docs); the SDK's `isTestnet` flag is what selects
 * the actual API URL.
 */

import { getTradingEnvSync, subscribeTradingEnv, type TradingEnv } from '../store/appStore';

const HL_MAINNET_API_URL = 'https://api.hyperliquid.xyz';
const HL_TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
const HL_MAINNET_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HL_TESTNET_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

// HL signing domain chainId — fixed across mainnet and testnet for exchange
// actions. Bridge2 withdrawals sign against the L1 chainId (Arbitrum mainnet
// 0xa4b1, or Arbitrum Sepolia 0x66eee for testnet bridges).
const HL_EXCHANGE_SIGNATURE_CHAIN_ID = '0x66eee' as const;
const HL_WITHDRAW_SIGNATURE_CHAIN_ID_MAINNET = '0xa4b1' as const; // Arbitrum One
const HL_WITHDRAW_SIGNATURE_CHAIN_ID_TESTNET = '0x66eee' as const; // Arbitrum Sepolia

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

/** EIP-712 domain chainId for HL exchange actions (order, cancel, agent, usdSend, etc.). */
export function getHlExchangeSignatureChainId(): `0x${string}` {
  return HL_EXCHANGE_SIGNATURE_CHAIN_ID;
}

/** EIP-712 domain chainId for HL Bridge2 withdraw actions. */
export function getHlWithdrawSignatureChainId(): `0x${string}` {
  return isDemoEnv()
    ? HL_WITHDRAW_SIGNATURE_CHAIN_ID_TESTNET
    : HL_WITHDRAW_SIGNATURE_CHAIN_ID_MAINNET;
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
