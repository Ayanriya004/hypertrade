/**
 * UR (Fiat24) account state — implemented by `useUrAccountState`, exposed
 * app-wide via `UrAccountProvider` / `useUrAccount` in `UrAccountProvider.tsx`.
 *
 * useUrAccountState — one-stop hook for the UR (Fiat24) section of the app.
 *
 * Lifecycle:
 *
 *   1. On mount (and whenever auth flips), fetch the caller's UR link.
 *   2. If no link exists AND we're in dev / UR-test-wallet-import mode,
 *      auto-call `POST /api/ur/link` (no body) so the backend binds the
 *      Privy DID to `UR_TEST_URID`. This makes the test user "Just Work"
 *      after they log in without any extra UX.
 *   3. Once linked, fetch profile + balance + transactions in parallel.
 *   4. Expose a `refresh()` that re-runs the whole pipeline (pull-to-refresh).
 *
 * Caller doesn't need to know whether the link existed or was just created —
 * `linked` + `profile` + `balance` + `transactions` simply become non-null
 * when ready.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../providers/AuthContext';
import { AppsFlyerAnalytics } from '../lib/appsFlyerAnalytics';
import {
  buildCashAccountRows,
  CashAccountRow,
  createUrLink,
  fetchUrBalance,
  fetchUrBridgeStatus,
  fetchUrFxUsdRates,
  fetchUrLink,
  fetchUrNotifications,
  fetchUrProfile,
  fetchUrTransactions,
  normaliseBalance,
  parseAmount,
  UrBalanceItem,
  UrBridgeStatus,
  UrLinkResponse,
  UrProfileData,
  UrTransaction,
} from '../lib/urApi';
import {
  expandUrTransactionsForDisplay,
  dedupeDepositCtuTransactions,
  overlayClearedDepositWatchStatus,
  overlayPendingIncomingDepositStatus,
  depositIncomingWatchKey,
  depositTxMatchesPendingIncoming,
  incomingKindUsesCtuPipeline,
  parsePassiveIncomingNotification,
  type IncomingCreditKind,
  type PendingIncomingDepositHint,
} from '../lib/urTransactionFormat';
import { layerZeroScanUrl } from '../lib/explorer';

/**
 * "Incoming X CHF" pill state — surfaced on the matching currency card
 * while UR's `/v1/balance` indexer hasn't reflected a just-completed
 * credit yet (Add Money, Convert, bank pay-in, P2P received, card refund).
 * Self-clears once the balance actually moves past the snapshotted baseline,
 * OR after a safety TTL.
 *
 * Mirrors the pattern used in `frontend/src/components/DepositPanel.tsx`
 * for HL deposit/withdraw — same UX principle, different data source.
 */
export interface PendingIncomingEntry {
  currency: string;          // upper-case ISO code, e.g. "USD"
  amount: number;            // human decimal (positive), e.g. 10.00
  /** What drove this pill — only `deposit` touches the CTU tx-list pipeline. */
  kind: IncomingCreditKind;
  /** Baseline balance at the moment we marked this incoming — used
   *  to detect when UR's indexer has caught up. */
  baselineBalance: number;
  /** unix ms — used for the TTL fallback (in case the user's balance
   *  history makes baseline detection ambiguous, e.g. mid-flight Convert). */
  startedAt: number;
  /** Source-chain (Arbitrum) tx hash for a cross-chain Add Money deposit.
   *  Present ONLY for bridged deposits (USDC -> USD24 via LayerZero); absent
   *  for same-chain Convert. When set, the pill's lifetime is driven by the
   *  real LayerZero delivery status (see the bridge-poll effect) instead of a
   *  short blind timer, so a slow testnet hop never makes the credit look lost. */
  sourceTxHash?: string;
  /** Source chain id for the LayerZero lookup (e.g. 421614 Arb Sepolia). */
  sourceChainId?: number;
  /** Latest LayerZero delivery state, refreshed while in-flight. */
  bridgeStatus?: UrBridgeStatus;
  /** LayerZeroScan page for the bridged source tx (when available). */
  layerZeroScanUrl?: string;
  /** How many distinct in-flight deposits are aggregated into this entry.
   *  >1 when the user fired multiple Add Money deposits for the same currency
   *  before any credited — `amount` is then their SUM. */
  count: number;
  /** Source tx hashes of every aggregated leg (lower-case). Drives the
   *  multi-deposit pre-sign guard and keeps aggregation idempotent. */
  legTxHashes: string[];
}

