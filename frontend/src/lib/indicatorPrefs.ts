import AsyncStorage from '@react-native-async-storage/async-storage';

const INDICATOR_PREFS_KEY = 'indicatorPrefs';

/** How many configurable EMA / MA lines we support (Binance-style rows). */
export const MA_BAND_SLOT_COUNT = 6;
export const RSI_BAND_SLOT_COUNT = 3;

export type MaPriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'ohlc4';

export type MaBandRow = {
  enabled: boolean;
  period: number;
  source: MaPriceSource;
  color: string;
};

/** RSI sub-pane row: period/source plus line appearance (Binance-style). */
export type RsiBandRow = {
  enabled: boolean;
  period: number;
  source: MaPriceSource;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  lineStyle: BollLineStyleId;
};

/** Lightweight Charts line style: 0 Solid, 1 Dotted, 2 Dashed, 3 LargeDashed, 4 SparseDotted */
export type BollLineStyleId = 0 | 1 | 2 | 3 | 4;

export type BollConfig = {
  length: number;
  multiplier: number;
  showBackground: boolean;
  showUpper: boolean;
  showMid: boolean;
  showLower: boolean;
  /** Fill between bands (rgba) */
  backgroundColor: string;
  upperColor: string;
  midColor: string;
  lowerColor: string;
  upperLineStyle: BollLineStyleId;
  midLineStyle: BollLineStyleId;
  lowerLineStyle: BollLineStyleId;
};

export const DEFAULT_BOLL_CONFIG: BollConfig = {
  length: 20,
  multiplier: 2,
  showBackground: true,
  showUpper: true,
  showMid: true,
  showLower: true,
  backgroundColor: 'rgba(100, 116, 139, 0.13)',
  upperColor: '#64748b',
  midColor: '#94a3b8',
  lowerColor: '#64748b',
  upperLineStyle: 0,
  midLineStyle: 0,
  lowerLineStyle: 0,
};

function clampBollLength(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_BOLL_CONFIG.length;
  const r = Math.round(n);
  /** 0 = empty draft (like MA period 0); 1 = valid while typing e.g. 10 or 15 before the second digit. */
  if (r === 0) return 0;
  if (r === 1) return 1;
  return Math.max(2, Math.min(500, r));
}

function clampBollMult(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_BOLL_CONFIG.multiplier;
  return Math.max(0.1, Math.min(50, Math.round(n * 100) / 100));
}

function clampLineStyle(n: unknown): BollLineStyleId {
  const v = Math.round(Number(n));
  if (v >= 0 && v <= 4) return v as BollLineStyleId;
  return 0;
}

