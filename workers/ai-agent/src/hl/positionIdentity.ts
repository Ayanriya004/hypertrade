/**
 * Decide whether a live HL perp is still the tracked AI position, or a
 * manual reopen after an external close (TP/SL/user).
 *
 * DB already stores entry_price, opened_at, cloid_prefix — reconcile used to
 * only check symbol + direction, which falsely adopted user reopens.
 */

export type HlFillLite = {
  coin?: unknown;
  side?: unknown;
  sz?: unknown;
  time?: unknown;
  timestamp?: unknown;
  cloid?: unknown;
  c?: unknown;
  /** Signed position size before this fill (HL). */
  startPosition?: unknown;
  dir?: unknown;
};

/** Avg entry can drift on add/DCA; beyond this → treat as a different position. */
export const ENTRY_MATCH_TOL = 0.03;

function fillDeltaSz(f: HlFillLite): number {
  const sz = Math.abs(Number(f.sz ?? 0));
  if (!(sz > 0)) return 0;
  const side = String(f.side ?? '').toUpperCase();
  if (side === 'B' || side === 'BUY' || side === 'BID') return sz;
  if (side === 'A' || side === 'SELL' || side === 'ASK') return -sz;
  // Fallback: dir strings from HL ("Open Long", "Close Short", …)
  const dir = String(f.dir ?? '').toLowerCase();
  if (dir.includes('long') && dir.includes('open')) return sz;
  if (dir.includes('long') && dir.includes('close')) return -sz;
  if (dir.includes('short') && dir.includes('open')) return -sz;
  if (dir.includes('short') && dir.includes('close')) return sz;
  return 0;
}

export function entriesLikelySame(
  trackedEntry: number,
  liveEntry: number,
  tol = ENTRY_MATCH_TOL,
): boolean {
  if (!(trackedEntry > 0 && liveEntry > 0)) return false;
  return Math.abs(liveEntry - trackedEntry) / trackedEntry <= tol;
}

export function cloidMatchesPrefix(
  cloid: unknown,
  prefix: string | null | undefined,
): boolean {
  if (!prefix) return false;
  const c = String(cloid ?? '').toLowerCase();
  const p = prefix.toLowerCase();
  return c.length > 0 && c.startsWith(p);
}

/**
 * Walk fills since open. If the book went flat and a later open is not tagged
 * with this agent's cloid prefix, the live position is the user's (foreign).
 */
export function livePositionOwnedViaFills(args: {
  fills: HlFillLite[];
  symbol: string;
  openedAtIso: string;
  cloidPrefix: string | null | undefined;
}): 'ours' | 'foreign' | 'unknown' {
  const sym = args.symbol.toUpperCase();
  const openedMs = Date.parse(args.openedAtIso);
  const sinceMs = Number.isFinite(openedMs) ? openedMs - 5_000 : 0;

  const relevant = (args.fills ?? [])
    .filter((f) => String(f.coin ?? '').toUpperCase() === sym)
    .map((f) => {
      const t = Number(f.time ?? f.timestamp ?? 0);
      return { f, t };
    })
    .filter(({ t }) => Number.isFinite(t) && t >= sinceMs)
    .sort((a, b) => a.t - b.t);

  if (relevant.length === 0) return 'unknown';

  let signed = 0;
  let sawFlat = false;
  let seeded = false;
  const eps = 1e-9;

  for (const { f } of relevant) {
    const delta = fillDeltaSz(f);
    if (delta === 0) continue;

    const startRaw = Number(f.startPosition);
    const prev = Number.isFinite(startRaw)
      ? startRaw
      : seeded
        ? signed
        : 0;
    const next = Number.isFinite(startRaw) ? startRaw + delta : prev + delta;
    seeded = true;
    signed = next;

    const wasOpen = Math.abs(prev) > eps;
    const nowFlat = Math.abs(next) <= eps;
    const flipped =
      (prev > eps && next < -eps) || (prev < -eps && next > eps);

    if ((wasOpen && nowFlat) || flipped) {
      sawFlat = true;
      if (nowFlat) continue;
    }

    // First fill that establishes size after a flat stretch = reopen.
    if (sawFlat && Math.abs(next) > eps) {
      const cloid = f.cloid ?? f.c;
      if (!cloidMatchesPrefix(cloid, args.cloidPrefix)) {
        return 'foreign';
      }
      // Agent re-opened (rare) — keep tracking from here.
      sawFlat = false;
    }
  }

  return 'ours';
}

/**
 * Combine fill evidence with entry proximity when fills are ambiguous.
 *
 * Intentionally **no size check** here: add/DCA legitimately changes notional.
 * Size is only used on the portfolio *badge* (UI fail-closed). Dropping a DB
 * OPEN row requires flatten, entry divergence, or fill proof of a foreign reopen.
 */
export function resolveLiveOwnership(args: {
  fills: HlFillLite[] | null;
  symbol: string;
  openedAtIso: string;
  cloidPrefix: string | null | undefined;
  trackedEntry: number;
  liveEntry: number;
  sameDirection: boolean;
}): boolean {
  if (!args.sameDirection) return false;

  if (args.fills) {
    const via = livePositionOwnedViaFills({
      fills: args.fills,
      symbol: args.symbol,
      openedAtIso: args.openedAtIso,
      cloidPrefix: args.cloidPrefix,
    });
    if (via === 'foreign') return false;
    if (via === 'ours') return true;
  }

  return entriesLikelySame(args.trackedEntry, args.liveEntry);
}
