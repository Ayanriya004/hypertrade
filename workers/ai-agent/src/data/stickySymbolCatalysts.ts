/**
 * Per-symbol sticky catalysts — ticker-specific ongoing stories for agents.
 *
 * Complements the global sticky board (geo/rates/reg backdrop). Here we want
 * name-specific catalysts the model won't invent from OI alone: Clarity Act
 * deadlines (CRCL), partnerships, unlocks, lawsuits, product launches, etc.
 * Earnings dates stay on the existing earnings block — do not duplicate them.
 *
 * Cadence: refresh at the same Asia/US sticky slots as the global board, for
 * active-agent symbols whose cache is missing/expired (capped per cycle so we
 * don't blast Gemini). Between slots, agents only READ the cache. Bootstrap:
 * first miss can produce outside a slot (still capped).
 */
import { coinPart } from '../brain/assetClass.js';
import {
  getOrRefreshGlobalContext,
  readGlobalContext,
  readGlobalContextAny,
  writeGlobalContext,
} from '../lib/globalCache.js';
import {
  STICKY_SCORE_RUBRIC,
  computeBoardSentiment,
  currentStickyRefreshSlot,
  formatStickyScores,
  geminiSearchText,
  normalizeHorizon,
  normalizeScore05,
  stripJsonFence,
  type StickyHorizon,
  type StickyNarrativeStatus,
} from './stickyNarratives.js';

/** Free-form enough for partnerships / legal / product — not the global board enum. */
export type StickyCatalystTheme =
  | 'REGULATION'
  | 'PARTNERSHIP'
  | 'PRODUCT'
  | 'UNLOCK'
  | 'LEGAL'
  | 'MACRO_LINK'
  | 'M_AND_A'
  | 'FUNDING'
  | 'TOKENOMICS'
  | 'GOVERNANCE'
  | 'SECURITY'
  | 'TEAM'
  | 'NETWORK'
  | 'ETF'
  | 'OTHER';

export interface StickySymbolCatalyst {
  id: string;
  theme: StickyCatalystTheme;
  title: string;
  summary: string;
  biasHint: string;
  status: StickyNarrativeStatus;
  /** 0–1 bearish · 2–3 neutral · 4–5 bullish for this ticker. */
  sentiment: number;
  /** 0–5 reprice power now (surprise×force×mag×timing×credibility). */
  tradability: number;
  horizon: StickyHorizon;
}

export interface StickySymbolCatalysts {
  symbol: string;
  catalysts: StickySymbolCatalyst[];
  updatedAt: string;
  slotKey?: string;
  /** Net lean for this ticker's catalyst set (0–5 sentiment scale). */
  boardSentiment?: number;
  /** Empty board is valid — "no sticky ticker catalyst right now". */
  none?: boolean;
}

const TTL_MS = 12 * 60 * 60 * 1000;
/** Failed refresh: keep prior board readable but retry much sooner than TTL. */
const FAILURE_RETRY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CATALYSTS = 4;
/** Soft cap so a dense agent universe doesn't N× Gemini-search every slot. */
const MAX_REFRESH_PER_CYCLE = 8;
const MAX_BOOTSTRAP_PER_CYCLE = 3;

const THEMES = new Set<StickyCatalystTheme>([
  'REGULATION',
  'PARTNERSHIP',
  'PRODUCT',
  'UNLOCK',
  'LEGAL',
  'MACRO_LINK',
  'M_AND_A',
  'FUNDING',
  'TOKENOMICS',
  'GOVERNANCE',
  'SECURITY',
  'TEAM',
  'NETWORK',
  'ETF',
  'OTHER',
]);
const STATUSES = new Set<StickyNarrativeStatus>([
  'unchanged',
  'intensified',
  'new',
  'resolved',
]);

function cacheKey(displaySymbol: string): string {
  return `sticky_symbol_${displaySymbol.toUpperCase()}_v1`;
}