export interface UseUrAccountState {
  /**
   * First-paint gate. Stays true only until we know enough to decide WHICH
   * screen to render — i.e. the link is resolved and the profile attempt has
   * settled (profile drives the KYC-live vs prompt decision). Balance and
   * transactions then stream in behind their own loading flags so the shell
   * paints fast instead of blocking on the slowest UR call.
   */
  initializing: boolean;
  /** A refresh is currently in flight. */
  loading: boolean;
  /** Balance (and therefore the account cards / total) is still loading. */
  balanceLoading: boolean;
  /** USD-equivalent rates are still resolving for held non-USD currencies. */
  ratesLoading: boolean;
  /** Transactions list is still loading. */
  txLoading: boolean;
  /** Set when any step (link / profile / balance / tx) failed irrecoverably. */
  error: string | null;
  /**
   * True when UR's API gateway is down (HTTP 503 — e.g. an Envoy
   * "no healthy upstream" while UR redeploys). Distinct from `error`:
   * this is transient and self-heals, so the UI shows a soft "retry
   * shortly" banner over the last-known data rather than a hard failure.
   */
  serviceDown: boolean;
  /** Link row, or null if the user has no URID bound. */
  link: UrLinkResponse | null;
  profile: UrProfileData | null;
  balance: UrBalanceItem[];
  transactions: UrTransaction[];
  /** True once the full transaction list has been fetched (via "See all"). */
  transactionsExpanded: boolean;
  /** Fetch the full transaction list (deferred behind the "See all" CTA). */
  expandTransactions: () => Promise<void>;
  /** Pre-built rows for the Cash tab (sorted by balance DESC + IBAN merge). */
  cashRows: CashAccountRow[];
  /**
   * Per-currency rate vs USD24, read from Fiat24CryptoRelay's
   * `getExchangeRate` on Mantle. Lets the dashboard compute a USD-equivalent
   * total instead of naively summing all currencies 1:1. Missing currencies
   * fall back to 1.0 at the call-site (defensive, so a partial map still
   * renders something sensible).
   */
  usdRates: Record<string, number>;
  /**
   * Currency code → in-flight incoming entry. Keys are upper-case ISO
   * codes (USD / EUR / CHF). Empty when nothing is in-flight.
   */
  pendingIncoming: Record<string, PendingIncomingEntry>;
  /**
   * Snapshot the current balance for `currency` and add a pending entry
   * so the UI surfaces "+amount {currency} incoming" on the matching
   * card. The entry auto-clears once the on-chain balance lands.
   *
   * For cross-chain Add Money deposits, pass the source tx hash + chain id
   * via `bridge` so the pill stays alive until LayerZero actually delivers
   * the credit (rather than a short blind timer). Omit `bridge` for
   * same-chain credits (Convert) and passive inflows (pay-in, P2P, refunds).
   * Always pass `opts.kind` for non-deposit credits.
   */
  markIncoming: (
    currency: string,
    amount: number,
    bridge?: { sourceTxHash?: string; sourceChainId?: number },
    opts?: { kind?: IncomingCreditKind },
  ) => void;
  /** Re-runs the entire pipeline (pull-to-refresh). */
  refresh: () => Promise<void>;
  /** Background refresh — balance/tx update without loading spinners. */
  refreshSilent: () => Promise<void>;
  /**
   * After withdraw/send, silently poll transactions (with reconcile) until
   * pending rows clear or the TTL expires — same idea as deposit polling.
   */
  startTransactionReconcilePoll: () => void;
}

type LoadOptions = {
  reconcile?: boolean;
  txPageSize?: number;
  /**
   * Background refresh — updates balance/tx without flipping loading
   * flags (used while `pendingIncoming` polls after a deposit/convert).
   */
  silent?: boolean;
};

/**
 * True when an API error is a UR upstream outage (backend maps that to a
 * clean HTTP 503 — see `_raise_ur_read_error` in server.py). Used to show the
 * soft "retry shortly" banner instead of a hard error.
 */
function isUrServiceDown(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 503;
}

// Cold-start fast path: fetch only the latest few rows so first paint is
// snappy. The full list is fetched lazily when the user taps "See all".
const TX_INITIAL_SIZE = 5;
const TX_EXPANDED_SIZE = 30;

// How long to keep an "incoming" pill alive when the balance never moves
// far enough to satisfy `arrived` — covers UR-indexer outages and rare
// edge cases (concurrent debit/credit, partial fees). After this we
// silently drop the pill; the user will still see the up-to-date
// balance on next refresh. Applies to SAME-CHAIN credits (Convert), which
// land in seconds.
const PENDING_INCOMING_TTL_MS = 180_000;
// Cross-chain Add Money (USDC -> USD24 via LayerZero) can legitimately sit
// in-flight for many minutes (testnet executor lag), so a 3-min timer would
// wrongly drop the pill while the credit is still coming. For bridged entries
// the pill is instead driven by LayerZero delivery status (see bridge-poll
// effect); this long cap is only a last-resort safety net so a pill can never
// wedge forever if both balance polling AND the LZ lookup go silent.
const BRIDGE_PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2h
// While we have at least one in-flight pending entry, refresh balance
// at this cadence. ~10s is a sweet spot — UR's `/v1/balance` typically
// reflects new credits within 5–20s on testnet, and at this frequency
// we're not hammering their backend.
const PENDING_INCOMING_POLL_MS = 8_000;
/** Max time to keep polling tx list after a cash-out (withdraw / send). */
const TX_RECONCILE_POLL_TTL_MS = 3 * 60 * 1000;
// Cadence for polling LayerZero delivery status of bridged deposits. Slower
// than balance polling — delivery state changes on the order of minutes.
const BRIDGE_STATUS_POLL_MS = 20_000;
/** Keep a just-landed deposit row pinned until UR / reconcile marks it completed. */
const CLEARED_DEPOSIT_WATCH_TTL_MS = 5 * 60 * 1000;

