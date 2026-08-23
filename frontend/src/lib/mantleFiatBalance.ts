/**
 * Mantle fiat-token balance reads — authoritative spendable amounts for
 * External Wallet Access flows (Convert, Send, Withdraw, P2P).
 *
 * Supports Mantle Sepolia (5003) and Mantle mainnet (5000). The active
 * chain comes from `/ur/fx/info` (`chain_id`); env vars pick the RPC.
 */
import Constants from 'expo-constants';
import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  type Chain,
  type PublicClient,
} from 'viem';

export const MANTLE_MAINNET_CHAIN_ID = 5000;
export const MANTLE_SEPOLIA_CHAIN_ID = 5003;
export const FIAT_TOKEN_DECIMALS = 2;

const expoExtra =
  (Constants.expoConfig?.extra as Record<string, string | undefined> | undefined) ??
  ((Constants as unknown as { manifest2?: { extra?: Record<string, string | undefined> } })
    .manifest2?.extra) ??
  ((Constants as unknown as { manifest?: { extra?: Record<string, string | undefined> } }).manifest
    ?.extra);

export const MANTLE_MAINNET_RPC_URL =
  process.env.EXPO_PUBLIC_MANTLE_RPC_URL ||
  expoExtra?.EXPO_PUBLIC_MANTLE_RPC_URL ||
  'https://rpc.mantle.xyz';

export const MANTLE_SEPOLIA_RPC_URL =
  process.env.EXPO_PUBLIC_MANTLE_SEPOLIA_RPC_URL ||
  expoExtra?.EXPO_PUBLIC_MANTLE_SEPOLIA_RPC_URL ||
  'https://rpc.sepolia.mantle.xyz';

/** Default when `/ur/fx/info` has not returned yet. Override via env for prod builds. */
export function getDefaultMantleChainId(): number {
  const raw =
    process.env.EXPO_PUBLIC_MANTLE_CHAIN_ID || expoExtra?.EXPO_PUBLIC_MANTLE_CHAIN_ID;
  const n = Number(raw);
  if (n === MANTLE_MAINNET_CHAIN_ID || n === MANTLE_SEPOLIA_CHAIN_ID) return n;
  return MANTLE_SEPOLIA_CHAIN_ID;
}

export function isMantleChainId(chainId: number): boolean {
  return chainId === MANTLE_MAINNET_CHAIN_ID || chainId === MANTLE_SEPOLIA_CHAIN_ID;
}

export function resolveMantleChainId(chainId?: number | null): number {
  if (chainId != null && isMantleChainId(chainId)) return chainId;
  return getDefaultMantleChainId();
}

export function getMantleRpcUrl(chainId: number): string {
  return chainId === MANTLE_MAINNET_CHAIN_ID
    ? MANTLE_MAINNET_RPC_URL
    : MANTLE_SEPOLIA_RPC_URL;
}

export function getMantleChain(chainId: number): Chain {
  const id = resolveMantleChainId(chainId);
  if (id === MANTLE_MAINNET_CHAIN_ID) {
    return defineChain({
      id: MANTLE_MAINNET_CHAIN_ID,
      name: 'Mantle',
      nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
      rpcUrls: { default: { http: [MANTLE_MAINNET_RPC_URL] } },
      blockExplorers: {
        default: { name: 'Mantle Explorer', url: 'https://mantlescan.xyz' },
      },
    });
  }
  return defineChain({
    id: MANTLE_SEPOLIA_CHAIN_ID,
    name: 'Mantle Sepolia',
    nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
    rpcUrls: { default: { http: [MANTLE_SEPOLIA_RPC_URL] } },
    blockExplorers: {
      default: { name: 'Mantle Sepolia Explorer', url: 'https://sepolia.mantlescan.xyz' },
    },
    testnet: true,
  });
}

const publicClientCache = new Map<number, PublicClient>();

export function getMantlePublicClient(chainId?: number | null): PublicClient {
  const id = resolveMantleChainId(chainId);
  let client = publicClientCache.get(id);
  if (!client) {
    client = createPublicClient({
      chain: getMantleChain(id),
      transport: http(getMantleRpcUrl(id), {
        timeout: 12_000,
        retryCount: 2,
        retryDelay: 300,
      }),
    });
    publicClientCache.set(id, client);
  }
  return client;
}

/** @deprecated Prefer `getMantlePublicClient(chainId)` — defaults to env/testnet. */
export const MANTLE_SEPOLIA_CHAIN = getMantleChain(MANTLE_SEPOLIA_CHAIN_ID);

/** @deprecated Prefer `getMantlePublicClient(chainId)`. */
export const mantlePublicClient = getMantlePublicClient();

export const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface SpendableFiatBalance {
  raw: bigint;
  amount: number;
  amountStr: string;
}

export function fiatSymbolToTokenKey(currency: string): string {
  return `${currency.toUpperCase()}24`;
}

export function tokenKeyToFiatSymbol(key: string): string {
  return key.replace(/24$/i, '').toUpperCase();
}

export function floorFiatHuman(n: number, decimals = FIAT_TOKEN_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.floor(n * factor) / factor;
}

export function formatFiatRawHuman(raw: bigint, decimals = FIAT_TOKEN_DECIMALS): string {
  const human = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(human)) return '0.00';
  return floorFiatHuman(human, decimals).toFixed(decimals);
}

export function humanFromRaw(raw: bigint, decimals = FIAT_TOKEN_DECIMALS): number {
  return floorFiatHuman(Number(formatUnits(raw, decimals)), decimals);
}

export function spendableFromRaw(raw: bigint): SpendableFiatBalance {
  return {
    raw,
    amount: humanFromRaw(raw),
    amountStr: formatFiatRawHuman(raw),
  };
}

export const ZERO_SPENDABLE = spendableFromRaw(0n);
