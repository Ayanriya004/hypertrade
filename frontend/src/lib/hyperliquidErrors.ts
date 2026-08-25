import i18n from '../i18n';

/**
 * Map raw Hyperliquid / transport errors to user-facing copy.
 * Uses the global i18n instance so strings follow the user's language outside React.
 */
export function humanizeHyperliquidError(raw: string): { title: string; message: string } {
  const msg = (raw || '').toString();
  const t = (key: string) => String(i18n.t(key));

  // Hyperliquid rate limit (per address). HL returns a bare HTTP 429 (no body)
  // when an address-based action quota is exhausted, throttling further
  // actions to 1 / 10s. See https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
  if (/(^|[^\d])429([^\d]|$)/.test(msg) || /rate.?limit/i.test(msg)) {
    return {
      title: t('errors.hyperliquid.rateLimitedTitle'),
      message: t('errors.hyperliquid.rateLimitedMessage'),
    };
  }

  // Spot transfer / insufficient spot collateral (Hyperliquid insufficientSpotBalance API error)
  if (
    /insufficient\s+balance\s+for\s+token\s+transfer/i.test(msg) ||
    /insufficientSpotBalance/i.test(msg) ||
    /insufficient_spot_balance/i.test(msg)
  ) {
    return {
      title: t('errors.hyperliquid.insufficientSpotBalanceTitle'),
      message: t('errors.hyperliquid.insufficientSpotBalanceMessage'),
    };
  }

  // HL OI-cap rejects. Live `error` strings are prose; historical statuses
  // use the camelCase types. See
  // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses
  //   PositionIncreaseAtOpenInterestCap / PositionFlipAtOpenInterestCap
  //     "Order would increase open interest while open interest is capped"
  //   TooAggressiveAtOpenInterestCap
  //     "Order rejected due to price more aggressive than oracle while at open interest cap"
  //   OpenInterestIncrease
  //     "Order would increase open interest too quickly"
  if (
    /openInterestCap/i.test(msg) ||
    /OpenInterestIncrease/i.test(msg) ||
    /open interest is capped/i.test(msg) ||
    /at open interest cap/i.test(msg) ||
    /increase open interest too quickly/i.test(msg)
  ) {
    return {
      title: t('errors.hyperliquid.openInterestCapTitle'),
      message: t('errors.hyperliquid.openInterestCapMessage'),
    };
  }

  // Common order rejections (from HL docs / SDK enums)
  const map: Array<{ key: string; titleKey: string; messageKey: string }> = [
    { key: 'tickRejected', titleKey: 'errors.hyperliquid.tickRejectedTitle', messageKey: 'errors.hyperliquid.tickRejectedMessage' },
    { key: 'badTriggerPxRejected', titleKey: 'errors.hyperliquid.badTriggerPxRejectedTitle', messageKey: 'errors.hyperliquid.badTriggerPxRejectedMessage' },
    { key: 'badAloPxRejected', titleKey: 'errors.hyperliquid.badAloPxRejectedTitle', messageKey: 'errors.hyperliquid.badAloPxRejectedMessage' },
    { key: 'iocCancelRejected', titleKey: 'errors.hyperliquid.iocCancelRejectedTitle', messageKey: 'errors.hyperliquid.iocCancelRejectedMessage' },
    { key: 'marketOrderNoLiquidityRejected', titleKey: 'errors.hyperliquid.marketOrderNoLiquidityRejectedTitle', messageKey: 'errors.hyperliquid.marketOrderNoLiquidityRejectedMessage' },
    {
      key: "couldn't immediately match against any resting orders",
      titleKey: 'errors.hyperliquid.noRestingMatchTitle',
      messageKey: 'errors.hyperliquid.noRestingMatchMessage',
    },
    {
      key: 'couldnt immediately match against any resting orders',
      titleKey: 'errors.hyperliquid.noRestingMatchTitle',
      messageKey: 'errors.hyperliquid.noRestingMatchMessage',
    },
    { key: 'perpMarginRejected', titleKey: 'errors.hyperliquid.perpMarginRejectedTitle', messageKey: 'errors.hyperliquid.perpMarginRejectedMessage' },
    { key: 'reduceOnlyRejected', titleKey: 'errors.hyperliquid.reduceOnlyRejectedTitle', messageKey: 'errors.hyperliquid.reduceOnlyRejectedMessage' },
    { key: 'minTradeNtlRejected', titleKey: 'errors.hyperliquid.minTradeNtlRejectedTitle', messageKey: 'errors.hyperliquid.minTradeNtlRejectedMessage' },
    { key: 'oracleRejected', titleKey: 'errors.hyperliquid.oracleRejectedTitle', messageKey: 'errors.hyperliquid.oracleRejectedMessage' },
  ];

  for (const m of map) {
    if (msg.includes(m.key)) return { title: t(m.titleKey), message: t(m.messageKey) };
  }

  if (msg.toLowerCase().includes('insufficient') && msg.toLowerCase().includes('margin')) {
    return {
      title: t('errors.hyperliquid.insufficientMarginTitle'),
      message: t('errors.hyperliquid.insufficientMarginMessage'),
    };
  }

  return {
    title: t('errors.hyperliquid.orderFailedTitle'),
    message: msg || t('errors.hyperliquid.unknownError'),
  };
}
