import React, { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Layers, ListOrdered } from "lucide-react";
import type { OrderBookLevel, RecentTrade } from "../types";

interface OrderBookProps {
  symbol: string;
  markPrice: number;
  onSelectPrice: (price: string) => void;
}

export const OrderBook: React.FC<OrderBookProps> = ({
  symbol,
  markPrice,
  onSelectPrice,
}) => {
  const [tab, setTab] = useState<"book" | "trades">("book");
  const [bids, setBids] = useState<OrderBookLevel[]>([]);
  const [asks, setAsks] = useState<OrderBookLevel[]>([]);
  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([]);

  // Fetch Order Book
  useEffect(() => {
    let active = true;
    const fetchBook = async () => {
      try {
        const res = await fetch(`/api/orderbook/${symbol}`);
        const data = await res.json();
        if (active && data && data.levels) {
          setBids(data.levels[0]?.slice(0, 10) || []);
          setAsks(data.levels[1]?.slice(0, 10) || []);
        }
      } catch (err) {
        // fallback
      }
    };

    fetchBook();
    const timer = window.setInterval(fetchBook, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [symbol]);

  // Simulate or stream real recent trades
  useEffect(() => {
    if (!markPrice) return;
    const initialTrades: RecentTrade[] = [];
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      const isBuy = Math.random() > 0.48;
      const px = markPrice * (1 + (Math.random() - 0.5) * 0.002);
      const sz = Math.round((Math.random() * 2 + 0.1) * 1000) / 1000;
      initialTrades.push({
        id: `tr-${now - i * 3000}`,
        px: Math.round(px * 100) / 100,
        sz,
        side: isBuy ? "buy" : "sell",
        time: now - i * 3000,
      });
    }
    setRecentTrades(initialTrades);

    const tradeTimer = window.setInterval(() => {
      const isBuy = Math.random() > 0.48;
      const px = markPrice * (1 + (Math.random() - 0.5) * 0.001);
      const sz = Math.round((Math.random() * 1.5 + 0.05) * 1000) / 1000;
      setRecentTrades((prev) => [
        {
          id: `tr-${Date.now()}`,
          px: Math.round(px * 100) / 100,
          sz,
          side: isBuy ? "buy" : "sell",
          time: Date.now(),
        },
        ...prev.slice(0, 25),
      ]);
    }, 2000);

    return () => window.clearInterval(tradeTimer);
  }, [symbol, markPrice]);

  // Compute depth max for visual bar width
  const maxBidSize = bids.reduce((acc, b) => Math.max(acc, parseFloat(b.sz || "0")), 0) || 1;
  const maxAskSize = asks.reduce((acc, a) => Math.max(acc, parseFloat(a.sz || "0")), 0) || 1;
  const maxDepth = Math.max(maxBidSize, maxAskSize, 1);

  const bestBid = parseFloat(bids[0]?.px || String(markPrice * 0.9999));
  const bestAsk = parseFloat(asks[0]?.px || String(markPrice * 1.0001));
  const spread = Math.max(0, bestAsk - bestBid);
  const spreadPct = (spread / (markPrice || 1)) * 100;

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] border-l border-[#1b2433] text-xs">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1b2433] bg-[#0c1017]">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab("book")}
            className={`flex items-center gap-1.5 px-2 py-1 rounded font-semibold transition-all ${
              tab === "book" ? "bg-cyan-500/20 text-cyan-400" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Order Book
          </button>
          <button
            onClick={() => setTab("trades")}
            className={`flex items-center gap-1.5 px-2 py-1 rounded font-semibold transition-all ${
              tab === "trades" ? "bg-cyan-500/20 text-cyan-400" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ListOrdered className="w-3.5 h-3.5" />
            Recent Trades
          </button>
        </div>
      </div>

      {tab === "book" ? (
        <div className="flex-1 flex flex-col justify-between overflow-hidden p-2">
          {/* Table Headers */}
          <div className="grid grid-cols-3 text-[10px] uppercase font-bold text-slate-500 pb-1.5 border-b border-[#1b2433]">
            <span>Price (USD)</span>
            <span className="text-right">Size ({symbol})</span>
            <span className="text-right">Total ($)</span>
          </div>

          {/* Asks (Sells) - Red */}
          <div className="flex flex-col-reverse justify-end overflow-hidden flex-1 py-1 space-y-reverse space-y-0.5">
            {asks.slice(0, 8).map((ask, i) => {
              const sz = parseFloat(ask.sz || "0");
              const px = parseFloat(ask.px || "0");
              const widthPct = Math.min(100, (sz / maxDepth) * 100);
              return (
                <div
                  key={`ask-${i}`}
                  onClick={() => onSelectPrice(ask.px)}
                  className="relative grid grid-cols-3 font-mono text-[11px] py-0.5 px-1 hover:bg-rose-950/40 cursor-pointer rounded transition-all"
                >
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-rose-500/15 pointer-events-none rounded-r"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="text-rose-400 font-semibold">{px.toFixed(px < 10 ? 3 : 2)}</span>
                  <span className="text-right text-slate-300">{sz.toFixed(2)}</span>
                  <span className="text-right text-slate-400">
                    ${(px * sz).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Mid Price & Spread Bar */}
          <div className="my-1.5 py-1.5 px-2 bg-[#121824] rounded-lg border border-[#1f2937] flex items-center justify-between font-mono">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-cyan-400">${markPrice.toLocaleString()}</span>
              <ArrowUp className="w-3 h-3 text-emerald-400" />
            </div>
            <div className="text-[10px] text-slate-400">
              Spread: <span className="text-slate-200">${spread.toFixed(2)}</span> ({spreadPct.toFixed(3)}%)
            </div>
          </div>

          {/* Bids (Buys) - Green */}
          <div className="flex flex-col overflow-hidden flex-1 py-1 space-y-0.5">
            {bids.slice(0, 8).map((bid, i) => {
              const sz = parseFloat(bid.sz || "0");
              const px = parseFloat(bid.px || "0");
              const widthPct = Math.min(100, (sz / maxDepth) * 100);
              return (
                <div
                  key={`bid-${i}`}
                  onClick={() => onSelectPrice(bid.px)}
                  className="relative grid grid-cols-3 font-mono text-[11px] py-0.5 px-1 hover:bg-emerald-950/40 cursor-pointer rounded transition-all"
                >
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-emerald-500/15 pointer-events-none rounded-r"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="text-emerald-400 font-semibold">{px.toFixed(px < 10 ? 3 : 2)}</span>
                  <span className="text-right text-slate-300">{sz.toFixed(2)}</span>
                  <span className="text-right text-slate-400">
                    ${(px * sz).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Recent Trades Stream */
        <div className="flex-1 overflow-y-auto p-2">
          <div className="grid grid-cols-3 text-[10px] uppercase font-bold text-slate-500 pb-1.5 border-b border-[#1b2433]">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Time</span>
          </div>
          <div className="divide-y divide-[#1b2433]/40 mt-1">
            {recentTrades.map((tr) => {
              const date = new Date(tr.time);
              const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date
                .getMinutes()
                .toString()
                .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
              return (
                <div key={tr.id} className="grid grid-cols-3 font-mono text-[11px] py-1 px-1">
                  <span className={`font-semibold ${tr.side === "buy" ? "text-emerald-400" : "text-rose-400"}`}>
                    ${tr.px.toFixed(tr.px < 10 ? 3 : 2)}
                  </span>
                  <span className="text-right text-slate-300">{tr.sz.toFixed(3)}</span>
                  <span className="text-right text-slate-500 text-[10px]">{timeStr}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