const HEX6 = /^#([0-9a-fA-F]{6})$/;
const RGBA = /^rgba?\(/i;

export function normalizeBollConfig(partial: Partial<BollConfig> | undefined): BollConfig {
  const d = DEFAULT_BOLL_CONFIG;
  if (!partial || typeof partial !== 'object') return { ...d };
  const colorOr = (x: unknown, fallback: string) =>
    typeof x === 'string' && (HEX6.test(x.trim()) || RGBA.test(x.trim())) ? x.trim() : fallback;
  return {
    length: clampBollLength(Number(partial.length)),
    multiplier: clampBollMult(Number(partial.multiplier)),
    showBackground: partial.showBackground !== false,
    showUpper: partial.showUpper !== false,
    showMid: partial.showMid !== false,
    showLower: partial.showLower !== false,
    backgroundColor: colorOr(partial.backgroundColor, d.backgroundColor),
    upperColor: colorOr(partial.upperColor, d.upperColor),
    midColor: colorOr(partial.midColor, d.midColor),
    lowerColor: colorOr(partial.lowerColor, d.lowerColor),
    upperLineStyle: clampLineStyle(partial.upperLineStyle),
    midLineStyle: clampLineStyle(partial.midLineStyle),
    lowerLineStyle: clampLineStyle(partial.lowerLineStyle),
  };
}

/** Rolling VWAP window length; line appearance matches Lightweight Charts. */
export type VwapConfig = {
  length: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  lineStyle: BollLineStyleId;
};

export const DEFAULT_VWAP_CONFIG: VwapConfig = {
  length: 14,
  color: '#3b82f6',
  lineWidth: 2,
  lineStyle: 0,
};

function clampVwapLength(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_VWAP_CONFIG.length;
  const r = Math.round(n);
  if (r === 0) return 0;
  if (r === 1) return 1;
  return Math.max(2, Math.min(500, r));
}

function clampVwapLineWidth(n: unknown): 1 | 2 | 3 | 4 {
  const v = Math.round(Number(n));
  if (v >= 1 && v <= 4) return v as 1 | 2 | 3 | 4;
  return DEFAULT_VWAP_CONFIG.lineWidth;
}

export function normalizeVwapConfig(partial: Partial<VwapConfig> | undefined): VwapConfig {
  const d = DEFAULT_VWAP_CONFIG;
  if (!partial || typeof partial !== 'object') return { ...d };
  const colorOr = (x: unknown, fallback: string) =>
    typeof x === 'string' && (HEX6.test(x.trim()) || RGBA.test(x.trim())) ? x.trim() : fallback;
  return {
    length: clampVwapLength(Number(partial.length)),
    color: colorOr(partial.color, d.color),
    lineWidth: clampVwapLineWidth(partial.lineWidth),
    lineStyle: clampLineStyle(partial.lineStyle),
  };
}

/** Supertrend: ATR period + multiplier; single line on main chart. */
export type SupertrendConfig = {
  period: number;
  multiplier: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  lineStyle: BollLineStyleId;
};

export const DEFAULT_SUPERTREND_CONFIG: SupertrendConfig = {
  period: 10,
  multiplier: 3,
  color: '#fb7185',
  lineWidth: 1,
  lineStyle: 0,
};

function clampStPeriod(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_SUPERTREND_CONFIG.period;
  const r = Math.round(n);
  /** 0 = empty draft while editing. */
  if (r === 0) return 0;
  return Math.max(1, Math.min(500, r));
}

function clampStMultiplier(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_SUPERTREND_CONFIG.multiplier;
  return Math.max(0.1, Math.min(50, Math.round(n * 100) / 100));
}

function clampStLineWidth(n: unknown): 1 | 2 | 3 | 4 {
  const v = Math.round(Number(n));
  if (v >= 1 && v <= 4) return v as 1 | 2 | 3 | 4;
  return DEFAULT_SUPERTREND_CONFIG.lineWidth;
}

export function normalizeSupertrendConfig(partial: Partial<SupertrendConfig> | undefined): SupertrendConfig {
  const d = DEFAULT_SUPERTREND_CONFIG;
  if (!partial || typeof partial !== 'object') return { ...d };
  const colorOr = (x: unknown, fallback: string) =>
    typeof x === 'string' && (HEX6.test(x.trim()) || RGBA.test(x.trim())) ? x.trim() : fallback;
  return {
    period: clampStPeriod(Number(partial.period)),
    multiplier: clampStMultiplier(Number(partial.multiplier)),
    color: colorOr(partial.color, d.color),
    lineWidth: clampStLineWidth(partial.lineWidth),
    lineStyle: clampLineStyle(partial.lineStyle),
  };
}

const EMA_SLOT_PERIODS = [3, 7, 20, 50, 100, 200];
const MA_SLOT_PERIODS = [3, 7, 20, 50, 100, 200];
const RSI_SLOT_PERIODS = [6, 12, 24];

const EMA_DEFAULT_COLORS = ['#ef4444', '#22d3ee', '#a855f7', '#ec4899', '#e5e7eb', '#f59e0b'];
const MA_DEFAULT_COLORS = ['#f97316', '#60a5fa', '#34d399', '#facc15', '#f472b6', '#94a3b8'];
const RSI_DEFAULT_COLORS = ['#ec4899', '#a78bfa', '#facc15'];

/** Default EMA rows — 7 / 50 / 200 enabled by default. */
export const DEFAULT_EMA_ROWS: MaBandRow[] = EMA_SLOT_PERIODS.map((period, i) => ({
  enabled: period === 7 || period === 50 || period === 200,
  period,
  source: 'close' as const,
  color: EMA_DEFAULT_COLORS[i] ?? '#eab308',
}));

export const DEFAULT_MA_ROWS: MaBandRow[] = MA_SLOT_PERIODS.map((period, i) => ({
  enabled: false,
  period,
  source: 'close' as const,
  color: MA_DEFAULT_COLORS[i] ?? '#94a3b8',
}));

export const DEFAULT_RSI_ROWS: RsiBandRow[] = RSI_SLOT_PERIODS.map((period, i) => ({
  enabled: true,
  period,
  source: 'close' as const,
  color: RSI_DEFAULT_COLORS[i] ?? '#38bdf8',
  lineWidth: 1,
  lineStyle: 0,
}));

const SOURCE_SET = new Set<MaPriceSource>(['open', 'high', 'low', 'close', 'hl2', 'ohlc4']);

function clampPeriod(n: number, fallback: number) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(999, Math.round(n)));
}

