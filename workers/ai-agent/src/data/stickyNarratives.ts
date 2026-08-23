/**
 * Sticky narratives — slow global macro/theme board for AI agents.
 *
 * Cadence (UTC, off the top-of-hour agent cycle):
 *   • 02:30 Asia cash morning — overnight geo/Asia news has printed
 *   • 15:30 ~1h after US equity open — US/macro/regulatory headlines have
 *     built into the session
 * Claim window is 60 minutes after each slot so the hourly :00 worker cycle
 * still picks it up (e.g. 03:00 cycle claims the 02:30 Asia slot).
 *
 * Produced via Gemini + Google Search grounding (same family as Ask AI on
 * asset pages). Cached in global_context_cache; agents only READ the board
 * on open/monitor — no per-decision search.
 *
 * Prompt contract: background regime only. `unchanged` must not move
 * conviction; `intensified` / `new` / `resolved` with high tradability may
 * nudge size/timing. Per-item scores (sentiment / tradability / horizon) are
 * produced by Gemini at cache write — agents read them, never re-score.
 */
import {
  readGlobalContext,
  writeGlobalContext,
} from '../lib/globalCache.js';

export type StickyNarrativeStatus =
  | 'unchanged'
  | 'intensified'
  | 'new'
  | 'resolved';

export type StickyNarrativeTheme =
  | 'GEO'
  | 'RATES'
  | 'CRYPTO_REG'
  | 'CRYPTO'
  | 'EQUITY'
  | 'COMMODITY'
  | 'OTHER';

/** Persistence of the catalyst/narrative impact. */
export type StickyHorizon = 'days' | 'weeks' | 'structural';

export interface StickyNarrative {
  id: string;
  theme: StickyNarrativeTheme;
  title: string;
  /** One short sentence — what is sticky and why it matters for markets. */
  summary: string;
  /** Assets / sectors most exposed (e.g. OIL, BTC, crypto stocks). */
  markets: string[];
  /** Soft directional hint, not a trade instruction. */
  biasHint: string;
  status: StickyNarrativeStatus;
  /** 0–1 bearish · 2–3 neutral · 4–5 bullish (typical market impact). */
  sentiment: number;
  /** 0–5: how much this can reprice now (surprise×force×mag×timing×credibility). */
  tradability: number;
  horizon: StickyHorizon;
}

export interface StickyNarrativesBoard {
  narratives: StickyNarrative[];
  /** Slot that produced this board, e.g. `2026-08-01-asia`. */
  slotKey: string;
  slotId: 'asia' | 'us';
  updatedAt: string;
  /** Net board lean 0–5 (same scale as per-item sentiment). */
  boardSentiment: number;
  /** True when this payload was served after a failed refresh. */
  stale?: boolean;
}

const HORIZONS = new Set<StickyHorizon>(['days', 'weeks', 'structural']);

/** Clamp Gemini score fields; defaults keep legacy boards readable. */
export function normalizeScore05(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(0, Math.round(n)));
}

export function normalizeHorizon(raw: unknown): StickyHorizon {
  const h = String(raw ?? 'weeks').toLowerCase() as StickyHorizon;
  return HORIZONS.has(h) ? h : 'weeks';
}

/** Weighted board lean from items (tradability weights fluff down). */
export function computeBoardSentiment(
  items: { sentiment?: number; tradability?: number }[],
): number {
  if (!items.length) return 3;
  let wSum = 0;
  let sSum = 0;
  for (const it of items) {
    const s = normalizeScore05(it.sentiment, 3);
    const w = Math.max(1, normalizeScore05(it.tradability, 2));
    wSum += w;
    sSum += s * w;
  }
  return normalizeScore05(sSum / wSum, 3);
}

function sentimentLabel(s: number): string {
  if (s <= 1) return 'bearish';
  if (s <= 3) return 'neutral';
  return 'bullish';
}

