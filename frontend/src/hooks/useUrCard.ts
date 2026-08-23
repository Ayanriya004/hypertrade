/**
 * useUrCard — card eligibility / metadata / freeze driven by wallet Full-Auth.
 *
 * The card endpoints (UR `/api/v2/br`, `/api/v2/card`, `/api/v2/card-status`)
 * need the same Full-Auth signature as withdraw/KYC AND a KYC-Live URID with an
 * issued card. Until a card exists they 404 (mapped to a read error by the
 * backend), so we treat "no card" as a gate (`available=false`) rather than a
 * hard error.
 *
 * Card APIs and on-chain fiat tokens are **Mantle mainnet only** (UR does not
 * issue cards on Sepolia). Full-Auth signatures and EIP-2612 permits use
 * chain id 5000.
 *
 * Fetches are LAZY (triggered by a user tapping View/Settings/Freeze) so we
 * never prompt for a wallet signature just because the Card tab was opened.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import Constants from 'expo-constants';
import { useEmbeddedEthereumWallet } from '@privy-io/expo';
import {
  createWalletClient,
  custom,
  defineChain,
  type Hex,
  type WalletClient,
} from 'viem';

import { useAuth } from '../providers/AuthContext';
import { useUrAccount } from '../providers/UrAccountProvider';
import { buildFullAuth, signOnrampPermit } from '../lib/urOnrampAuth';
import {
  createUrCard,
  fetchUrCardEligibility,
  fetchUrCardStatus,
  fetchUrProfile,
  prepareUrCardPermit,
  setUrCardCurrency,
  setUrCardFrozen,
  submitUrCardPermit,
  type UrCard,
  type UrExtAuth,
} from '../lib/urApi';
import { normalizeUrCardLimits, type UrCardLimitsBuckets } from '../lib/urCardLimits';

/** Card spend tokens: UR lists RMB on the card; on-chain/ledger code is CNH. */
const CARD_FIAT_CURRENCIES = ['USD', 'EUR', 'CHF', 'CNH'] as const;
/** Practical unlimited card-spend approval (2 dp). */
const CARD_PERMIT_AMOUNT = '99999999.99';

const expoExtra =
  (Constants.expoConfig?.extra as Record<string, string | undefined> | undefined) ??
  ((Constants as unknown as { manifest2?: { extra?: Record<string, string | undefined> } }).manifest2?.extra) ??
  ((Constants as unknown as { manifest?: { extra?: Record<string, string | undefined> } }).manifest?.extra);
const MANTLE_MAINNET_RPC_URL =
  process.env.EXPO_PUBLIC_MANTLE_RPC_URL ||
  expoExtra?.EXPO_PUBLIC_MANTLE_RPC_URL ||
  'https://rpc.mantle.xyz';
const MANTLE_MAINNET_CHAIN_ID = 5000;

const mantleMainnetChain = defineChain({
  id: MANTLE_MAINNET_CHAIN_ID,
  name: 'Mantle',
  nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
  rpcUrls: { default: { http: [MANTLE_MAINNET_RPC_URL] } },
});

export interface UseUrCard {
  /** True once card data has been loaded at least once. */
  loaded: boolean;
  loading: boolean;
  /** A card has been issued for this URID (gate for View/Freeze). */
  available: boolean;
  /** UR says the URID may apply for a card (debitCard set / isCardEligible). */
  eligible: boolean;
  card: UrCard | null;
  /** CHF limit buckets from `GET /api/v2/card` (null until loaded / on testnet). */
  limits: UrCardLimitsBuckets | null;
  /** "MSTD" (Fiat-Only) | "MSTC" (Crypto-Backed) | undefined. */
  brand: string | undefined;
  frozen: boolean;
  error: string | null;
  /** Loads card data (prompts a wallet signature); resolves to `available`. */
  loadCard: () => Promise<boolean>;
  setFrozen: (frozen: boolean) => Promise<boolean>;
  /** Issue a new virtual card (UR §3.1.2). Reloads card state on success. */
  createCard: () => Promise<boolean>;
  /** Set the card's default transaction currency (UR §3.1.5). */
  setCurrency: (currency: string) => Promise<boolean>;
  /** True while default currency is being saved. */
  currencyBusy: boolean;
  /** Authorize missing on-chain card spend allowances (EIP-2612 permits). */
  ensureCardAllowances: () => Promise<void>;
}