function normalizeCatalyst(raw: unknown, idx: number): StickySymbolCatalyst | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const theme = String(o.theme ?? 'OTHER').toUpperCase() as StickyCatalystTheme;
  const status = String(o.status ?? 'new').toLowerCase() as StickyNarrativeStatus;
  const title = String(o.title ?? '').trim();
  const summary = String(o.summary ?? '').trim();
  if (!title || !summary) return null;
  const blob = `${title} ${summary}`;
  // Skip earnings-only cards — structured earnings block already covers dates.
  if (/earnings|eps report|quarterly results/i.test(blob) && (theme === 'OTHER' || theme === 'FUNDING')) {
    return null;
  }
  // Skip routine ETF flow-streak recaps — structured etfFlows block has last/5d/30d + streak.
  if (
    theme === 'ETF' &&
    /inflow|outflow|flow streak|consecutive (in|out)flow|net flows?/i.test(blob) &&
    !/fil(ing|ed)|approv|launch|list|reject|SEC|product|issuer/i.test(blob)
  ) {
    return null;
  }
  const id =
    typeof o.id === 'string' && o.id.trim()
      ? o.id.trim().slice(0, 48)
      : `c${idx}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28)}`;
  return {
    id,
    theme: THEMES.has(theme) ? theme : 'OTHER',
    title: title.slice(0, 80),
    summary: summary.slice(0, 220),
    biasHint: String(o.biasHint ?? o.bias_hint ?? '').trim().slice(0, 80) || 'n/a',
    status: STATUSES.has(status) ? status : 'new',
    sentiment: normalizeScore05(o.sentiment, 3),
    tradability: normalizeScore05(o.tradability ?? o.tradabilityScore, 2),
    horizon: normalizeHorizon(o.horizon),
  };
}

function buildSymbolPrompt(
  display: string,
  previous: StickySymbolCatalysts | null,
): string {
  const prevBlock =
    previous?.catalysts?.length
      ? `PREVIOUS CATALYSTS (as of ${previous.updatedAt}, boardSentiment=${previous.boardSentiment ?? 'n/a'}):\n${previous.catalysts
          .map((c) => `- [${c.status}][${formatStickyScores(c)}] ${c.theme}: ${c.title} — ${c.summary}`)
          .join('\n')}`
      : 'PREVIOUS CATALYSTS: none.';

  return `You are a markets desk analyst maintaining STICKY TICKER CATALYSTS for ${display} (Hyperliquid / tradeXYZ perpetual; for equities this is the listed stock narrative).

Sticky = multi-day name-specific stories that CURRENT search headlines tie to ${display} — NOT last-hour price wiggles, NOT generic "stock is volatile", NOT sector-wide themes unless this name is directly named or uniquely exposed.
Examples by theme (illustrative only — do not force these onto ${display}):
- REGULATION: bill/agency actions that explicitly name or uniquely hit this issuer
- PARTNERSHIP / PRODUCT / M_AND_A / FUNDING / TEAM: corp events
- UNLOCK / TOKENOMICS / GOVERNANCE / NETWORK / SECURITY: crypto protocol catalysts for this asset
- LEGAL: lawsuits, settlements involving this name
- ETF: filings, approvals, rejections, new ETF products for this underlying — NOT daily inflow/outflow streaks
- MACRO_LINK: sticky macro theme only when this ticker is a clear, unique proxy (otherwise omit)

Do NOT invent catalysts from the theme list when search finds nothing material for ${display}.
Do NOT list routine earnings date/time (handled elsewhere). You MAY note earnings-adjacent drama only if it is sticky beyond the date itself.
Do NOT list routine spot-ETF flow streaks / "N days of inflows" (structured flow data is injected separately for BTC/ETH/SOL/XRP). ETF theme is for filing/approval/product news only.

Use Google Search for CURRENT headlines on ${display} (last 7 days, prefer 48h for intensifications).

${prevBlock}

${STICKY_SCORE_RUBRIC}
Score sentiment relative to ${display} (not the broad market unless this name is the direct proxy).

Return ONLY JSON (no markdown prose):
{
  "boardSentiment": 0,
  "catalysts": [
    {
      "id": "short-kebab-id",
      "theme": "REGULATION" | "PARTNERSHIP" | "PRODUCT" | "UNLOCK" | "LEGAL" | "MACRO_LINK" | "M_AND_A" | "FUNDING" | "TOKENOMICS" | "GOVERNANCE" | "SECURITY" | "TEAM" | "NETWORK" | "ETF" | "OTHER",
      "title": "≤12 words",
      "summary": "one sentence — what is sticky for ${display} and why traders care",
      "biasHint": "e.g. regulatory overhang / partnership bid / unlock supply",
      "status": "new" | "unchanged" | "intensified" | "resolved",
      "sentiment": 0,
      "tradability": 0,
      "horizon": "days" | "weeks" | "structural"
    }
  ]
}

boardSentiment = net lean for ${display} on the 0–5 sentiment scale (weight higher-tradability items). If catalysts is empty, omit boardSentiment or use 3.

If nothing material is sticky, return {"catalysts": []}.
Max ${MAX_CATALYSTS} catalysts. Prefer 1–3. Be factual.`;
}

