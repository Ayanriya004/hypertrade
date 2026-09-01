export interface Asset {
  coin: string;
  symbol: string;
  name: string;
  category: string;
  maxLeverage: number;
  szDecimals: number;
  markPx: string | null;
  prevDayPx: string | null;
  dayNtlVlm: string | null;
  openInterest: string | null;
  funding: string | null;
  change24h: number | null;
  isHip3: boolean;
}

export interface Candle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
  n: number;
}

export interface OrderBookLevel {
  px: string;
  sz: string;
  n: number;
}

export interface OrderBookData {
  coin: string;
  levels: [OrderBookLevel[], OrderBookLevel[]]; // [bids, asks]
  time: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  size: number;
  sizeUsd: number;
  leverage: number;
  marginType: "cross" | "isolated";
  marginUsed: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  openedAt: number;
  tpPrice?: number;
  slPrice?: number;
}

export interface OpenOrder {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "market" | "limit" | "stop_market" | "take_profit";
  price: number;
  triggerPrice?: number;
  size: number;
  sizeUsd: number;
  leverage: number;
  status: "open" | "filled" | "cancelled";
  createdAt: number;
  reduceOnly?: boolean;
}

export interface TradeFill {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  dir: string;
  price: number;
  size: number;
  sizeUsd: number;
  feeUsd: number;
  pnlUsd?: number;
  timestamp: number;
}

export interface PortfolioState {
  balanceUsd: number;
  equityUsd: number;
  unrealizedPnl: number;
  marginUsed: number;
  marginAvailable: number;
  positions: Position[];
  openOrders: OpenOrder[];
  fills: TradeFill[];
}

export interface RecentTrade {
  id: string;
  px: number;
  sz: number;
  side: "buy" | "sell";
  time: number;
}
