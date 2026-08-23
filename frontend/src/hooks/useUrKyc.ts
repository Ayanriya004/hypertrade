/**
 * useUrKyc — self-serve Sumsub KYC driven by the user's wallet Full-Auth.
 *
 * UR's Client-side KYC endpoints accept the same Full-Auth headers we sign for
 * withdraw/payout (no partner whitelisting). This hook:
 *   - reads the current KYC step / Sumsub review answer (gate the UI)
 *   - signs Full-Auth once, mints a Sumsub SDK token, launches the SDK, and
 *     re-reads status when the flow closes.
 *
 * The actual SDK only runs in a dev/production build (NFC needs the native
 * module); `sdkAvailable` is false in Expo Go and `startVerification` rejects
 * with a SUMSUB_SDK_UNAVAILABLE error the caller can surface.
 */
import { useCallback, useMemo, useState } from 'react';
import { useEmbeddedEthereumWallet } from '@privy-io/expo';
import {
  createWalletClient,
  custom,
  type Hex,
  type WalletClient,
} from 'viem';

import { useAuth } from '../providers/AuthContext';
import { buildFullAuth } from '../lib/urOnrampAuth';
import { getMantleChain, getDefaultMantleChainId } from '../lib/mantleFiatBalance';
import {
  fetchUrKycStatus,
  createUrSumsubToken,
  fetchUrFormA,
  submitUrFormA,
  prepareUrMint,
  submitUrMint,
  type UrKycStatusResponse,
  type UrExtAuth,
} from '../lib/urApi';
import { isSumsubAvailable, launchSumsubKyc, classifyKycOutcome, type SumsubLaunchResult } from '../lib/sumsubKyc';
import {
  AppsFlyerAnalytics,
  type KycStartSource,
} from '../lib/appsFlyerAnalytics';

/** Thrown when a mint is needed but the Privy account has no email on file. */
export const MINT_EMAIL_REQUIRED = 'MINT_EMAIL_REQUIRED';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A just-minted URID isn't readable on-chain for a few seconds, so UR's
 * Sumsub-token endpoint (and our own ownership re-check) can transiently fail
 * right after the first-ever mint. These detail fragments mark that
 * "confirming on-chain" window — safe to retry, not a hard error.
 */
const URID_NOT_READY_PATTERNS = [
  'verify ur account ownership',
  'verify wallet ownership',
  'sumsub token unavailable',
  'kyc flow not found',
  'no ur account linked',
  're-link your account',
];

