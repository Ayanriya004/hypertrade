/**
 * Shared "leverage risk" prompt section for the winning/losing monitors.
 *
 * Design decision (see docs/AI_AGENTS.md): the THESIS is always evaluated
 * in raw price-% — every numeric threshold in the monitor prompts is
 * calibrated to price moves, and whether a thesis is right has nothing to do
 * with the user's leverage choice. Feeding ROE into those thresholds would
 * make a 40x agent panic-trim on 0.05% wiggles. Leverage instead enters the
 * decision as SURVIVAL risk: the model sees ROE, margin at risk, and distance
 * to liquidation, with an explicit rule that urgency (trim / tighten stop)
 * scales with liquidation proximity — independent of thesis validity.
 */

export interface LeverageRiskPositionContext {
  leverage: number
  roe_pct?: number
  margin_usd?: number
  liquidation_price?: number | null
  liquidation_distance_pct?: number | null
  /** 'isolated' = this position's margin is its ENTIRE liquidation buffer. */
  margin_type?: 'cross' | 'isolated' | null
}

export function buildLeverageRiskSection(p: LeverageRiskPositionContext): string {
  const lev = Number.isFinite(p.leverage) && p.leverage > 0 ? p.leverage : 1
  const marginText =
    typeof p.margin_usd === 'number' && Number.isFinite(p.margin_usd) && p.margin_usd > 0
      ? `$${p.margin_usd.toFixed(2)}`
      : 'N/A'
  const roeText =
    typeof p.roe_pct === 'number' && Number.isFinite(p.roe_pct)
      ? `${p.roe_pct >= 0 ? '+' : ''}${p.roe_pct.toFixed(2)}%`
      : 'N/A'
  const hasLiq =
    typeof p.liquidation_price === 'number' &&
    Number.isFinite(p.liquidation_price) &&
    p.liquidation_price > 0 &&
    typeof p.liquidation_distance_pct === 'number' &&
    Number.isFinite(p.liquidation_distance_pct)
  const liqText = hasLiq
    ? `$${(p.liquidation_price as number).toLocaleString()} (**${(p.liquidation_distance_pct as number).toFixed(2)}% away** from current price)`
    : 'N/A (not reported — treat as unknown, not as safe)'
  const liqWarning =
    hasLiq && (p.liquidation_distance_pct as number) < 3
      ? '\n- 🚨 **LIQUIDATION PROXIMITY WARNING**: liquidation is < 3% away — protecting the position from liquidation outranks thesis patience.'
      : ''

  const marginTypeLine =
    p.margin_type === 'isolated'
      ? '\n- Margin Mode: **ISOLATED** — this position\'s own margin is its ENTIRE liquidation buffer (the shared account pool does NOT back it). Liquidation distance is fixed near 1/leverage; treat the liquidation line above as hard and act earlier than you would on a cross position.'
      : p.margin_type === 'cross'
        ? '\n- Margin Mode: cross (backed by the shared account pool)'
        : ''

  return `
**LEVERAGE RISK CONTEXT**:
- Leverage: **${lev}x** — Margin at Risk: ${marginText}
- ROE (P&L on margin — what the user actually experiences): **${roeText}**
- Liquidation Price: ${liqText}${liqWarning}${marginTypeLine}

⚠️ **RISK RULE**: Every % threshold in this prompt is a PRICE-move % — judge the THESIS in price terms; leverage does not change whether the thesis is right. But leverage DOES change survival risk: at high leverage a small adverse price move liquidates the position before the thesis can play out. If liquidation distance is small (roughly < 2× a typical 4h range, or < 3%), prefer trim / stop-tightening over patient holding EVEN IF the thesis is intact. Surviving to be right matters more than being right. Do NOT use ROE to judge the thesis — use it only to gauge how much pain the user is absorbing. Do NOT HOLD solely because a trim slice might be under a min order — return the thesis action; the engine handles untradeable sizes.`
}
