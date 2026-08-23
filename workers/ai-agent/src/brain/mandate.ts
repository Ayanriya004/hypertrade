/**
 * Direction constraint + mandate — WHAT the agent may do vs what success means.
 * Orthogonal to horizon (time structure) and riskProfile (entry appetite).
 *
 *   direction: long_short (default, "free form") | long_only | short_only
 *   mandate:   active (default, today's behavior) | accumulate (needs a
 *              direction: long = buy weakness to improve average; short =
 *              sell strength into overbought/euphoria; trim/cover rarely)
 *
 * Worker-enforced (prompt text alone is ignorable): a disallowed opening
 * direction is skipped (`skipped_direction_mandate`); a monitor flip into a
 * disallowed side is downgraded to cut. Accumulate does NOT force leverage —
 * the app floats a warning like the investor horizon does.
 */

export type Direction = 'long_short' | 'long_only' | 'short_only';
export type Mandate = 'active' | 'accumulate';

export function normalizeDirection(raw: unknown): Direction {
  if (raw === 'long_only') return 'long_only';
  if (raw === 'short_only') return 'short_only';
  return 'long_short';
}

export function normalizeMandate(raw: unknown): Mandate {
  return raw === 'accumulate' ? 'accumulate' : 'active';
}

export function directionAllows(direction: Direction, side: 'LONG' | 'SHORT'): boolean {
  if (direction === 'long_only') return side === 'LONG';
  if (direction === 'short_only') return side === 'SHORT';
  return true;
}

const DIR_WORD: Record<Exclude<Direction, 'long_short'>, 'LONG' | 'SHORT'> = {
  long_only: 'LONG',
  short_only: 'SHORT',
};

/** Opening-prompt block. Empty for free-form active (today's default). */
export function renderOpeningMandateSection(
  direction: Direction,
  mandate: Mandate,
): string {
  if (direction === 'long_short' && mandate === 'active') return '';
  const allowed = direction === 'long_short' ? null : DIR_WORD[direction];
  const dirBlock = allowed
    ? `
**DIRECTION MANDATE: ${allowed} ONLY** (user constraint — worker-enforced):
- You may ONLY open ${allowed}. ${allowed === 'LONG' ? 'SHORT' : 'LONG'} is NOT available; a ${allowed === 'LONG' ? 'bearish' : 'bullish'} read means FLAT, not the other side.
- FLAT is your ${allowed === 'LONG' ? 'bearish' : 'bullish'} expression — do not force a ${allowed} on a hostile tape just because it is the only direction.
- This is a ONE-SIDED campaign, not a random constraint: trade ${allowed} setups with normal discipline (enter on edge, take profit, re-enter) and sit out the rest.`
    : '';
  const mandateBlock =
    mandate === 'accumulate' && allowed
      ? allowed === 'LONG'
        ? `
**MANDATE: ACCUMULATE LONG** (success = better average entry over weeks, not trade count):
- Prefer buying WEAKNESS: flushes, panic wicks, oversold into support — never chase strength; a missed pop costs nothing.
- FLAT is always available and often correct — entries are NEVER forced. Waiting days for one good flush beats ten mediocre buys.
- NO automatic take-profit will be placed on this campaign: your take_profit_target is a REFERENCE level only (still required, still ≥ the R floor). Winners are held; profit-taking happens via monitor trims at extremes or the user. The stop-loss IS placed.
- This is a PERP, not spot: funding paid is a real carry cost of the campaign — factor it into how aggressively you add.`
        : `
**MANDATE: ACCUMULATE SHORT** (success = better average short entry over weeks, not trade count):
- Prefer selling STRENGTH: euphoric rallies, overbought spikes into resistance, crowded squeezes — never chase breakdowns; a missed flush costs nothing.
- FLAT is always available and often correct — entries are NEVER forced. Waiting days for one euphoria spike beats ten mediocre shorts.
- NO automatic take-profit will be placed on this campaign: your take_profit_target is a REFERENCE level only (still required, still ≥ the R floor). Covers happen via monitor trims at capitulation extremes or the user. The stop-loss IS placed.
- This is a PERP: funding is carry — positive funding pays your short, but a negative-funding regime is a real cost of the campaign. Squeeze risk is asymmetric on shorts — respect stops and size.`
      : '';
  return `${dirBlock}${mandateBlock}`;
}

/** Monitor-prompt block. Empty for free-form active. */
export function renderMonitorMandateSection(
  direction: Direction,
  mandate: Mandate,
): string {
  if (direction === 'long_short' && mandate === 'active') return '';
  const allowed = direction === 'long_short' ? null : DIR_WORD[direction];
  const dirLine = allowed
    ? `
- Direction mandate: ${allowed} ONLY — FLIP is NOT available (worker downgrades it to cut). Your exits are trim/cut; re-entry happens on a later ${allowed} setup.`
    : '';
  const mandateLines =
    mandate === 'accumulate' && allowed
      ? `
- MANDATE: ACCUMULATE ${allowed} — the goal is a better average over weeks. Adverse candles are opportunities to DCA (when thesis is INTACT and the DCA bar is met), not reasons to bail. ${allowed === 'LONG' ? 'Trim on euphoria/extremes' : 'Cover partially on capitulation flushes/extremes'} or thesis decay, not on ordinary ${allowed === 'LONG' ? 'red' : 'green'} hours.
- This position has NO automatic take-profit (by design): profit-taking happens ONLY through your trim decisions at extremes, thesis decay, or the user's own action. Do not treat a missing TP as an anomaly.
- Funding drag is a REAL act-reason under this mandate: check the funding/carry section — if accrued funding ${allowed === 'LONG' ? 'paid' : 'paid (negative-funding regime)'} is materially eroding margin (a meaningful share of unrealized P&L or of your risk budget), trimming or pausing adds is valid even with an intact thesis.${allowed === 'SHORT' ? ' When funding is positive, carry works FOR this campaign — patience is cheap.' : ''}`
      : '';
  if (!dirLine && !mandateLines) return '';
  return `

**MANDATE**:${dirLine}${mandateLines}`;
}