function isUridConfirmingError(err: unknown): boolean {
  const detail =
    (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
    (err as { message?: string })?.message ?? '';
  const lower = String(detail).toLowerCase();
  return URID_NOT_READY_PATTERNS.some((p) => lower.includes(p));
}

export interface UseUrKyc {
  status: UrKycStatusResponse | null;
  loading: boolean;
  launching: boolean;
  error: string | null;
  sdkAvailable: boolean;
  refresh: () => Promise<UrKycStatusResponse | null>;
  /** Launch Sumsub; resolves with the SDK close result plus the freshly
   *  re-read UR status (the authoritative review answer drives messaging). */
  startVerification: (
    source?: KycStartSource,
    options?: { email?: string },
  ) => Promise<SumsubLaunchResult & { kycStatus?: UrKycStatusResponse | null }>;
  /** Complete KYC step 3 (SignFormA): fetch the Form A text, wallet-sign it,
   *  submit, then re-read status. Resolves with the refreshed UR status. */
  signFormA: () => Promise<UrKycStatusResponse | null>;
  /** Lazily mint (or adopt) the caller's URID. Returns the URID. */
  ensureUrid: (options?: { email?: string }) => Promise<number>;
}

export function useUrKyc(): UseUrKyc {
  const { getAccessToken, walletAddress, user } = useAuth();
  const { wallets } = useEmbeddedEthereumWallet();

  const [status, setStatus] = useState<UrKycStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return undefined;
    if (!walletAddress) return wallets[0];
    const target = walletAddress.toLowerCase();
    return wallets.find((w) => w.address.toLowerCase() === target) ?? wallets[0];
  }, [wallets, walletAddress]);

  // Sign one Full-Auth set (personal_sign) from the URID-owning wallet.
  const signFullAuth = useCallback(async (): Promise<UrExtAuth> => {
    if (!wallet || !walletAddress) throw new Error('Wallet not ready');
    const provider = await wallet.getProvider();
    const client: WalletClient = createWalletClient({
      account: walletAddress as Hex,
      chain: getMantleChain(getDefaultMantleChainId()),
      transport: custom(provider),
    });
    return buildFullAuth(client, walletAddress as Hex);
  }, [wallet, walletAddress]);

  // Personal_sign (EIP-191) an arbitrary message from the URID-owning wallet.
  // Used to sign the mint authorization the backend hands us.
  const signMessageWithWallet = useCallback(
    async (message: string): Promise<Hex> => {
      if (!wallet || !walletAddress) throw new Error('Wallet not ready');
      const provider = await wallet.getProvider();
      const client: WalletClient = createWalletClient({
        account: walletAddress as Hex,
        chain: getMantleChain(getDefaultMantleChainId()),
        transport: custom(provider),
      });
      return client.signMessage({ account: walletAddress as Hex, message });
    },
    [wallet, walletAddress],
  );

  // Lazy, idempotent URID provisioning. Short-circuits when the caller already
  // has a URID (linked OR on-chain); otherwise signs the backend-issued mint
  // message with the Privy embedded wallet (silent — no user prompt) and
  // submits it. Safe to call repeatedly.
  const ensureUrid = useCallback(async (options?: { email?: string }): Promise<number> => {
    if (!walletAddress) throw new Error('Wallet not ready');
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const prep = await prepareUrMint(token, walletAddress);
    if (prep.already_minted && prep.ur_id != null) return prep.ur_id;
    if (!prep.message || !prep.hash || prep.deadline == null) {
      throw new Error('Mint preparation incomplete');
    }

    const email = (options?.email ?? user?.email)?.trim();
    if (!email) throw new Error(MINT_EMAIL_REQUIRED);

    const signature = await signMessageWithWallet(prep.message);
    const res = await submitUrMint(token, {
      evm_address: prep.evm_address ?? walletAddress,
      email,
      signature,
      hash: prep.hash,
      deadline: prep.deadline,
    });
    return res.ur_id;
  }, [walletAddress, user?.email, getAccessToken, signMessageWithWallet]);

  const refresh = useCallback(async (): Promise<UrKycStatusResponse | null> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const auth = await signFullAuth();
      const resp = await fetchUrKycStatus(token, { auth });
      setStatus(resp);
      return resp;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? 'status_failed';
      setError(String(msg));
      return null;
    } finally {
      setLoading(false);
    }
  }, [getAccessToken, signFullAuth]);

  const startVerification = useCallback(async (
    source: KycStartSource = 'unknown',
    options?: { email?: string },
  ): Promise<SumsubLaunchResult & { kycStatus?: UrKycStatusResponse | null }> => {
    if (!isSumsubAvailable()) {
      throw new Error('SUMSUB_SDK_UNAVAILABLE');
    }
    setLaunching(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      await ensureUrid({ email: options?.email });
      void AppsFlyerAnalytics.logKycStarted(source);
      // The Sumsub token is partner-auth and resolves the URID from our
      // freshly persisted link. On a first-ever mint the tx needs a few
      // seconds to confirm on-chain before UR's profile/walletProvider reflect
      // it, so the token (and our ownership re-check) can transiently fail.
      // Retry briefly with backoff so the user doesn't have to tap twice.
      let mint: Awaited<ReturnType<typeof createUrSumsubToken>> | null = null;
      const MAX_TOKEN_ATTEMPTS = 8;
      for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
        try {
          mint = await createUrSumsubToken(token);
          break;
        } catch (tokenErr) {
          if (attempt < MAX_TOKEN_ATTEMPTS && isUridConfirmingError(tokenErr)) {
            await sleep(1300 * attempt); // 1.3s,2.6s,…,9.1s (~36s total)
            continue;
          }
          throw tokenErr;
        }
      }
      if (!mint) throw new Error('Sumsub token unavailable');

      const result = await launchSumsubKyc({
        accessToken: mint.token,
        getFreshToken: async () => {
          // Re-mint on token expiry (long verifications) — still no signature.
          const fresh = await createUrSumsubToken(token);
          return fresh.token;
        },
      });
      // Re-read status after the SDK closes so the UI gate updates and the
      // caller can message off UR's authoritative review answer.
      const kycStatus = await refresh();
      const outcome = classifyKycOutcome({
        reviewAnswer: kycStatus?.sumsub?.review_answer,
        rejectType: kycStatus?.sumsub?.review_reject_type,
        sdkStatus: result?.status,
      });
      // Only count it as a submission when they actually got far enough to be
      // reviewed/approved — not when they backed out, and not on a rejection.
      if (outcome === 'approved' || outcome === 'inReview') {
        void AppsFlyerAnalytics.logKycSubmitted();
      }
      return { ...result, kycStatus };
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? 'kyc_failed';
      setError(String(msg));
      throw err;
    } finally {
      setLaunching(false);
    }
  }, [getAccessToken, ensureUrid, refresh]);

  // KYC step 3 (SignFormA): once Sumsub is GREEN, the user must sign the Form A
  // declaration. We fetch the exact text (Full-Auth), personal_sign it with the
  // URID-owning wallet (silent for the Privy embedded EOA), submit, then re-read
  // status. UR flips the flow to step 4 (Review); Tourist→Live still arrives via
  // the kyc_status webhook, so we never mark the user Live here.
  const signFormA = useCallback(async (): Promise<UrKycStatusResponse | null> => {
    setLaunching(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      await ensureUrid();
      const auth = await signFullAuth();
      const { text } = await fetchUrFormA(token, { auth });
      if (!text) throw new Error('Form A unavailable');
      const signature = await signMessageWithWallet(text);
      await submitUrFormA(token, { auth, text, signature });
      // UR has an internal sleep before the flow status flips; give it a beat
      // so the re-read reflects step 4 (Review) rather than a stale step 3.
      await sleep(3200);
      const kycStatus = await refresh();
      void AppsFlyerAnalytics.logKycSubmitted();
      return kycStatus;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? 'form_a_failed';
      setError(String(msg));
      throw err;
    } finally {
      setLaunching(false);
    }
  }, [getAccessToken, ensureUrid, signFullAuth, signMessageWithWallet, refresh]);

  return {
    status,
    loading,
    launching,
    error,
    sdkAvailable: isSumsubAvailable(),
    refresh,
    startVerification,
    signFormA,
    ensureUrid,
  };
}
