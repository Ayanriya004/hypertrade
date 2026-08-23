export type Horizon = 'scalper' | 'swing' | 'investor';
export type Side = 'LONG' | 'SHORT';
export type DecisionTone = 'positive' | 'negative' | 'neutral' | 'warn';

export type EquityPoint = { t: number; indexed: number };

export type LivePosition = {
  symbol: string;
  side: Side;
  entry: number | null;
  mark: number | null;
  sizeUsd: number | null;
  /** ROE % (price move × leverage), matching PortfolioTabs. */
  unrealizedPct: number | null;
  /** Dollar unrealized PnL. */
  unrealizedPnl?: number | null;
  leverage: number | null;
  marginType?: 'cross' | 'isolated' | null;
  liquidationPx?: number | null;
  marginUsed?: number | null;
  /** True when this perp is live on the agent's book but was not opened by the agent. */
  manual?: boolean;
};

export type OpenOrder = {
  symbol: string;
  side: Side;
  orderSide?: 'buy' | 'sell';
  kind: 'stop' | 'take_profit' | 'limit';
  tpsl?: 'tp' | 'sl' | null;
  triggerPx: number | null;
  size?: number | null;
  reduceOnly?: boolean;
  isTrigger?: boolean;
};

export type Decision = {
  id: string;
  at: string | number;
  symbol: string;
  type: string;
  headline: string;
  body: string;
  reasoning?: string | null;
  tone: DecisionTone;
  conviction?: number | null;
  direction?: Side | null;
  /** Monitor ROE % at check time (price move × leverage). */
  pnlPct?: number | null;
};

export type OpeningDecision = {
  at: string | number;
  symbol: string;
  side: Side;
  conviction: number | null;
  summary: string;
  reasoning: string;
  entryPrice?: number | null;
  stopPrice?: number | null;
  takeProfit?: number | null;
};

export type ClosedTrade = {
  symbol: string;
  side: Side;
  closePrice: number | null;
  /** True when close_price was missing and entry was used as fallback. */
  priceIsEntry?: boolean;
  closedAt: string | number;
  reason?: string | null;
  /** @deprecated kept optional for older cached payloads */
  pnlUsd?: number | null;
};

export type AgentDirection = 'long_short' | 'long_only' | 'short_only' | string;
export type AgentMandate = 'active' | 'accumulate' | string;

export type ShowcaseAgent = {
  id: string;
  name: string;
  model: string;
  horizon: Horizon | string;
  /** long_short | long_only | short_only */
  direction?: AgentDirection;
  /** active | accumulate (only meaningful for one-sided direction) */
  mandate?: AgentMandate;
  symbols: string[];
  /** Shared max total notional across assigned symbols (not per-position). */
  maxCapitalUsd?: number | null;
  blurb?: string | null;
  live?: boolean;
  status?: string;
  pnlFrom1k: number;
  indexedEquity: number;
  equity: EquityPoint[];
  positions: LivePosition[];
  openOrders: OpenOrder[];
  decisions: Decision[];
  opening: OpeningDecision | null;
  closed: ClosedTrade[];
};

export type ShowcaseResponse = {
  agents: ShowcaseAgent[];
  generatedAt: number;
};

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '';

export async function fetchShowcaseAgents(signal?: AbortSignal): Promise<ShowcaseResponse> {
  const res = await fetch(`${API_BASE}/api/showcase/agents`, { signal });
  if (!res.ok) {
    throw new Error(`Showcase API ${res.status}`);
  }
  return res.json();
}
