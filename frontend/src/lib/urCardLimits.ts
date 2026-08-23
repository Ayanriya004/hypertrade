/**
 * UR card limit buckets from `GET /api/v2/card` → `result.limits`.
 *
 * Authoritative fields (CHF-denominated per UR):
 *   - `contactless` — tap / contactless daily cap (`dailyUsed`, `dailyMax`, `dailyAvailable`)
 *   - `account` — rolling 30-day fiat envelope (`used`, `max`, `available`)
 *   - `withdrawal` — ATM sub-limit
 *   - `internetPurchase` — online purchase sub-limit
 */

import type { UrCardLimits } from './urApi';

/** UR card limits are denominated in CHF on the Fiat24 profile. */
export const UR_CARD_LIMIT_CURRENCY = 'CHF';

export interface UrCardLimitBucket {
  used: number;
  max: number;
  available?: number;
  dailyUsed?: number;
  dailyMax?: number;
  dailyAvailable?: number;
}

export interface UrCardLimitsBuckets {
  account?: UrCardLimitBucket & { restartDate?: string; restartDateMs?: number };
  withdrawal?: UrCardLimitBucket;
  internetPurchase?: UrCardLimitBucket;
  contactless?: UrCardLimitBucket;
}

function parseLimitNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseBucket(raw: unknown): UrCardLimitBucket | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const used = parseLimitNumber(row.used);
  const max = parseLimitNumber(row.max);
  const available = parseLimitNumber(row.available);
  const dailyUsed = parseLimitNumber(row.dailyUsed);
  const dailyMax = parseLimitNumber(row.dailyMax);
  const dailyAvailable = parseLimitNumber(row.dailyAvailable);

  if (
    used == null &&
    max == null &&
    dailyUsed == null &&
    dailyMax == null &&
    dailyAvailable == null
  ) {
    return undefined;
  }

  return {
    used: used ?? 0,
    max: max ?? 0,
    ...(available != null ? { available } : {}),
    ...(dailyUsed != null ? { dailyUsed } : {}),
    ...(dailyMax != null ? { dailyMax } : {}),
    ...(dailyAvailable != null ? { dailyAvailable } : {}),
  };
}

/** Normalise UR's card `limits` object into typed buckets. */
export function normalizeUrCardLimits(raw: UrCardLimits | null | undefined): UrCardLimitsBuckets | null {
  if (!raw || typeof raw !== 'object') return null;

  const accountRaw = raw.account;
  const account = parseBucket(accountRaw);
  const restartDate =
    accountRaw && typeof accountRaw === 'object'
      ? (accountRaw as { restartDate?: string }).restartDate
      : undefined;
  const restartDateMs =
    accountRaw && typeof accountRaw === 'object'
      ? parseLimitNumber((accountRaw as { restartDateMs?: unknown }).restartDateMs)
      : undefined;

  const withdrawal = parseBucket(raw.withdrawal);
  const internetPurchase = parseBucket(raw.internetPurchase);
  const contactless = parseBucket(raw.contactless);

  if (!account && !withdrawal && !internetPurchase && !contactless) return null;

  return {
    ...(account
      ? {
          account: {
            ...account,
            ...(restartDate ? { restartDate } : {}),
            ...(restartDateMs != null ? { restartDateMs } : {}),
          },
        }
      : {}),
    ...(withdrawal ? { withdrawal } : {}),
    ...(internetPurchase ? { internetPurchase } : {}),
    ...(contactless ? { contactless } : {}),
  };
}

/** Remaining headroom for a bucket; prefers server `available` / `dailyAvailable`. */
export function bucketRemaining(bucket: UrCardLimitBucket | undefined): number | null {
  if (!bucket) return null;
  if (typeof bucket.dailyAvailable === 'number' && Number.isFinite(bucket.dailyAvailable)) {
    return Math.max(0, bucket.dailyAvailable);
  }
  if (typeof bucket.available === 'number' && Number.isFinite(bucket.available)) {
    return Math.max(0, bucket.available);
  }
  if (bucket.max <= 0) return null;
  return Math.max(0, bucket.max - bucket.used);
}

/** Usage ratio 0–1; returns 0 when max is unset/zero. */
export function bucketUsagePct(bucket: UrCardLimitBucket | undefined): number {
  if (!bucket || bucket.max <= 0) return 0;
  return Math.min(1, Math.max(0, bucket.used / bucket.max));
}

/**
 * Daily contactless ring — from `limits.contactless` (`dailyAvailable` / `dailyMax`).
 */
export function resolveContactlessDailyLimit(
  contactless: UrCardLimitBucket | undefined,
): UrCardLimitBucket | null {
  if (!contactless) return null;

  const dailyMax = contactless.dailyMax ?? 0;
  const dailyAvailable = contactless.dailyAvailable;
  const dailyUsed = contactless.dailyUsed;

  if (dailyMax > 0) {
    const used =
      dailyUsed != null
        ? Math.min(dailyMax, Math.max(0, dailyUsed))
        : dailyAvailable != null
          ? Math.min(dailyMax, Math.max(0, dailyMax - dailyAvailable))
          : contactless.used > 0
            ? Math.min(dailyMax, contactless.used)
            : 0;
    return {
      used,
      max: dailyMax,
      available: dailyAvailable ?? Math.max(0, dailyMax - used),
      dailyUsed: used,
      dailyMax,
      dailyAvailable: dailyAvailable ?? Math.max(0, dailyMax - used),
    };
  }

  if (dailyAvailable != null) {
    return {
      used: 0,
      max: dailyAvailable,
      available: dailyAvailable,
      dailyAvailable,
    };
  }

  return null;
}

/**
 * Rolling 30-day account ring — from `limits.account` (`available` / `max` / `used`).
 */
export function resolveAccountRollingLimit(
  account: UrCardLimitBucket | undefined,
): UrCardLimitBucket | null {
  if (!account || account.max <= 0) return null;
  const used = Math.min(account.max, Math.max(0, account.used));
  const available =
    account.available != null ? Math.max(0, account.available) : Math.max(0, account.max - used);
  return {
    used,
    max: account.max,
    available,
  };
}