/** Compact score tag for prompt lines: `sent=1 trad=4 days`. */
export function formatStickyScores(item: {
  sentiment?: number;
  tradability?: number;
  horizon?: StickyHorizon;
}): string {
  return `sent=${normalizeScore05(item.sentiment, 3)} trad=${normalizeScore05(item.tradability, 2)} ${normalizeHorizon(item.horizon)}`;
}

/** Shared Gemini scoring rubric (injected into both board prompts). */
export const STICKY_SCORE_RUBRIC = `SCORING (required on every item — score tradability, not vibes):
- sentiment 0–5: 0–1 bearish, 2–3 neutral, 4–5 bullish for typical market impact of THIS theme.
- tradability 0–5: how much this can REPRICE risk assets NOW. High only when several apply: not priced in / surprise, forced flow (unlock, liquidation, ETF, buyback), material magnitude, near-term timing, credible source (filing/court/issuer > rumor). "Sounds bad" with no flow/timing = tradability ≤2.
- horizon: "days" | "weeks" | "structural" — how long the pressure/bid is expected to persist.
Do NOT invent scores without search grounding. Resolved items usually get lower tradability.`;

const CACHE_KEY = 'sticky_narratives_v1';
/** Keep board readable if a slot refresh fails (next slot will retry). */
const TTL_MS = 48 * 60 * 60 * 1000;
const MAX_NARRATIVES = 6;

/** Strategic refresh times — avoid exact hourly cycle boundaries (:00). */
const REFRESH_SLOTS = [
  { id: 'asia' as const, hour: 2, minute: 30 },
  { id: 'us' as const, hour: 15, minute: 30 },
];

const THEMES = new Set<StickyNarrativeTheme>([
  'GEO',
  'RATES',
  'CRYPTO_REG',
  'CRYPTO',
  'EQUITY',
  'COMMODITY',
  'OTHER',
]);
const STATUSES = new Set<StickyNarrativeStatus>([
  'unchanged',
  'intensified',
  'new',
  'resolved',
]);

/**
 * If `now` falls in a slot's 60-minute claim window, return that slot.
 * Hourly cycles at :00 after 02:30 / 15:30 still claim (03:00 / 16:00).
 */
export function currentStickyRefreshSlot(
  now = new Date(),
): { id: 'asia' | 'us'; key: string } | null {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = now.toISOString().slice(0, 10);
  for (const slot of REFRESH_SLOTS) {
    const start = slot.hour * 60 + slot.minute;
    const end = start + 60;
    if (mins >= start && mins < end) {
      return { id: slot.id, key: `${day}-${slot.id}` };
    }
  }
  return null;
}

export function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

function normalizeNarrative(raw: unknown, idx: number): StickyNarrative | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const theme = String(o.theme ?? 'OTHER').toUpperCase() as StickyNarrativeTheme;
  const status = String(o.status ?? 'new').toLowerCase() as StickyNarrativeStatus;
  const title = String(o.title ?? '').trim();
  const summary = String(o.summary ?? '').trim();
  if (!title || !summary) return null;
  const markets = Array.isArray(o.markets)
    ? o.markets.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
    : [];
  const id =
    typeof o.id === 'string' && o.id.trim()
      ? o.id.trim().slice(0, 48)
      : `n${idx}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`;
  return {
    id,
    theme: THEMES.has(theme) ? theme : 'OTHER',
    title: title.slice(0, 80),
    summary: summary.slice(0, 220),
    markets,
    biasHint: String(o.biasHint ?? o.bias_hint ?? '').trim().slice(0, 80) || 'n/a',
    status: STATUSES.has(status) ? status : 'new',
    sentiment: normalizeScore05(o.sentiment, 3),
    tradability: normalizeScore05(o.tradability ?? o.tradabilityScore, 2),
    horizon: normalizeHorizon(o.horizon),
  };
}