type ClearedDepositWatchEntry = PendingIncomingEntry & { clearedAt: number };

export function useUrAccountState(): UseUrAccountState {
  const { isAuthenticated, isReady, getAccessToken, isUrTestWalletImportEnabled, user } =
    useAuth();

  const [initializing, setInitializing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [txLoading, setTxLoading] = useState(true);
  // Rates resolve AFTER balance (slow on-chain getExchangeRate reads). The
  // dashboard keeps bouncing dots until every required rate is present.
  const [ratesLoading, setRatesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceDown, setServiceDown] = useState(false);
  const [link, setLink] = useState<UrLinkResponse | null>(null);
  const [profile, setProfile] = useState<UrProfileData | null>(null);
  const [balance, setBalance] = useState<UrBalanceItem[]>([]);
  const [transactions, setTransactions] = useState<UrTransaction[]>([]);
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const [usdRates, setUsdRates] = useState<Record<string, number>>({});
  const [pendingIncoming, setPendingIncoming] = useState<
    Record<string, PendingIncomingEntry>
  >({});
  /** Deposits whose incoming pill cleared — tx row stays until completed. */
  const [clearedDepositWatch, setClearedDepositWatch] = useState<
    Record<string, ClearedDepositWatchEntry>
  >({});
  const [txReconcilePollActive, setTxReconcilePollActive] = useState(false);
  // True once we've observed a pending/processing row while a post-withdraw
  // reconcile poll is running. Prevents stopping the poll on the first fetch
  // (before UR's indexer surfaces the new CTF row).
  const txReconcileSawPendingRef = useRef(false);
  // Mirror of `profile` so in-flight `load` can tell whether a silent refresh
  // still needs /ur/profile (IBANs, chainStatus, contacts).
  const profileRef = useRef<UrProfileData | null>(null);
  const usdRatesRef = useRef<Record<string, number>>({});

  const seenPassiveIncomingNotifRef = useRef(new Set<string>());

  useEffect(() => {
    usdRatesRef.current = usdRates;
  }, [usdRates]);

  // We avoid stale-fetch races on rapid mount/unmount by tagging each run
  // and ignoring writes from a superseded run.
  const runIdRef = useRef(0);
  // Mirror of `transactionsExpanded` so background refreshes (poll /
  // pull-to-refresh) keep fetching the full list once the user expanded it.
  const txExpandedRef = useRef(false);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    if (!user?.id || profile?.chainStatus !== 5) return;
    void AppsFlyerAnalytics.logKycCompletedOnce(user.id);
  }, [profile?.chainStatus, user?.id]);

  /** Fetch USD rates for the held non-USD currencies (drives the total). */
  const refreshRates = useCallback(
    async (
      token: string,
      items: UrBalanceItem[],
      myRun: number,
      opts?: { silent?: boolean },
    ) => {
      const silent = opts?.silent ?? false;
      const heldCurrencies = Array.from(
        new Set(
          items
            .map((b) => ({
              code: (b.symbol || '').toUpperCase(),
              amount: parseAmount(b.amount),
            }))
            .filter(
              ({ code, amount }) =>
                code && code !== 'USD' && Number.isFinite(amount) && amount > 0,
            )
            .map(({ code }) => code),
        ),
      );
      // CHF is always fetched (even for USD-only holders): the rolling-30-day
      // transfer limit is CHF-denominated, so the bank sheets need a CHF rate
      // to size any outgoing tx against the user's remaining headroom.
      const rateCurrencies = Array.from(new Set([...heldCurrencies, 'CHF']));
      if (runIdRef.current === myRun && !silent) setRatesLoading(true);
      try {
        const ratesRes = await fetchUrFxUsdRates(token, rateCurrencies);
        if (runIdRef.current === myRun) {
          setUsdRates({ USD: 1, ...(ratesRes.rates || {}) });
        }
      } catch (rateErr) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[useUrAccount] usd-rates failed:', rateErr);
        }
        // Keep the last-known rates — clearing them would flash the total
        // loader on the next silent poll even though nothing changed.
      } finally {
        if (runIdRef.current === myRun) setRatesLoading(false);
      }
    },
    [],
  );

  const load = useCallback(
    async (opts?: LoadOptions) => {
      if (!isReady || !isAuthenticated) return;

      const myRun = ++runIdRef.current;
      const silent = opts?.silent ?? false;
      const reconcile = opts?.reconcile ?? true;
      const txPageSize =
        opts?.txPageSize ??
        (txExpandedRef.current ? TX_EXPANDED_SIZE : TX_INITIAL_SIZE);
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const token = await getAccessToken();
        if (!token) {
          if (runIdRef.current === myRun) {
            setError('Not authenticated');
            setInitializing(false);
          }
          return;
        }

        // 1. Resolve link. In dev mode (UR test wallet import) auto-create
        //    using UR_TEST_URID on the backend if missing.
        let resolvedLink = await fetchUrLink(token);
        if (!resolvedLink && isUrTestWalletImportEnabled) {
          try {
            resolvedLink = await createUrLink(token);
          } catch (linkErr) {
            // Surface the message but don't blow up — the UI can offer a manual link button.
            if (__DEV__) {
              // eslint-disable-next-line no-console
              console.log('[useUrAccount] auto-link failed:', linkErr);
            }
          }
        }
        if (runIdRef.current !== myRun) return;
        setLink(resolvedLink);

        if (!resolvedLink) {
          // No link, no data to fetch. Clear stale values.
          setProfile(null);
          setBalance([]);
          setTransactions([]);
          setBalanceLoading(false);
          setTxLoading(false);
          setInitializing(false);
          return;
        }

        // 2. Fire reads independently. Silent polls skip profile when we
        //    already have one (keeps cards stable); but a silent run that
        //    supersedes a cold load must still fetch profile or IBAN-gated UI
        //    (add-money bank transfer) stays wrongly disabled.
        if (!silent) {
          setBalanceLoading(true);
          setTxLoading(true);
        }

        const needsProfile = !silent || profileRef.current == null;
        const profileP = needsProfile
          ? fetchUrProfile(token)
              .then((res) => {
                if (runIdRef.current === myRun) {
                  setProfile(res.data);
                  setServiceDown(false);
                }
              })
              .catch((err) => {
                if (__DEV__) {
                  // eslint-disable-next-line no-console
                  console.log('[useUrAccount] profile failed:', err);
                }
                if (runIdRef.current === myRun && isUrServiceDown(err)) {
                  setServiceDown(true);
                }
              })
          : Promise.resolve();

        const balanceP = fetchUrBalance(token)
          .then((res) => {
            if (runIdRef.current !== myRun) return;
            const items = normaliseBalance(res.data);
            const heldNonUsd = Array.from(
              new Set(
                items
                  .map((b) => ({
                    code: (b.symbol || '').toUpperCase(),
                    amount: parseAmount(b.amount),
                  }))
                  .filter(
                    ({ code, amount }) =>
                      code && code !== 'USD' && Number.isFinite(amount) && amount > 0,
                  )
                  .map(({ code }) => code),
              ),
            );
            if (runIdRef.current === myRun) {
              const missingRates = heldNonUsd.some(
                (code) => usdRatesRef.current[code] == null,
              );
              // Flip while any held currency still lacks a rate — including
              // silent polls so downstream UI can tell a total is incomplete.
              if (heldNonUsd.length > 0 && missingRates) setRatesLoading(true);
              setBalance(items);
              setBalanceLoading(false);
              setServiceDown(false);
            }
            void refreshRates(token, items, myRun, { silent });
          })
          .catch((err) => {
            if (__DEV__) {
              // eslint-disable-next-line no-console
              console.log('[useUrAccount] balance failed:', err);
            }
            if (runIdRef.current === myRun) {
              setBalanceLoading(false);
              if (isUrServiceDown(err)) setServiceDown(true);
            }
          });

        const txP = fetchUrTransactions(token, txPageSize, reconcile)
          .then((res) => {
            if (runIdRef.current === myRun) {
              setTransactions(expandUrTransactionsForDisplay(res.data || []));
              setServiceDown(false);
            }
          })
          .catch((err) => {
            if (__DEV__) {
              // eslint-disable-next-line no-console
              console.log('[useUrAccount] transactions failed:', err);
            }
            if (runIdRef.current === myRun && isUrServiceDown(err)) {
              setServiceDown(true);
            }
          })
          .finally(() => {
            if (runIdRef.current === myRun) setTxLoading(false);
          });

        // Flip the first-paint gate once profile settles when we fetched it,
        // or immediately for silent runs that reused cached profile.
        if (!silent || needsProfile) {
          await profileP;
        }
        if (runIdRef.current === myRun) setInitializing(false);

        await Promise.allSettled([balanceP, txP]);
      } catch (err: unknown) {
        if (runIdRef.current !== myRun) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load UR account';
        setError(msg);
        setInitializing(false);
      } finally {
        // Always clear — silent runs can supersede a non-silent refresh and
        // otherwise leave the pull-to-refresh indicator stuck at the top.
        if (runIdRef.current === myRun) setLoading(false);
      }
    },
    [
      isReady,
      isAuthenticated,
      getAccessToken,
      isUrTestWalletImportEnabled,
      refreshRates,
    ],
  );

  // Pull-to-refresh / programmatic refresh: always reconcile (heal pending
  // rows) and keep the full list if the user already expanded it.
  const refresh = useCallback(() => load({ reconcile: true }), [load]);
  const refreshSilent = useCallback(
    () => load({ reconcile: true, silent: true }),
    [load],
  );

  const startTransactionReconcilePoll = useCallback(() => {
    txReconcileSawPendingRef.current = false;
    setTxReconcilePollActive(true);
    void load({ reconcile: true, silent: true });
  }, [load]);

  // "See all" — fetch the full transaction list on demand. Kept separate
  // from `load` so it doesn't re-fetch profile/balance/rates.
  const expandTransactions = useCallback(async () => {
    if (!isReady || !isAuthenticated) return;
    txExpandedRef.current = true;
    setTransactionsExpanded(true);
    setTxLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetchUrTransactions(token, TX_EXPANDED_SIZE, true);
      setTransactions(expandUrTransactionsForDisplay(res.data || []));
    } catch (err) {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[useUrAccount] expandTransactions failed:', err);
      }
    } finally {
      setTxLoading(false);
    }
  }, [isReady, isAuthenticated, getAccessToken]);

  useEffect(() => {
    if (!isReady) return;
    if (!isAuthenticated) {
      setInitializing(false);
      setBalanceLoading(false);
      setRatesLoading(false);
      setTxLoading(false);
      setLink(null);
      setProfile(null);
      setBalance([]);
      setTransactions([]);
      setTransactionsExpanded(false);
      txExpandedRef.current = false;
      setUsdRates({});
      setPendingIncoming({});
      setClearedDepositWatch({});
      return;
    }
    // Cold start: skip on-chain reconciliation and fetch only the latest few
    // rows for the snappiest possible first paint.
    void load({ reconcile: false, txPageSize: TX_INITIAL_SIZE });
  }, [isReady, isAuthenticated, load]);

  // useMemo so downstream effect dependency arrays stay referentially
  // stable across renders that don't change balance — without this,
  // the auto-clear effect below would re-fire on every render and
  // immediately clear entries before the user can see them.
  const cashRows = useMemo(
    () => buildCashAccountRows(balance, profile?.bankAccounts),
    [balance, profile?.bankAccounts],
  );

  /**
   * Snapshot the current balance for `currency` and add a pending entry
   * to the in-flight map. The pill stays alive until the balance moves
   * past `baseline + amount * 0.95` (giving headroom for FX rounding
   * and the unlikely case of a concurrent debit) or until the TTL
   * expires — see the auto-clear effect below.
   */
  const markIncoming = useCallback(
    (
      currency: string,
      amount: number,
      bridge?: { sourceTxHash?: string; sourceChainId?: number },
      opts?: { kind?: IncomingCreditKind },
    ) => {
      const code = (currency || '').toUpperCase();
      if (!code || !Number.isFinite(amount) || amount <= 0) return;
      const txHash = (bridge?.sourceTxHash || '').trim().toLowerCase() || undefined;
      const chainId = bridge?.sourceChainId;
      const kind: IncomingCreditKind =
        opts?.kind ?? (txHash ? 'deposit' : 'convert');
      setPendingIncoming((prev) => {
        const existing = prev[code];
        // Idempotent: the same deposit re-marked (or a double-fired onSuccess)
        // must not double-count. Keep the original baseline/startedAt so a
        // later balance refresh cannot instantly clear the pill.
        if (existing && txHash && existing.legTxHashes.includes(txHash)) {
          return prev;
        }
        // Never merge bridged Add Money with a Convert credit on the same currency.
        if (existing && existing.kind !== kind) {
          const baseline =
            cashRows.find((r) => r.currency === code)?.amount ?? 0;
          return {
            ...prev,
            [code]: {
              currency: code,
              kind,
              amount,
              baselineBalance: baseline,
              startedAt: Date.now(),
              sourceTxHash: txHash,
              sourceChainId: chainId,
              bridgeStatus: txHash ? 'inflight' : undefined,
              layerZeroScanUrl: txHash
                ? layerZeroScanUrl(txHash, chainId) ?? undefined
                : undefined,
              count: 1,
              legTxHashes: txHash ? [txHash] : [],
            },
          };
        }
        // Upgrade a same-chain (Convert) entry that had no source hash yet.
        if (existing && !existing.sourceTxHash && txHash) {
          return {
            ...prev,
            [code]: {
              ...existing,
              kind: 'deposit',
              sourceTxHash: txHash,
              sourceChainId: chainId ?? existing.sourceChainId,
              bridgeStatus: 'inflight',
              layerZeroScanUrl:
                layerZeroScanUrl(txHash, chainId ?? existing.sourceChainId) ??
                existing.layerZeroScanUrl,
              count: Math.max(existing.count, 1),
              legTxHashes: txHash
                ? [...existing.legTxHashes, txHash]
                : existing.legTxHashes,
            },
          };
        }
        // A second (or later) in-flight deposit for a currency that already has
        // one pending: AGGREGATE rather than overwrite, so the single per-
        // currency card pill reflects the true total still incoming (and the
        // first deposit's amount isn't silently dropped). The pill then clears
        // only once the balance covers the SUM. We keep the earliest baseline/
        // startedAt and track the newest leg as the representative for LZ
        // polling.
        if (
          existing &&
          existing.kind === kind &&
          Number.isFinite(existing.amount) &&
          existing.amount > 0
        ) {
          return {
            ...prev,
            [code]: {
              ...existing,
              amount: existing.amount + amount,
              count: existing.count + 1,
              sourceTxHash: txHash ?? existing.sourceTxHash,
              sourceChainId: chainId ?? existing.sourceChainId,
              bridgeStatus: txHash ? 'inflight' : existing.bridgeStatus,
              layerZeroScanUrl: txHash
                ? layerZeroScanUrl(txHash, chainId) ?? existing.layerZeroScanUrl
                : existing.layerZeroScanUrl,
              legTxHashes: txHash
                ? [...existing.legTxHashes, txHash]
                : existing.legTxHashes,
            },
          };
        }
        const baseline =
          cashRows.find((r) => r.currency === code)?.amount ?? 0;
        return {
          ...prev,
          [code]: {
            currency: code,
            kind,
            amount,
            baselineBalance: baseline,
            startedAt: Date.now(),
            sourceTxHash: txHash,
            sourceChainId: chainId,
            // Seed bridged deposits as in-flight so the pill never drops before
            // the first LZ status poll resolves.
            bridgeStatus: txHash ? 'inflight' : undefined,
            layerZeroScanUrl: txHash
              ? layerZeroScanUrl(txHash, chainId) ?? undefined
              : undefined,
            count: 1,
            legTxHashes: txHash ? [txHash] : [],
          },
        };
      });
    },
    [cashRows],
  );

  // Passive inflows (bank pay-in, P2P received, card refund) land via UR
  // webhooks — drive the card pill from unread inbox rows (no CTU injection).
  useEffect(() => {
    if (!isReady || !isAuthenticated || !link) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const token = await getAccessToken();
        if (!token || cancelled) return;
        const { notifications } = await fetchUrNotifications(token, {
          category: 'transaction',
          limit: 20,
        });
        for (const n of notifications) {
          if (seenPassiveIncomingNotifRef.current.has(n.id)) continue;
          if (n.read) {
            seenPassiveIncomingNotifRef.current.add(n.id);
            continue;
          }
          const parsed = parsePassiveIncomingNotification(n);
          if (!parsed) continue;
          seenPassiveIncomingNotifRef.current.add(n.id);
          markIncoming(
            parsed.currency,
            parsed.amount,
            parsed.sourceTxHash
              ? { sourceTxHash: parsed.sourceTxHash }
              : undefined,
            { kind: parsed.kind },
          );
        }
      } catch (err) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[useUrAccount] passive incoming notif poll failed', err);
        }
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isReady, isAuthenticated, link, getAccessToken, markIncoming]);

  // Auto-clear pending entries when (a) the balance has caught up, or
  // (b) the TTL has expired. We do this defensively even on cashRows
  // changes that came from a non-Convert/Deposit source — the worst
  // case is dropping a stale pill earlier than expected.
  //
  // CRITICAL: we use the functional setter and return `prev` unchanged
  // when nothing actually moved. Returning a fresh `{}` literal every
  // run would break React's referential-equality bail-out and trigger
  // an infinite "Maximum update depth exceeded" loop, since this
  // effect's only true dependency (cashRows) is plenty noisy on its
  // own. `pendingIncoming` is INTENTIONALLY omitted from the deps —
  // we read it via the setter to avoid the self-retrigger cycle.
  useEffect(() => {
    setPendingIncoming((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const now = Date.now();
      let changed = false;
      const next: Record<string, PendingIncomingEntry> = {};
      for (const code of keys) {
        const entry = prev[code];
        const current =
          cashRows.find((r) => r.currency === code)?.amount ?? 0;
        const target = entry.baselineBalance + entry.amount * 0.95;
        const arrived = current >= target;
        // A bridged (cross-chain) deposit is gated on LayerZero delivery, not
        // a short timer: keep its pill alive until the credit actually lands
        // (`arrived`), a true delivery failure is observed, or the 2h safety
        // cap trips. Same-chain credits (Convert) keep the original 3-min TTL.
        const isBridged = !!entry.sourceTxHash;
        const expired = isBridged
          ? now - entry.startedAt > BRIDGE_PENDING_TTL_MS
          : now - entry.startedAt > PENDING_INCOMING_TTL_MS;
        const bridgeFailed = isBridged && entry.bridgeStatus === 'failed';
        // LayerZero reported the destination mint landed — the credit is
        // provably on-chain, so resolve the pill even if the balance heuristic
        // hasn't caught up (a concurrent same-currency debit, e.g. a Convert
        // settling around the same time, can suppress `arrived` indefinitely).
        // Single-leg only; aggregated multi-deposit pills keep using the
        // balance/sum heuristic so we never drop a sibling leg still in-flight.
        const bridgeDelivered =
          isBridged && entry.bridgeStatus === 'delivered' && entry.count <= 1;
        if (expired || arrived || bridgeFailed || bridgeDelivered) {
          changed = true;
          continue;
        }
        next[code] = entry;
      }
      return changed ? next : prev;
    });
  }, [cashRows]);

  // When an incoming pill clears (balance / LZ landed), keep reconciling the
  // tx list until the deposit row flips to completed — same as withdraw/send.
  const prevPendingIncomingRef = useRef(pendingIncoming);
  useEffect(() => {
    const prev = prevPendingIncomingRef.current;
    prevPendingIncomingRef.current = pendingIncoming;
    const removed: PendingIncomingEntry[] = [];
    for (const code of Object.keys(prev)) {
      if (!(code in pendingIncoming)) removed.push(prev[code]);
    }
    if (!removed.length) return;
    const now = Date.now();
    setClearedDepositWatch((watch) => {
      const next = { ...watch };
      for (const entry of removed) {
        if (!incomingKindUsesCtuPipeline(entry.kind)) continue;
        const key = depositIncomingWatchKey(entry);
        next[key] = { ...entry, clearedAt: now };
      }
      return next;
    });
    txReconcileSawPendingRef.current = true;
    startTransactionReconcilePoll();
  }, [pendingIncoming, startTransactionReconcilePoll]);

  // Drop cleared-deposit pins once UR shows completed or the safety TTL trips.
  useEffect(() => {
    setClearedDepositWatch((watch) => {
      const keys = Object.keys(watch);
      if (!keys.length) return watch;
      const now = Date.now();
      let changed = false;
      const next: Record<string, ClearedDepositWatchEntry> = {};
      for (const [, entry] of Object.entries(watch)) {
        const hint: PendingIncomingDepositHint = {
          currency: entry.currency,
          amount: entry.amount,
          startedAt: entry.startedAt,
          sourceTxHash: entry.sourceTxHash,
          legTxHashes: entry.legTxHashes,
          kind: entry.kind,
        };
        const settled = transactions.some((tx) => {
          if ((tx.type ?? '').trim().toUpperCase() !== 'CTU') return false;
          if ((tx.direction ?? '').trim().toUpperCase() !== 'IN') return false;
          const status = (tx.status ?? '').trim().toLowerCase();
          if (status !== 'completed' && status !== 'complete') return false;
          return depositTxMatchesPendingIncoming(tx, hint);
        });
        const expired = now - entry.clearedAt > CLEARED_DEPOSIT_WATCH_TTL_MS;
        if (!settled && !expired) next[depositIncomingWatchKey(entry)] = entry;
        else changed = true;
      }
      return changed ? next : watch;
    });
  }, [transactions]);

  // Track whether there's at least one in-flight pending entry as a
  // primitive boolean — gives the polling effect below a STABLE
  // dependency that only flips on the rising/falling edge. Using
  // `pendingIncoming` itself would re-create the interval every time
  // a single key changed (which currently happens any time we mark or
  // clear), wasting one fetch per transition.
  const hasPendingIncoming = Object.keys(pendingIncoming).length > 0;

  // While any pending entry is in-flight, poll UR's balance endpoint at
  // a steady cadence. We stop the interval entirely the moment the map
  // empties (either via balance landing or TTL expiry) — no wasted
  // network when the user isn't waiting on anything.
  useEffect(() => {
    if (!hasPendingIncoming) return undefined;
    const id = setInterval(() => {
      // Reconcile while polling so a freshly-landed Convert/deposit flips
      // out of "pending" as soon as its receipt confirms.
      void load({ reconcile: true, silent: true });
    }, PENDING_INCOMING_POLL_MS);
    return () => clearInterval(id);
  }, [hasPendingIncoming, load]);

  // After withdraw / bank send, UR's indexer can leave a row at "pending"
  // even though our job reconciler has marked the Mantle tx completed.
  useEffect(() => {
    if (!txReconcilePollActive) return undefined;
    const id = setInterval(() => {
      void load({ reconcile: true, silent: true });
    }, PENDING_INCOMING_POLL_MS);
    return () => clearInterval(id);
  }, [txReconcilePollActive, load]);

  useEffect(() => {
    if (!txReconcilePollActive) {
      txReconcileSawPendingRef.current = false;
      return;
    }
    const anyPending = transactions.some((tx) => {
      const s = (tx.status ?? '').trim().toLowerCase();
      return s === 'pending' || s === 'processing';
    });
    if (anyPending) {
      txReconcileSawPendingRef.current = true;
      return;
    }
    // Only stop once a pending row we were tracking has cleared — not on
    // the initial empty/prefetch state right after withdraw/send succeeds.
    if (txReconcileSawPendingRef.current) {
      setTxReconcilePollActive(false);
      txReconcileSawPendingRef.current = false;
    }
  }, [transactions, txReconcilePollActive]);

  useEffect(() => {
    if (!txReconcilePollActive) return undefined;
    const t = setTimeout(() => setTxReconcilePollActive(false), TX_RECONCILE_POLL_TTL_MS);
    return () => clearTimeout(t);
  }, [txReconcilePollActive]);

  // Latest pending map, read inside the bridge-poll interval without making
  // it a dependency (which would tear down/recreate the interval on every
  // status update). Same self-retrigger guard as the auto-clear effect.
  const pendingIncomingRef = useRef(pendingIncoming);
  useEffect(() => {
    pendingIncomingRef.current = pendingIncoming;
  }, [pendingIncoming]);

  // When a pending incoming's balance actually LANDS, the balance poll above
  // stops (hasPendingIncoming flips false) — but UR's tx indexer can still show
  // the matching deposit row as "pending" for a few more seconds. Without a
  // nudge the row only flips to "Completed" when the user leaves & re-enters the
  // screen (which triggers a fresh fetch). So the moment we detect the credit
  // has arrived, kick the transaction-reconcile poll to flip the row in place.
  // Fired ONCE per pending cycle (startTransactionReconcilePoll resets its own
  // guard + fires a load), then re-armed when the pending map empties.
  const depositReconcileKickedRef = useRef(false);
  useEffect(() => {
    const pend = pendingIncomingRef.current;
    const codes = Object.keys(pend);
    if (codes.length === 0) {
      depositReconcileKickedRef.current = false;
      return;
    }
    if (depositReconcileKickedRef.current) return;
    const landed = codes.some((code) => {
      const entry = pend[code];
      const current = cashRows.find((r) => r.currency === code)?.amount ?? 0;
      return current >= entry.baselineBalance + entry.amount * 0.95;
    });
    if (landed) {
      depositReconcileKickedRef.current = true;
      startTransactionReconcilePoll();
    }
  }, [cashRows, startTransactionReconcilePoll]);

  // True while at least one BRIDGED deposit is still in-flight (has a source
  // tx hash and LayerZero hasn't reported a terminal delivery state). Stable
  // boolean so the LZ-poll effect only mounts/unmounts on the rising/falling
  // edge, not on every status refresh.
  const hasBridgePending = useMemo(
    () =>
      Object.values(pendingIncoming).some(
        (e) =>
          !!e.sourceTxHash &&
          e.bridgeStatus !== 'delivered' &&
          e.bridgeStatus !== 'failed',
      ),
    [pendingIncoming],
  );

  // Poll LayerZero delivery status for in-flight bridged deposits. This is
  // what lets the "USD incoming" pill survive a slow cross-chain hop: the
  // pill is cleared by the balance actually landing (`arrived`, handled in the
  // auto-clear effect) — never by a blind timer — and we only mark a deposit
  // `failed` if LayerZero reports a true destination revert. The lookup is
  // fail-open (backend returns `unknown` on any error), so a flaky network
  // never drops a legitimately in-flight credit.
  useEffect(() => {
    if (!hasBridgePending) return undefined;
    let cancelled = false;

    const poll = async () => {
      const entries = Object.values(pendingIncomingRef.current).filter(
        (e) =>
          !!e.sourceTxHash &&
          e.bridgeStatus !== 'delivered' &&
          e.bridgeStatus !== 'failed',
      );
      if (!entries.length) return;
      let token: string | null = null;
      try {
        token = await getAccessToken();
      } catch {
        token = null;
      }
      if (!token || cancelled) return;
      for (const entry of entries) {
        try {
          const res = await fetchUrBridgeStatus(
            token,
            entry.sourceTxHash as string,
            entry.sourceChainId ?? 0,
          );
          if (cancelled) return;
          // A terminal LayerZero state resolves a single-leg pill right here —
          // 'delivered' = the destination mint landed, 'failed' = it never
          // will. Dropping the entry now (instead of waiting on the balance
          // heuristic) also clears the forced-"pending" overlay on the matching
          // Transactions row, which a concurrent same-currency debit could
          // otherwise pin to Pending until the 2h cap.
          const cur0 = pendingIncomingRef.current[entry.currency];
          const resolvable =
            !!cur0 &&
            cur0.sourceTxHash === entry.sourceTxHash &&
            cur0.count <= 1 &&
            (res.status === 'delivered' || res.status === 'failed');
          setPendingIncoming((prev) => {
            const cur = prev[entry.currency];
            if (!cur || cur.sourceTxHash !== entry.sourceTxHash) return prev;
            if (
              cur.count <= 1 &&
              (res.status === 'delivered' || res.status === 'failed')
            ) {
              const { [entry.currency]: _resolved, ...rest } = prev;
              return rest;
            }
            const nextUrl = res.scanUrl || cur.layerZeroScanUrl;
            if (cur.bridgeStatus === res.status && cur.layerZeroScanUrl === nextUrl) {
              return prev;
            }
            return {
              ...prev,
              [entry.currency]: {
                ...cur,
                bridgeStatus: res.status,
                layerZeroScanUrl: nextUrl,
              },
            };
          });
          // Nudge the tx list so the now-resolved deposit row flips from the
          // (just-cleared) pending overlay to its real settled status in place.
          if (resolvable && res.status === 'delivered') {
            startTransactionReconcilePoll();
          }
        } catch {
          // Fail-open: keep the pill, retry on the next tick.
        }
      }
    };

    void poll();
    const id = setInterval(() => void poll(), BRIDGE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasBridgePending, getAccessToken, startTransactionReconcilePoll]);

  const clearedDepositHints = useMemo(
    (): Record<string, PendingIncomingDepositHint> =>
      Object.fromEntries(
        Object.entries(clearedDepositWatch).map(([key, entry]) => [
          key,
          {
            currency: entry.currency,
            amount: entry.amount,
            startedAt: entry.startedAt,
            sourceTxHash: entry.sourceTxHash,
            legTxHashes: entry.legTxHashes,
            kind: entry.kind,
          },
        ]),
      ),
    [clearedDepositWatch],
  );

  const displayTransactions = useMemo(() => {
    let list = dedupeDepositCtuTransactions(transactions);
    list = overlayPendingIncomingDepositStatus(list, pendingIncoming);
    list = overlayClearedDepositWatchStatus(list, clearedDepositHints);
    return list;
  }, [
    transactions,
    pendingIncoming,
    clearedDepositHints,
  ]);

  return {
    initializing,
    loading,
    balanceLoading,
    ratesLoading,
    txLoading,
    error,
    serviceDown,
    link,
    profile,
    balance,
    transactions: displayTransactions,
    transactionsExpanded,
    expandTransactions,
    cashRows,
    usdRates,
    pendingIncoming,
    markIncoming,
    refresh,
    refreshSilent,
    startTransactionReconcilePoll,
  };
}
