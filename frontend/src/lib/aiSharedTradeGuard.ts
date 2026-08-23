import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AiAgentPosition } from './api';

/** Global dismiss for the shared-mode manual-trade warning (one-time). */
const DISMISS_KEY = 'ai_shared_trade_warn_dismissed_v1';

export async function isSharedAiTradeWarnDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DISMISS_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setSharedAiTradeWarnDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // ignore
  }
}

const RESTING_SHARED_DISMISS_KEY = 'ai_resting_limit_shared_warn_dismissed_v1';
const RESTING_DEDICATED_FUND_DISMISS_KEY = 'ai_resting_limit_dedicated_fund_warn_dismissed_v1';

export async function isRestingLimitSharedWarnDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(RESTING_SHARED_DISMISS_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setRestingLimitSharedWarnDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(RESTING_SHARED_DISMISS_KEY, '1');
  } catch {
    // ignore
  }
}

export async function isRestingLimitDedicatedFundWarnDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(RESTING_DEDICATED_FUND_DISMISS_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setRestingLimitDedicatedFundWarnDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(RESTING_DEDICATED_FUND_DISMISS_KEY, '1');
  } catch {
    // ignore
  }
}

/** Normalize HL coin / display symbol for comparison (main-dex only in V1). */
export function normalizeAiTradeSymbol(symbol: string): string {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/^[^:]+:/, '');
}

/**
 * Open Shared-mode (copilot) agent position on this symbol + trading env.
 * Dedicated agents trade a sub-account — manual master trades don't hit them.
 */
export function findSharedAiConflict(
  positions: AiAgentPosition[] | null | undefined,
  symbol: string,
  tradingEnv: 'mainnet' | 'demo',
): AiAgentPosition | null {
  const want = normalizeAiTradeSymbol(symbol);
  if (!want || want.includes(':')) return null;
  const isDemo = tradingEnv === 'demo';
  for (const p of positions ?? []) {
    if (p.agentMode !== 'copilot') continue;
    if ((p.tradingEnv === 'demo') !== isDemo) continue;
    if (normalizeAiTradeSymbol(p.symbol) === want) return p;
  }
  return null;
}