function pickCard(cards: UrCard[] | undefined, fallback?: UrCard): UrCard | null {
  if (cards && cards.length > 0) return cards[0];
  if (fallback && (fallback.cardTokenId || fallback.cardToken || fallback.last4 || fallback.panLast4)) {
    return fallback;
  }
  return null;
}

/** Last 4 PAN digits from UR's masked card number ("•••• 5083" → "5083"). */
function deriveLast4(c: UrCard): string | undefined {
  const masked = c.masked?.cardNumber;
  if (typeof masked === 'string') {
    const digits = masked.replace(/[^0-9]/g, '');
    if (digits.length >= 4) return digits.slice(-4);
  }
  return c.last4 || c.panLast4 || undefined;
}

/**
 * Normalise UR's `/api/v2/card` (Fiat24 forwarding base) payload into our
 * `UrCard` shape. The card object may arrive flat (top-level masked/cardHolder/
 * tokenId/limits) or wrapped in `{cards:[…]}`; map both, and lift the Fiat24
 * `tokenId` into `cardTokenId` (freeze/status) and keep `externalId` (currency).
 */
function normalizeUrCard(raw: (UrCard & { cards?: UrCard[] }) | null | undefined): UrCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const base: UrCard =
    Array.isArray(raw.cards) && raw.cards.length > 0 ? raw.cards[0] : (raw as UrCard);
  const hasCard = Boolean(
    base.masked || base.cardToken || base.tokenId || base.last4 || base.panLast4 || base.cardHolder,
  );
  if (!hasCard) return null;
  const cardTokenId =
    base.cardTokenId ?? (base.tokenId != null ? String(base.tokenId) : undefined);
  const externalId =
    base.externalId != null && String(base.externalId).trim()
      ? String(base.externalId)
      : undefined;
  return {
    ...base,
    cardTokenId,
    externalId,
    last4: deriveLast4(base),
  };
}

/** True when UR's status / security flags indicate the card is frozen/blocked. */
function isCardFrozen(c: UrCard | null): boolean {
  if (!c) return false;
  const status = String(c.status ?? '').toLowerCase();
  if (status === 'frozen' || status === 'blocked') return true;
  return Boolean(c.frozen);
}

