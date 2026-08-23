/**
 * Book-level win rate from Hyperliquid fills.
 *
 * HL has no win-rate field. `portfolio` is PnL + volume only. A "win" is a
 * completed **round trip** (flat → open → flat, or a flip) whose net
 * closedPnl minus fees is > 0. Partial scale-outs are one trade, not many.
 *
 * Matches the "trading with AI" book: Dedicated = the whole sub; Shared =
 * master fills on that agent's assigned symbols (AI + your manuals there).
 *
 * Replay needs per-fill `startPosition` (`aggregateByTime: false`). Aggregated
 * fills hide flatten gaps.
 */

export type HlWinRateFill = {
  coin?: unknown;
  side?: unknown;
  sz?: unknown;
  time?: unknown;
  timestamp?: unknown;
  startPosition?: unknown;
  dir?: unknown;
  closedPnl?: unknown;
  fee?: unknown;
};

export type RoundTripWinRate = {
  closed: number;
  wins: number;
  /** Null when there are no completed round trips yet — callers show 0.00%. */
  winRatePct: number | null;
};

const EPS = 1e-9;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function fillDeltaSz(f: HlWinRateFill): number {
  const sz = Math.abs(num(f.sz));
  if (!(sz > 0)) return 0;
  const side = String(f.side ?? '').toUpperCase();
  if (side === 'B' || side === 'BUY' || side === 'BID') return sz;
  if (side === 'A' || side === 'SELL' || side === 'ASK') return -sz;
  const dir = String(f.dir ?? '').toLowerCase();
  if (dir.includes('long') && dir.includes('open')) return sz;
  if (dir.includes('long') && dir.includes('close')) return -sz;
  if (dir.includes('short') && dir.includes('open')) return -sz;
  if (dir.includes('short') && dir.includes('close')) return sz;
  return 0;
}

function isPerpFill(f: HlWinRateFill): boolean {
  const coin = String(f.coin ?? '').trim();
  if (!coin) return false;
  // Spot: `@107` token ids, `PURR/USDC` pairs.
  if (coin.startsWith('@') || coin.includes('/')) return false;
  return true;
}

function fillTime(f: HlWinRateFill): number {
  const t = num(f.time) || num(f.timestamp);
  return t;
}

/** `xyz:TSLA` matches allowlist `TSLA` or `xyz:TSLA`. */
export function fillCoinInAllowlist(coin: unknown, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const c = String(coin ?? '').toUpperCase();
  if (!c) return false;
  const bare = c.includes(':') ? c.slice(c.indexOf(':') + 1) : c;
  for (const raw of allowlist) {
    const u = String(raw ?? '').toUpperCase();
    if (!u) continue;
    const uBare = u.includes(':') ? u.slice(u.indexOf(':') + 1) : u;
    if (c === u || bare === uBare) return true;
  }
  return false;
}

function roundTripsOnCoin(fills: HlWinRateFill[]): { closed: number; wins: number } {
  const ordered = [...fills].sort((a, b) => fillTime(a) - fillTime(b));
  let signed = 0;
  let tripPnl = 0;
  let seeded = false;
  let closed = 0;
  let wins = 0;

  const settle = () => {
    closed += 1;
    if (tripPnl > 0) wins += 1;
    tripPnl = 0;
  };

  for (const f of ordered) {
    const delta = fillDeltaSz(f);
    if (delta === 0) continue;

    const startRaw = Number(f.startPosition);
    const prev = Number.isFinite(startRaw) ? startRaw : seeded ? signed : 0;
    const next = Number.isFinite(startRaw) ? startRaw + delta : prev + delta;
    seeded = true;
    signed = next;

    const wasOpen = Math.abs(prev) > EPS;
    const nowOpen = Math.abs(next) > EPS;
    const nowFlat = !nowOpen;
    const flipped = (prev > EPS && next < -EPS) || (prev < -EPS && next > EPS);

    if (wasOpen || nowOpen || flipped) {
      tripPnl += num(f.closedPnl) - num(f.fee);
    }

    if ((wasOpen && nowFlat) || flipped) {
      settle();
    }
  }

  return { closed, wins };
}

/**
 * @param symbols If set, only those coins (Shared agent allowlist). Omit for
 *   the whole book (Dedicated sub).
 */
export function roundTripWinRate(
  fills: HlWinRateFill[] | null | undefined,
  symbols?: string[] | null,
): RoundTripWinRate {
  const allow = (symbols ?? []).map((s) => String(s).toUpperCase()).filter(Boolean);
  const restrict = symbols != null;
  const byCoin = new Map<string, HlWinRateFill[]>();

  for (const f of fills ?? []) {
    if (!isPerpFill(f)) continue;
    if (restrict && !fillCoinInAllowlist(f.coin, allow)) continue;
    const key = String(f.coin ?? '').toUpperCase();
    const list = byCoin.get(key);
    if (list) list.push(f);
    else byCoin.set(key, [f]);
  }

  let closed = 0;
  let wins = 0;
  for (const coinFills of byCoin.values()) {
    const r = roundTripsOnCoin(coinFills);
    closed += r.closed;
    wins += r.wins;
  }

  return {
    closed,
    wins,
    winRatePct: closed > 0 ? Math.round((1000 * wins) / closed) / 10 : 0,
  };
}