async function produceSymbolCatalysts(
  display: string,
  previous: StickySymbolCatalysts | null,
  slotKey?: string,
): Promise<StickySymbolCatalysts> {
  const raw = await geminiSearchText(buildSymbolPrompt(display, previous));
  let parsed: { catalysts?: unknown[]; boardSentiment?: unknown };
  try {
    parsed = JSON.parse(stripJsonFence(raw)) as {
      catalysts?: unknown[];
      boardSentiment?: unknown;
    };
  } catch {
    throw new Error(`sticky symbol JSON parse failed for ${display}: ${raw.slice(0, 180)}`);
  }
  const catalysts = (parsed.catalysts ?? [])
    .map((c, i) => normalizeCatalyst(c, i))
    .filter((c): c is StickySymbolCatalyst => c != null)
    .slice(0, MAX_CATALYSTS);
  const derived = catalysts.length ? computeBoardSentiment(catalysts) : 3;
  const boardSentiment = catalysts.length
    ? parsed.boardSentiment != null
      ? normalizeScore05(parsed.boardSentiment, derived)
      : derived
    : undefined;
  return {
    symbol: display,
    catalysts,
    updatedAt: new Date().toISOString(),
    slotKey,
    boardSentiment,
    none: catalysts.length === 0,
  };
}

/** Read-only (fresh within TTL). */
export async function getStickySymbolCatalysts(
  symbol: string,
): Promise<StickySymbolCatalysts | null> {
  const display = coinPart(symbol).toUpperCase();
  if (!display) return null;
  return readGlobalContext<StickySymbolCatalysts>(cacheKey(display));
}

/**
 * Refresh stale/missing per-symbol catalysts for active symbols.
 * Inside an Asia/US claim window, boards from a previous slot re-sync too
 * (TTL alone would usually still be fresh at slot time, so refreshes would
 * drift onto the bootstrap trickle instead). Outside slots, a small bootstrap
 * budget so a fresh deploy / new symbol (e.g. CRCL) isn't blind for 12h.
 */