export function useUrCard(): UseUrCard {
  const { getAccessToken, walletAddress } = useAuth();
  const { link, profile } = useUrAccount();
  const { wallets } = useEmbeddedEthereumWallet();

  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [card, setCard] = useState<UrCard | null>(null);
  const [limits, setLimits] = useState<UrCardLimitsBuckets | null>(null);
  const [brand, setBrand] = useState<string | undefined>(undefined);
  const [frozen, setFrozenState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currencyBusy, setCurrencyBusy] = useState(false);
  const allowancesEnsuredRef = useRef(false);

  /** On-chain / linked URID owner — Full-Auth must be signed by this EOA. */
  const urOwnerAddress = useMemo(() => {
    const fromProfile = profile?.evmAddress?.trim();
    const fromLink = link?.evm_address?.trim();
    const raw = fromProfile || fromLink || null;
    return raw ? raw.toLowerCase() : null;
  }, [profile?.evmAddress, link?.evm_address]);

  /**
   * Prefer the URID-owner wallet when it is among Privy embedded wallets.
   * Avoids signing with wallets[0] after logout/relogin when multiple
   * embedded EOAs exist (dev test-wallet import, rare multi-wallet prod).
   */
  const signingAddress = useMemo(() => {
    if (!wallets || wallets.length === 0) return null;
    const find = (addr: string | null | undefined) => {
      if (!addr) return undefined;
      const target = addr.toLowerCase();
      return wallets.find((w) => w.address.toLowerCase() === target);
    };
    const ownerWallet = find(urOwnerAddress);
    if (ownerWallet) return ownerWallet.address;
    const authWallet = find(walletAddress);
    if (authWallet) return authWallet.address;
    return wallets[0]?.address ?? null;
  }, [wallets, urOwnerAddress, walletAddress]);

  const wallet = useMemo(() => {
    if (!wallets || wallets.length === 0 || !signingAddress) return undefined;
    const target = signingAddress.toLowerCase();
    return wallets.find((w) => w.address.toLowerCase() === target);
  }, [wallets, signingAddress]);

  const createCardWalletClient = useCallback(async (): Promise<WalletClient> => {
    if (!wallet || !signingAddress) {
      if (urOwnerAddress && wallets && wallets.length > 0) {
        const hasOwner = wallets.some(
          (w) => w.address.toLowerCase() === urOwnerAddress,
        );
        if (!hasOwner) {
          throw new Error(
            'URID owner wallet is not available in this session. Wait for wallet import or re-login.',
          );
        }
      }
      throw new Error('Wallet not ready');
    }
    if (__DEV__) {
      console.log('[useUrCard] signing wallet', {
        urOwnerAddress,
        authWalletAddress: walletAddress,
        signingAddress,
        embeddedProviderAddress: wallet.address,
        embeddedAddrs: wallets.map((w) => w.address),
        preferredOwner:
          !!urOwnerAddress &&
          signingAddress.toLowerCase() === urOwnerAddress,
      });
    }
    const provider = await wallet.getProvider();
    return createWalletClient({
      account: signingAddress as Hex,
      chain: mantleMainnetChain,
      transport: custom(provider),
    });
  }, [wallet, signingAddress, urOwnerAddress, walletAddress, wallets]);

  const signFullAuth = useCallback(async (): Promise<UrExtAuth> => {
    if (!signingAddress) throw new Error('Wallet not ready');
    const client = await createCardWalletClient();
    const auth = await buildFullAuth(client, signingAddress as Hex, { businessHash: 'CardReq' });
    if (__DEV__) {
      console.log('[useUrCard] Full-Auth signed', {
        accountPassedToSign: signingAddress,
        urOwnerAddress,
        hash: auth.hash,
        deadline: auth.deadline,
      });
    }
    return auth;
  }, [createCardWalletClient, signingAddress, urOwnerAddress]);

  const buildWalletClient = createCardWalletClient;

  const allowancesInFlightRef = useRef(false);

  const ensureCardAllowances = useCallback(async (): Promise<void> => {
    if (!signingAddress || allowancesEnsuredRef.current || allowancesInFlightRef.current) return;
    allowancesInFlightRef.current = true;
    try {
      const token = await getAccessToken();
      if (!token) return;
      const profileData = await fetchUrProfile(token);
      const allowances = profileData.data?.allowances ?? [];
      const missing = CARD_FIAT_CURRENCIES.filter((ccy) => {
        const row = allowances.find(
          (a) => (a.tokenSymbol ?? '').replace(/24$/i, '').toUpperCase() === ccy,
        );
        return !row?.hasAllowance;
      });
      if (missing.length === 0) {
        allowancesEnsuredRef.current = true;
        return;
      }
      const client = await buildWalletClient();
      // Docs §3.1.8 curl uses hash=PermitReq for /api/v1/token-permit.
      const auth = await buildFullAuth(client, signingAddress as Hex, {
        businessHash: 'PermitReq',
      });
      for (const ccy of missing) {
        const prep = await prepareUrCardPermit(token, {
          auth,
          currency: ccy,
          amount: CARD_PERMIT_AMOUNT,
          owner_address: signingAddress,
        });
        const permit = prep.permit;
        if (!permit.name || !permit.version || permit.nonce == null) {
          throw new Error(`Card permit unavailable for ${ccy}`);
        }
        const permitDeadline = Math.floor(Date.now() / 1000) + 3600;
        const sig = await signOnrampPermit(client, {
          account: signingAddress as Hex,
          token: permit.token as Hex,
          spender: permit.spender as Hex,
          value: BigInt(permit.value),
          deadline: permitDeadline,
          chainId: permit.chain_id,
          name: permit.name,
          version: permit.version,
          nonce: permit.nonce,
        });
        await submitUrCardPermit(token, {
          auth,
          currency: ccy,
          permit: {
            owner: signingAddress,
            spender: permit.spender,
            value: permit.value,
            deadline: permitDeadline,
            v: sig.v,
            r: sig.r,
            s: sig.s,
          },
        });
      }
      allowancesEnsuredRef.current = true;
    } catch (err: unknown) {
      // Stop hammering UR for this session on missing-route / rate-limit /
      // already-allowed echoes. View/reveal must not keep retrying permits.
      const status = (err as { response?: { status?: number } })?.response?.status;
      const detail = String(
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { message?: string })?.message ?? '',
      ).toLowerCase();
      if (
        status === 404 ||
        status === 429 ||
        detail.includes('page not found') ||
        detail.includes('too frequent') ||
        detail.includes('exists allowance')
      ) {
        allowancesEnsuredRef.current = true;
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[useUrCard] ensureCardAllowances failed:', err);
      }
    } finally {
      allowancesInFlightRef.current = false;
    }
  }, [signingAddress, getAccessToken, buildWalletClient]);

  const loadCard = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const auth = await signFullAuth();
      const elig = await fetchUrCardEligibility(token, { auth });
      const result = elig.result || {};
      setBrand(typeof result.debitCard === 'string' ? result.debitCard : undefined);
      setEligible(Boolean(result.isCardEligible) || Boolean(result.debitCard));
      let resolved = pickCard(result.cards);
      // Always pull /card for full metadata (masked PAN, holder, limits, +
      // cardToken). The Fiat24 base returns the card even when /br doesn't list
      // it, so a successful /card response is itself proof a card exists.
      try {
        const status = await fetchUrCardStatus(token, { auth });
        const normalized = normalizeUrCard(status.result);
        if (normalized) {
          resolved = resolved ? { ...resolved, ...normalized } : normalized;
        }
      } catch {
        // /card is best-effort; fall back to whatever /br listed (if anything).
      }
      setCard(resolved);
      setLimits(normalizeUrCardLimits(resolved?.limits));
      setAvailable(Boolean(resolved));
      setFrozenState(isCardFrozen(resolved));
      // Do NOT run spend-permit here — View/reveal only needs /card status +
      // cardToken. Permit side-effects were racing View and rate-limiting UR.
      return Boolean(resolved);
    } catch (err: unknown) {
      // A Fiat24 404 / read error just means "no card yet" — gate, don't alarm.
      setAvailable(false);
      setCard(null);
      setLimits(null);
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? '';
      setError(String(msg) || null);
      return false;
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [getAccessToken, signFullAuth]);

  const setFrozen = useCallback(
    async (next: boolean): Promise<boolean> => {
      const cardTokenId = card?.cardTokenId || (card?.cardToken as string | undefined);
      if (!available || !cardTokenId) {
        // No issued card: optimistic local toggle only (demo / pre-KYC-Live).
        setFrozenState(next);
        return false;
      }
      // Optimistic UI; revert on failure.
      setFrozenState(next);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const auth = await signFullAuth();
        await setUrCardFrozen(token, { auth, card_token_id: String(cardTokenId), frozen: next });
        return true;
      } catch (err: unknown) {
        setFrozenState(!next);
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { message?: string })?.message ?? 'freeze_failed';
        setError(String(msg));
        throw err;
      }
    },
    [available, card, getAccessToken, signFullAuth],
  );

  const createCard = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const auth = await signFullAuth();
      await createUrCard(token, { auth });
      // Card issued — reload metadata so `available`/`card` reflect it.
      const ok = await loadCard();
      // Spend permits are NOT part of View/reveal; only after create.
      if (ok) void ensureCardAllowances();
      return ok;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? 'card_create_failed';
      setError(String(msg));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [getAccessToken, signFullAuth, loadCard, ensureCardAllowances]);

  const setCurrency = useCallback(
    async (currency: string): Promise<boolean> => {
      const cardExternalId = card?.externalId;
      if (!available || !cardExternalId) return false;
      setCurrencyBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        const auth = await signFullAuth();
        await setUrCardCurrency(token, {
          auth,
          card_external_id: String(cardExternalId),
          currency: currency.toUpperCase(),
        });
        setCard((prev) => (prev ? { ...prev, currency: currency.toUpperCase() } : prev));
        return true;
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { message?: string })?.message ?? 'card_currency_failed';
        setError(String(msg));
        throw err;
      } finally {
        setCurrencyBusy(false);
      }
    },
    [available, card, getAccessToken, signFullAuth],
  );

  return {
    loaded,
    loading,
    available,
    eligible,
    card,
    limits,
    brand,
    frozen,
    error,
    loadCard,
    setFrozen,
    createCard,
    setCurrency,
    currencyBusy,
    ensureCardAllowances,
  };
}
