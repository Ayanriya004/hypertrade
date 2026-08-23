/**
 * UR rolling-30-day transfer limit math (shared across Convert / Send /
 * Withdraw / P2P).
 *
 * Fiat24's `Fiat24Account.limit(tokenId)` returns `(usedLimit, clientLimit,
 * startLimitDate)` — `usedLimit` / `clientLimit` are **CHF-denominated with 2
 * decimals** (raw `100000` == `1000.00 CHF`). EVERY money-moving op (FX, Card
 * Spending, On-ramp, Cash Payout AND P2P — UR confirmed P2P draws from the
 * same bucket) is checked on-chain against `clientLimit - usedLimit`; a tx that
 * pushes `usedLimit` past `clientLimit` reverts at the token contract.
 *
 * UR docs recommend a pre-transaction check against the remaining limit before
 * initiating a payment flow so the user gets a clear message instead of an
 * unexplained on-chain revert / burned relayer tx.
 */

export const UR_LIMIT_DECIMALS = 2;

/**
 * Remaining monthly headroom in CHF, or `null` when no finite limit applies:
 *   - inputs missing / not numbers       → null (unknown, don't block)
 *   - `clientLimit <= 0`                  → null ("no limit configured")
 */
export function remainingLimitChf(
  usedLimit?: number | null,
  clientLimit?: number | null,
): number | null {
  if (typeof usedLimit !== 'number' || typeof clientLimit !== 'number') return null;
  if (!Number.isFinite(usedLimit) || !Number.isFinite(clientLimit)) return null;
  if (clientLimit <= 0) return null;
  const remaining = (clientLimit - usedLimit) / 10 ** UR_LIMIT_DECIMALS;
  return remaining > 0 ? remaining : 0;
}

/**
 * Convert `amount` (in `currency`) to CHF using the dashboard's USD-rate map.
 *
 * `usdRates[code]` is "how many USD24 you get for 1 unit of `code`"
 * (Fiat24CryptoRelay.getExchangeRate). USD is implicitly 1. Returns `null`
 * when either leg's rate is missing so callers can degrade gracefully (skip
 * the overshoot check) instead of false-blocking.
 */
export function convertCurrencyToChf(
  amount: number,
  currency: string,
  usdRates: Record<string, number> | undefined | null,
): number | null {
  if (!Number.isFinite(amount)) return null;
  if (amount <= 0) return 0;
  const rates = usdRates ?? {};
  const code = (currency || '').toUpperCase();
  const fromUsd = code === 'USD' ? 1 : rates[code];
  const chfUsd = rates.CHF;
  if (!fromUsd || !chfUsd || fromUsd <= 0 || chfUsd <= 0) return null;
  return (amount * fromUsd) / chfUsd;
}

/** Inverse: how much of `currency` equals `chf` CHF (for "you can still send X"). */
export function convertChfToCurrency(
  chf: number,
  currency: string,
  usdRates: Record<string, number> | undefined | null,
): number | null {
  if (!Number.isFinite(chf)) return null;
  const rates = usdRates ?? {};
  const code = (currency || '').toUpperCase();
  const toUsd = code === 'USD' ? 1 : rates[code];
  const chfUsd = rates.CHF;
  if (!toUsd || !chfUsd || toUsd <= 0 || chfUsd <= 0) return null;
  return (chf * chfUsd) / toUsd;
}

export type TransferLimitStatus =
  | 'no_limit' // clientLimit unset/0, or inputs unknown → never block
  | 'fully_reached' // usedLimit >= clientLimit → block everything
  | 'would_exceed' // this amount pushes past remaining headroom → block
  | 'ok'; // within remaining headroom

export interface TransferLimitEval {
  status: TransferLimitStatus;
  /** True when the submit button should be disabled + a banner shown. */
  block: boolean;
  fullyReached: boolean;
  wouldExceed: boolean;
  /** Remaining headroom in CHF (null when no finite limit). */
  remainingChf: number | null;
  /** Remaining headroom expressed in the spend currency (null if no rate). */
  remainingInCurrency: number | null;
  /** This transaction's value in CHF (null if no rate / no amount yet). */
  amountChf: number | null;
}

/**
 * Evaluate whether a transfer of `amount` `currency` is allowed under the
 * rolling limit. Fails OPEN on missing data (returns `ok`/`no_limit`) so we
 * never false-block — the on-chain contract is still the final guard.
 */
export function evaluateTransferLimit(params: {
  usedLimit?: number | null;
  clientLimit?: number | null;
  amount: number;
  currency: string;
  usdRates?: Record<string, number> | null;
}): TransferLimitEval {
  const { usedLimit, clientLimit, amount, currency, usdRates } = params;
  const remainingChf = remainingLimitChf(usedLimit, clientLimit);
  const remainingInCurrency =
    remainingChf == null ? null : convertChfToCurrency(remainingChf, currency, usdRates);

  // No finite limit configured (or unknown inputs) → allow.
  if (remainingChf == null) {
    return {
      status: 'no_limit',
      block: false,
      fullyReached: false,
      wouldExceed: false,
      remainingChf: null,
      remainingInCurrency: null,
      amountChf: null,
    };
  }

  // Fully exhausted — the contract blocks ALL transfers regardless of amount.
  if (remainingChf <= 0) {
    return {
      status: 'fully_reached',
      block: true,
      fullyReached: true,
      wouldExceed: false,
      remainingChf: 0,
      remainingInCurrency: 0,
      amountChf: null,
    };
  }

  const amountChf = convertCurrencyToChf(amount, currency, usdRates);

  // Have headroom but no usable rate to size this tx → don't false-block;
  // let the on-chain preflight / contract reject if it actually overshoots.
  if (amountChf == null || amount <= 0) {
    return {
      status: 'ok',
      block: false,
      fullyReached: false,
      wouldExceed: false,
      remainingChf,
      remainingInCurrency,
      amountChf,
    };
  }

  // Small epsilon so a tx exactly at the limit isn't blocked by FX rounding.
  const wouldExceed = amountChf > remainingChf + 0.005;
  return {
    status: wouldExceed ? 'would_exceed' : 'ok',
    block: wouldExceed,
    fullyReached: false,
    wouldExceed,
    remainingChf,
    remainingInCurrency,
    amountChf,
  };
}

/** Format a headroom amount for display, e.g. `1,234.56 USD`. */
export function formatLimitAmount(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  let body: string;
  try {
    body = safe.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    body = safe.toFixed(2);
  }
  return `${body} ${currency.toUpperCase()}`;
}