export function normalizeMaBandRow(partial: Partial<MaBandRow> | undefined, fallback: MaBandRow): MaBandRow {
  const period = clampPeriod(Number(partial?.period), fallback.period);
  const src = partial?.source && SOURCE_SET.has(partial.source) ? partial.source : fallback.source;
  const color =
    typeof partial?.color === 'string' && /^#([0-9a-fA-F]{6})$/.test(partial.color.trim())
      ? partial.color.trim()
      : fallback.color;
  return {
    enabled: !!partial?.enabled,
    period,
    source: src,
    color,
  };
}

export function normalizeMaBandRows(raw: unknown, defaults: MaBandRow[]): MaBandRow[] {
  const arr = Array.isArray(raw) ? raw : [];
  return defaults.map((def, i) => normalizeMaBandRow(arr[i] as Partial<MaBandRow>, def));
}

function clampRsiLineWidth(n: unknown): 1 | 2 | 3 | 4 {
  const v = Math.round(Number(n));
  if (v >= 1 && v <= 4) return v as 1 | 2 | 3 | 4;
  return 1;
}

export function normalizeRsiBandRow(partial: Partial<RsiBandRow> | undefined, fallback: RsiBandRow): RsiBandRow {
  const period = clampPeriod(Number(partial?.period), fallback.period);
  const src = partial?.source && SOURCE_SET.has(partial.source) ? partial.source : fallback.source;
  const color =
    typeof partial?.color === 'string' && /^#([0-9a-fA-F]{6})$/.test(partial.color.trim())
      ? partial.color.trim()
      : fallback.color;
  return {
    enabled: !!partial?.enabled,
    period,
    source: src,
    color,
    lineWidth: clampRsiLineWidth(partial?.lineWidth !== undefined ? partial.lineWidth : fallback.lineWidth),
    lineStyle: clampLineStyle(partial?.lineStyle !== undefined ? partial.lineStyle : fallback.lineStyle),
  };
}

export function normalizeRsiBandRows(raw: unknown, defaults: RsiBandRow[] = DEFAULT_RSI_ROWS): RsiBandRow[] {
  const arr = Array.isArray(raw) ? raw : [];
  return defaults.map((def, i) => normalizeRsiBandRow(arr[i] as Partial<RsiBandRow>, def));
}

/** Migrate legacy `ema: { 7: bool, … }` into row-based prefs. */
export function migrateLegacyEmaRows(legacy: Record<number, boolean> | undefined): MaBandRow[] {
  return DEFAULT_EMA_ROWS.map((def) => {
    const p = def.period;
    let enabled = def.enabled;
    if (legacy && Object.prototype.hasOwnProperty.call(legacy, p)) {
      enabled = !!legacy[p as keyof typeof legacy];
    }
    return { ...def, period: p, enabled };
  });
}

export function migrateLegacyMaRows(legacy: Record<number, boolean> | undefined): MaBandRow[] {
  return DEFAULT_MA_ROWS.map((def) => {
    const p = def.period;
    let enabled = def.enabled;
    if (legacy && Object.prototype.hasOwnProperty.call(legacy, p)) {
      enabled = !!legacy[p as keyof typeof legacy];
    }
    return { ...def, period: p, enabled };
  });
}

export type IndicatorPrefs = {
  emaRows?: MaBandRow[];
  maRows?: MaBandRow[];
  rsiRows?: RsiBandRow[];
  /** @deprecated use emaRows */
  ema?: Record<number, boolean>;
  /** @deprecated use maRows */
  ma?: Record<number, boolean>;
  boll?: boolean;
  bollConfig?: Partial<BollConfig>;
  supertrend?: boolean;
  stConfig?: Partial<SupertrendConfig>;
  vwap?: boolean;
  vwapConfig?: Partial<VwapConfig>;
  vol?: boolean;
  rsi?: boolean;
  cci?: boolean;
  macd?: boolean;
  dma?: boolean;
};

function getKey(ownerId?: string | null) {
  return `${INDICATOR_PREFS_KEY}:${ownerId ?? 'guest'}`;
}

export async function loadIndicatorPrefs(ownerId?: string | null): Promise<IndicatorPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(getKey(ownerId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveIndicatorPrefs(ownerId: string | null | undefined, prefs: IndicatorPrefs) {
  try {
    await AsyncStorage.setItem(getKey(ownerId), JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
}
