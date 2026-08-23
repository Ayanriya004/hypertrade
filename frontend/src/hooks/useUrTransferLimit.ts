/**
 * Reactive wrapper around `evaluateTransferLimit` that also produces the
 * localized banner copy each bank sheet renders. Pure (no network) — it relies
 * on the `usedLimit` / `clientLimit` already loaded with the UR profile and the
 * dashboard's `usdRates` (which now always includes CHF) to size the tx.
 *
 * Returns a drop-in replacement for the old per-sheet `limitReached` boolean
 * (`block`) plus richer fields for messaging.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  evaluateTransferLimit,
  formatLimitAmount,
  type TransferLimitEval,
} from '../lib/urTransferLimit';

export interface UseUrTransferLimitResult extends TransferLimitEval {
  /** Banner heading (empty when not blocking). */
  title: string;
  /** Banner body (empty when not blocking). */
  message: string;
}

export function useUrTransferLimit({
  usedLimit,
  clientLimit,
  amount,
  currency,
  usdRates,
}: {
  usedLimit?: number | null;
  clientLimit?: number | null;
  amount: number;
  currency: string;
  usdRates?: Record<string, number> | null;
}): UseUrTransferLimitResult {
  const { t } = useTranslation();

  return useMemo(() => {
    const evalResult = evaluateTransferLimit({
      usedLimit,
      clientLimit,
      amount,
      currency,
      usdRates,
    });

    let title = '';
    let message = '';

    if (evalResult.fullyReached) {
      title = t('bankLimit.fullyReachedTitle', { defaultValue: 'Monthly limit reached' });
      message = t('bankLimit.fullyReached', {
        defaultValue:
          "You've reached your monthly transfer limit. It resets on a rolling 30-day basis.",
      });
    } else if (evalResult.wouldExceed) {
      const remaining =
        evalResult.remainingInCurrency != null
          ? formatLimitAmount(evalResult.remainingInCurrency, currency)
          : evalResult.remainingChf != null
            ? formatLimitAmount(evalResult.remainingChf, 'CHF')
            : '';
      title = t('bankLimit.exceedTitle', { defaultValue: 'Over your monthly limit' });
      message = t('bankLimit.exceed', {
        remaining,
        defaultValue: `This is more than your remaining monthly limit of ${remaining}. Try a smaller amount.`,
      });
    }

    return { ...evalResult, title, message };
  }, [usedLimit, clientLimit, amount, currency, usdRates, t]);
}
