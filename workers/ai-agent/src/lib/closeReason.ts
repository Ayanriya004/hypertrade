/**
 * Canonical `ai_agent_positions.close_reason` tokens.
 *
 * Status stays coarse:
 *   - OPEN
 *   - CLOSED          — agent intentional exit this cycle (exit/cut/flip/…)
 *   - CLOSED_BY_USER  — vanished on HL without an agent exit action
 *                       (stop/TP fill, liquidation, manual close, revoke adopt)
 *
 * Analytics / UI should read `close_reason`, not infer from status alone.
 */
export const CLOSE_REASON = {
  /** Exchange protective stop filled at (≈) tracked stop_loss. */
  STOP_FILL: 'stop_fill',
  /** Exchange take-profit filled at (≈) tracked take_profit. */
  TAKE_PROFIT_FILL: 'take_profit_fill',
  /** Liquidation fill detected on HL userFills. */
  LIQUIDATED: 'liquidated',
  /** Manual close or unknown external — SL/TP didn't match tracked levels. */
  CLOSED_EXTERNALLY: 'closed_externally',
  /** Backend revoke/delete adopted a stale OPEN row. */
  ADOPTED_ON_REVOKE: 'adopted_on_revoke',
  /** Agent monitor actions (status = CLOSED). */
  EXIT: 'exit',
  CUT: 'cut',
  FLIP: 'flip',
  TRIM_ESCALATED: 'trim_escalated',
  /** Remaining margin below budget-scaled dust floor — stub closed. */
  MARGIN_DUST: 'margin_dust',
} as const;

export type ExternalCloseReason =
  | typeof CLOSE_REASON.STOP_FILL
  | typeof CLOSE_REASON.TAKE_PROFIT_FILL
  | typeof CLOSE_REASON.LIQUIDATED
  | typeof CLOSE_REASON.CLOSED_EXTERNALLY;

/** Relative price match tolerance (15 bps) — tick/fee noise vs exact trigger. */
const LEVEL_MATCH_REL = 0.0015;

function nearLevel(price: number, level: number | null | undefined): boolean {
  if (price == null || !(price > 0)) return false;
  const lv = level == null ? NaN : Number(level);
  if (!(Number.isFinite(lv) && lv > 0)) return false;
  return Math.abs(price - lv) / lv <= LEVEL_MATCH_REL;
}

/**
 * Classify an external (non-agent-exit) close using tracked protective levels
 * and optional HL fill hints.
 *
 * If the user moved SL/TP on the exchange and DB wasn't reconciled yet, the
 * fill price won't match tracked levels → `closed_externally` (intentional).
 * When the fill matches the thesis levels (incl. agent-moved breakeven), we
 * label `stop_fill` / `take_profit_fill` for later analysis.
 */
export function classifyExternalCloseReason(args: {
  closePrice: number | null;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
  /** True when reducing fills are marked liquidation on HL. */
  liquidated?: boolean;
}): ExternalCloseReason {
  if (args.liquidated) return CLOSE_REASON.LIQUIDATED;

  const px = args.closePrice != null && Number.isFinite(args.closePrice)
    ? Number(args.closePrice)
    : null;
  if (px == null || !(px > 0)) return CLOSE_REASON.CLOSED_EXTERNALLY;

  const hitStop = nearLevel(px, args.stopLoss);
  const hitTp = nearLevel(px, args.takeProfit);

  if (hitStop && hitTp) {
    // Ambiguous (should be rare) — pick the closer absolute level.
    const sl = Number(args.stopLoss);
    const tp = Number(args.takeProfit);
    return Math.abs(px - sl) <= Math.abs(px - tp)
      ? CLOSE_REASON.STOP_FILL
      : CLOSE_REASON.TAKE_PROFIT_FILL;
  }
  if (hitStop) return CLOSE_REASON.STOP_FILL;
  if (hitTp) return CLOSE_REASON.TAKE_PROFIT_FILL;
  return CLOSE_REASON.CLOSED_EXTERNALLY;
}
