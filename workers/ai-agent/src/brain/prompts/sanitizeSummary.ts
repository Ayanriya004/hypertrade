/**
 * Display sanitizers for LLM text fields shown in the UI.
 * Never touch symbol columns, cloids, order ids, or other integration keys.
 */

/** Strip HIP-3 venue prefixes from prose (XYZ:TSLA → TSLA). */
export function stripHip3DexPrefix(text: string): string {
  // DEX:COIN only — requires letter-led coin so we don't mangle URLs / times.
  return text.replace(/\b[A-Z]{2,10}:([A-Z][A-Z0-9]{0,15})\b/g, '$1');
}

/**
 * Shared monitor JSON field rule: summary = thesis, not fill/size mechanics.
 * The worker skips/escalates untradeable trims after the model decides.
 */
export const MONITOR_SUMMARY_FIELD_RULE = `"summary" MUST begin with the exact prefix "Summary: " then 1-2 plain-English
sentences for non-traders — the MARKET THESIS only (why the original idea still
holds, weakened, or broke, and what buyers/sellers are doing). No raw metrics
or abbreviations (no OI, bps, CVD, IV).
Do NOT mention execution mechanics: min order size, leftover dust, "too small
to trim", whether a slice would leave a stub, young-position guards. The engine
enforces those after you decide. If the thesis says reduce, return TRIM (or CUT)
— never write a "I would trim but the leftover is too small" summary that
contradicts your reason.`;

/** Min-size / dust / leftover-stub talk that crowds out the thesis in the feed. */
const SIZE_MECHANICS =
  /too small to (?:trim|leave|keep|partially)|order will become too small|(?:leftover|remainder|stub).{0,48}(?:too small|dust|below)|below the min(?:imum)?(?: order)? size|min(?:imum)? order size|dust[- ]sized leftover|would leave (?:a )?(?:dust|stub|leftover)|can(?:not|'t) trim (?:it )?(?:without|because)|position (?:is|will be|would be|would become) too small|trim would (?:have )?(?:left|leave|escalate)|flattened instead of kept|young (?:position )?and a trim|wanted to trim but/i;

/** Drop sentences about order-size floors so the UI stays on thesis. */
export function stripSizeMechanicsFromSummary(text: string): string {
  const body = text.replace(/^summary\s*:\s*/i, '').trim();
  if (!body) return '';
  const sentences = body.match(/[^.!?]+[.!?]*\s*/g) ?? [body];
  const kept = sentences.filter((s) => s.trim() && !SIZE_MECHANICS.test(s));
  return kept.join(' ').trim();
}

/** Display-only plain-English line; force "Summary: " prefix, clamp length. */
export function sanitizeMonitorSummary(response: {
  summary?: unknown;
  reasoning?: unknown;
  reason?: unknown;
}): void {
  if (typeof response.summary === 'string' && response.summary.trim()) {
    let s = stripHip3DexPrefix(response.summary.trim());
    const body = stripSizeMechanicsFromSummary(s);
    if (!body) {
      delete response.summary;
    } else {
      s = `Summary: ${body}`;
      response.summary = s.length > 500 ? `${s.slice(0, 497)}...` : s;
    }
  } else {
    delete response.summary;
  }

  // User-visible audit text — strip DEX prefixes; leave metrics intact.
  if (typeof response.reasoning === 'string' && response.reasoning.trim()) {
    response.reasoning = stripHip3DexPrefix(response.reasoning);
  }
  if (typeof response.reason === 'string' && response.reason.trim()) {
    response.reason = stripHip3DexPrefix(response.reason);
  }
}