export async function maybeRefreshStickySymbolCatalysts(
  symbols: string[],
  now = new Date(),
): Promise<{ refreshed: number; skipped: number; failed: number }> {
  const slot = currentStickyRefreshSlot(now);
  const displays = [
    ...new Set(
      symbols
        .map((s) => coinPart(s).toUpperCase())
        .filter((s) => s.length > 0),
    ),
  ].sort();

  const need: string[] = [];
  for (const d of displays) {
    const cur = await readGlobalContext<StickySymbolCatalysts>(cacheKey(d)).catch(() => null);
    if (!cur || (slot && cur.slotKey !== slot.key)) need.push(d);
  }

  const budget = slot ? MAX_REFRESH_PER_CYCLE : MAX_BOOTSTRAP_PER_CYCLE;
  const todo = need.slice(0, budget);

  const results = await Promise.allSettled(
    todo.map(async (display) => {
      const key = cacheKey(display);
      const previous = await readGlobalContextAny<StickySymbolCatalysts>(key).catch(() => null);
      try {
        const board = await produceSymbolCatalysts(
          display,
          previous,
          slot?.key ?? `${now.toISOString().slice(0, 10)}-bootstrap`,
        );
        await writeGlobalContext(key, board, TTL_MS);
        console.info(
          `[sticky-symbol] ${display}: ${board.catalysts.length} catalyst(s)${board.none ? ' (none)' : ''}`,
        );
      } catch (err) {
        console.warn(
          `[sticky-symbol] refresh failed ${display}:`,
          err instanceof Error ? err.message : err,
        );
        // Keep prior board readable, but with a short TTL so we retry soon
        // instead of serving stale data as fresh for a full 12h.
        if (previous) {
          await writeGlobalContext(key, previous, FAILURE_RETRY_TTL_MS);
        }
        throw err;
      }
    }),
  );

  const refreshed = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - refreshed;
  return {
    refreshed,
    skipped: Math.max(0, displays.length - refreshed - failed),
    failed,
  };
}

/**
 * Ensure one symbol has a board (agent path). Uses TTL cache; may call Gemini
 * on miss/expiry. Prefer batch refresh at cycle start when possible.
 */
export async function ensureStickySymbolCatalysts(
  symbol: string,
): Promise<StickySymbolCatalysts | null> {
  const display = coinPart(symbol).toUpperCase();
  if (!display) return null;
  return getOrRefreshGlobalContext<StickySymbolCatalysts>({
    key: cacheKey(display),
    ttlMs: TTL_MS,
    produce: async () => {
      const prev = await readGlobalContextAny<StickySymbolCatalysts>(cacheKey(display));
      return produceSymbolCatalysts(display, prev);
    },
  });
}

function catalystLeanLabel(s: number): string {
  if (s <= 1) return 'bearish';
  if (s <= 3) return 'neutral';
  return 'bullish';
}

/** Compact prompt block — empty when no board or explicitly empty catalysts. */
export function renderStickySymbolCatalystsSection(
  board: StickySymbolCatalysts | null | undefined,
): string {
  if (!board) return '';
  const asOf = board.updatedAt
    ? new Date(board.updatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : 'n/a';
  if (!board.catalysts.length) {
    return `

**TICKER CATALYSTS** (${board.symbol} · as of ${asOf}): none sticky right now (beyond structured earnings/calendar if present).`;
  }
  const lean =
    typeof board.boardSentiment === 'number'
      ? board.boardSentiment
      : computeBoardSentiment(board.catalysts);
  const lines = board.catalysts.map((c) => {
    const bias = c.biasHint && c.biasHint !== 'n/a' ? ` · ${c.biasHint}` : '';
    const scores =
      typeof c.sentiment === 'number' && typeof c.tradability === 'number'
        ? `[${formatStickyScores({
            sentiment: c.sentiment,
            tradability: c.tradability,
            horizon: c.horizon ?? 'weeks',
          })}] `
        : '';
    return `- [${c.status.toUpperCase()}]${scores}${c.theme}: ${c.title} — ${c.summary}${bias}`;
  });
  return `

**TICKER CATALYSTS** (${board.symbol} · as of ${asOf}):
Ticker lean: ${lean}/5 (${catalystLeanLabel(lean)}; 0–1 bearish · 2–3 neutral · 4–5 bullish)
${lines.join('\n')}
- Weight: name-specific BACKGROUND sentiment. Cite briefly when a catalyst clearly touches this thesis; do not open/cut on catalyst text alone.
- Scores: \`sent\` = direction for ${board.symbol}, \`trad\` = reprice power now. \`unchanged\` / low \`trad\` (≤2) must not move conviction. \`intensified\` / \`new\` with \`trad\` ≥ 4 may nudge SIZE or timing when they touch this thesis; never a hard conviction formula. Earnings *dates* and BTC/ETH/SOL/XRP spot-ETF *flow numbers/streaks* stay on their structured blocks — don't double-count.`;
}
