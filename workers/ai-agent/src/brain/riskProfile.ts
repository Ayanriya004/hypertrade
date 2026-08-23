/**
 * Risk profiles — how willing an agent is to ENTER (never how sloppily it
 * manages risk once in).
 *
 *   standard   — current behavior: patient, sidelines readily in ambiguity.
 *   aggressive — higher risk/reward: lower conviction gates, guards modulate
 *                SIZE instead of mandating FLAT. Size bands, stops, leverage
 *                caps, budget caps and all monitor risk management are
 *                IDENTICAL across profiles — aggression buys more positions,
 *                not bigger ones.
 *
 * Effective profile is also session-aware: during the thin-liquidity window
 * (Fri 19:00–Sun 21:00 UTC) aggressive agents run as standard. Stored config
 * is never mutated — this is decide-time only.
 */

import { isThinLiquidityWindow } from './session-context.js';

export type RiskProfile = 'standard' | 'aggressive';

export function normalizeRiskProfile(raw: unknown): RiskProfile {
  return raw === 'aggressive' ? 'aggressive' : 'standard';
}

/**
 * Decide-time profile: force standard in thin hours; otherwise honor stored
 * config (backend currently forces aggressive on create).
 */
export function effectiveRiskProfile(
  stored: unknown,
  at: Date = new Date(),
): RiskProfile {
  if (isThinLiquidityWindow(at)) return 'standard';
  return normalizeRiskProfile(stored);
}

/** Conviction gate for full-size opening (probe tier sits just under it). */
export function openingConvictionGate(isWeekend: boolean, profile: RiskProfile): number {
  if (profile === 'aggressive') return isWeekend ? 22 : 20;
  return isWeekend ? 30 : 25;
}

/** Exploratory-probe floor: within 10 pts under the gate (absolute floor 10). */
export function openingProbeFloor(gate: number): number {
  return Math.max(10, gate - 10);
}

/**
 * Earnings-window (≤48h) gate for fresh equity opens — worker-enforced.
 * Standard: strong setups only. Aggressive: normal lean can trade through
 * (gap risk accepted by the user's own dial).
 */
export function earningsConvictionGate(profile: RiskProfile): number {
  return profile === 'aggressive' ? 35 : 50;
}