export async function geminiSearchText(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  // 2.5-flash: search-grounding support (same family as Ask AI on asset pages).
  const model = (process.env.STICKY_NARRATIVES_MODEL ?? 'gemini-2.5-flash').trim();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini sticky refresh HTTP ${res.status}: ${body.slice(0, 240)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini sticky refresh returned empty text');
  return text;
}

function buildRefreshPrompt(
  previous: StickyNarrativesBoard | null,
  slotId: 'asia' | 'us',
): string {
  const prevBlock =
    previous?.narratives?.length
      ? `PREVIOUS BOARD (as of ${previous.updatedAt}, slot ${previous.slotKey}, boardSentiment=${previous.boardSentiment ?? 'n/a'}):\n${previous.narratives
          .map(
            (n) =>
              `- [${n.status}][${formatStickyScores(n)}] ${n.theme}: ${n.title} — ${n.summary} (markets: ${n.markets.join(', ') || 'n/a'})`,
          )
          .join('\n')}`
      : 'PREVIOUS BOARD: none (first run).';

  const sessionHint =
    slotId === 'asia'
      ? 'Focus on overnight / Asia-session developments (geo, China, oil, crypto Asia flow).'
      : 'Focus on US-session developments (Fed/rates rhetoric, US equities, crypto regulation in Washington, commodity inventories).';

  return `You are a markets desk analyst maintaining a STICKY NARRATIVES board for automated trading agents.

Sticky = ongoing multi-day themes (geopolitics, regulation, major unlocks/earnings seasons, structural rates/USD stories) — NOT tick-by-tick price noise, NOT "BTC up 0.3% in the last hour".

${sessionHint}

Use Google Search for CURRENT headlines (last 24–72h). Prefer themes that still matter for risk assets, oil/metals, crypto, or US equities.

${prevBlock}

${STICKY_SCORE_RUBRIC}

Return ONLY a JSON object (no markdown prose) with this shape:
{
  "boardSentiment": 0,
  "narratives": [
    {
      "id": "short-kebab-id",
      "theme": "GEO" | "RATES" | "CRYPTO_REG" | "CRYPTO" | "EQUITY" | "COMMODITY" | "OTHER",
      "title": "≤12 words",
      "summary": "one sentence on what is sticky and why markets care",
      "markets": ["OIL", "BTC"],
      "biasHint": "e.g. risk-off bias / oil bid / regulatory overhang",
      "status": "new" | "unchanged" | "intensified" | "resolved",
      "sentiment": 0,
      "tradability": 0,
      "horizon": "days" | "weeks" | "structural"
    }
  ]
}

boardSentiment = your net lean across the board on the same 0–5 sentiment scale (weight higher-tradability items more).

Status rules vs PREVIOUS BOARD:
- unchanged — same theme still active, no material new development
- intensified — same theme, materially hotter / more market-relevant
- new — theme not on previous board
- resolved — previous theme that has clearly cooled or ended (include it once with status resolved)

Max ${MAX_NARRATIVES} narratives. Prefer 3–5. Be factual; do not invent tickers or laws.`;
}

async function produceBoard(
  slot: { id: 'asia' | 'us'; key: string },
  previous: StickyNarrativesBoard | null,
): Promise<StickyNarrativesBoard> {
  const raw = await geminiSearchText(buildRefreshPrompt(previous, slot.id));
  let parsed: { narratives?: unknown[]; boardSentiment?: unknown };
  try {
    parsed = JSON.parse(stripJsonFence(raw)) as {
      narratives?: unknown[];
      boardSentiment?: unknown;
    };
  } catch {
    throw new Error(`sticky narratives JSON parse failed: ${raw.slice(0, 200)}`);
  }
  const narratives = (parsed.narratives ?? [])
    .map((n, i) => normalizeNarrative(n, i))
    .filter((n): n is StickyNarrative => n != null)
    .slice(0, MAX_NARRATIVES);
  if (!narratives.length) {
    throw new Error('sticky narratives produce returned zero usable cards');
  }
  const derived = computeBoardSentiment(narratives);
  const boardSentiment =
    parsed.boardSentiment != null ? normalizeScore05(parsed.boardSentiment, derived) : derived;
  return {
    narratives,
    slotKey: slot.key,
    slotId: slot.id,
    updatedAt: new Date().toISOString(),
    boardSentiment,
  };
}

/** Read cached board (fresh within TTL). */
export async function getStickyNarrativesBoard(): Promise<StickyNarrativesBoard | null> {
  return readGlobalContext<StickyNarrativesBoard>(CACHE_KEY);
}

/**
 * Leader cycle hook: if we are inside an Asia/US claim window and have not
 * yet written that slot, refresh via Gemini Search and persist.
 * Bootstrap: if the cache is empty (fresh deploy), refresh once outside
 * slot so agents aren't blind until the next 02:30/15:30 window.
 */
export async function maybeRefreshStickyNarratives(
  now = new Date(),
): Promise<'refreshed' | 'skipped' | 'failed'> {
  const existing = await getStickyNarrativesBoard().catch(() => null);
  const slot = currentStickyRefreshSlot(now);
  const bootstrap = !existing && !slot;
  if (!slot && !bootstrap) return 'skipped';
  if (slot && existing?.slotKey === slot.key) return 'skipped';

  const effectiveSlot = slot ?? {
    id: 'asia' as const,
    key: `${now.toISOString().slice(0, 10)}-bootstrap`,
  };

  try {
    const board = await produceBoard(effectiveSlot, existing);
    await writeGlobalContext(CACHE_KEY, board, TTL_MS);
    console.info(
      `[sticky-narratives] refreshed slot=${effectiveSlot.key} n=${board.narratives.length}${bootstrap ? ' (bootstrap)' : ''}`,
    );
    return 'refreshed';
  } catch (err) {
    console.warn(
      `[sticky-narratives] refresh failed slot=${effectiveSlot.key}:`,
      err instanceof Error ? err.message : err,
    );
    // Keep prior board readable — bump TTL if we still have one.
    if (existing) {
      await writeGlobalContext(
        CACHE_KEY,
        { ...existing, stale: true },
        TTL_MS,
      );
    }
    return 'failed';
  }
}

/** Compact prompt block — empty string when unavailable. */
export function renderStickyNarrativesSection(
  board: StickyNarrativesBoard | null | undefined,
): string {
  if (!board?.narratives?.length) return '';
  const asOf = board.updatedAt
    ? new Date(board.updatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : 'n/a';
  const lean =
    typeof board.boardSentiment === 'number'
      ? board.boardSentiment
      : computeBoardSentiment(board.narratives);
  const lines = board.narratives.map((n) => {
    const mk = n.markets.length ? ` · ${n.markets.join('/')}` : '';
    const bias = n.biasHint && n.biasHint !== 'n/a' ? ` · ${n.biasHint}` : '';
    const scores =
      typeof n.sentiment === 'number' && typeof n.tradability === 'number'
        ? `[${formatStickyScores({
            sentiment: n.sentiment,
            tradability: n.tradability,
            horizon: n.horizon ?? 'weeks',
          })}] `
        : '';
    return `- [${n.status.toUpperCase()}]${scores}${n.theme}: ${n.title} — ${n.summary}${mk}${bias}`;
  });
  const stale = board.stale ? ' (stale — last refresh failed)' : '';
  return `

**STICKY NARRATIVES** (global backdrop · as of ${asOf}${stale}):
Board lean: ${lean}/5 (${sentimentLabel(lean)}; 0–1 bearish · 2–3 neutral · 4–5 bullish)
${lines.join('\n')}
- Weight: BACKGROUND sentiment. Do NOT open/cut/flip on narrative alone — structure, options, and cut triggers still lead.
- Scores: \`sent\` = direction, \`trad\` = reprice power now. \`unchanged\` / low \`trad\` (≤2) must not move conviction. \`intensified\` / \`new\` with \`trad\` ≥ 4 may nudge SIZE or timing when they clearly touch this symbol's thesis; never a hard conviction formula.`;
}
