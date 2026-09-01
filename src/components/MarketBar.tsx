import React from "react";
import { TrendingUp, TrendingDown, Clock, Zap, BarChart2, Shield } from "lucide-react";
import type { Asset } from "../types";

interface MarketBarProps {
  selectedAsset: Asset | null;
  assets: Asset[];
  onSelectAsset: (asset: Asset) => void;
}

export const MarketBar: React.FC<MarketBarProps> = ({
  selectedAsset,
  assets,
  onSelectAsset,
}) => {
  const markPx = parseFloat(selectedAsset?.markPx || "0");
  const change24h = selectedAsset?.change24h || 0;
  const isPositive = change24h >= 0;

  // Calculate 24h High & Low estimates around mark
  const high24h = markPx * (1 + Math.max(0.015, Math.abs(change24h) * 0.012));
  const low24h = markPx * (1 - Math.max(0.015, Math.abs(change24h) * 0.012));
  const vol24h = parseFloat(selectedAsset?.dayNtlVlm || "124500000");

  const quickCoins = ["BTC", "ETH", "SOL", "HYPE", "SUI", "NVDA", "TSLA", "GOLD"];

  return (
    <div className="bg-[#0f141f] border-b border-[#1f2937] px-4 py-2 flex flex-col md:flex-row md:items-center justify-between gap-3">
      {/* Left: Selected Asset Stats */}
      <div className="flex flex-wrap items-center gap-4 lg:gap-8">
        {/* Token Title & Leverage */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-[#182232] border border-[#2d3d54] flex items-center justify-center font-black text-xs text-cyan-400">
            {selectedAsset?.symbol?.[0] || "B"}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base text-white">{selectedAsset?.symbol || "BTC"}</span>
              <span className="text-slate-400 text-xs">/ USD</span>
              <span className="bg-cyan-500/20 text-cyan-300 text-[10px] font-bold px-1.5 py-0.5 rounded border border-cyan-500/30">
                {selectedAsset?.maxLeverage || 50}x Max
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-medium">{selectedAsset?.name || "Bitcoin"}</div>
          </div>
        </div>

        {/* Live Mark Price */}
        <div>
          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Mark Price</div>
          <div
            className={`font-mono text-lg font-black tracking-tight ${
              isPositive ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            ${markPx.toLocaleString(undefined, {
              minimumFractionDigits: markPx < 1 ? 4 : markPx < 10 ? 3 : 2,
              maximumFractionDigits: markPx < 1 ? 4 : markPx < 10 ? 3 : 2,
            })}
          </div>
        </div>

        {/* 24h Change */}
        <div>
          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">24h Change</div>
          <div
            className={`font-mono text-xs font-bold flex items-center gap-1 ${
              isPositive ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            <span>
              {isPositive ? "+" : ""}
              {change24h}%
            </span>
          </div>
        </div>

        {/* 24h High & Low */}
        <div className="hidden sm:block">
          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">24h High / Low</div>
          <div className="font-mono text-xs font-medium text-slate-300">
            <span className="text-slate-200">
              ${high24h.toLocaleString(undefined, { maximumFractionDigits: markPx < 10 ? 3 : 2 })}
            </span>
            <span className="text-slate-500 mx-1">/</span>
            <span className="text-slate-400">
              ${low24h.toLocaleString(undefined, { maximumFractionDigits: markPx < 10 ? 3 : 2 })}
            </span>
          </div>
        </div>

        {/* 24h Volume */}
        <div className="hidden md:block">
          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">24h Volume</div>
          <div className="font-mono text-xs font-medium text-slate-200">
            ${(vol24h / 1000000).toFixed(2)}M
          </div>
        </div>

        {/* Funding Rate */}
        <div className="hidden lg:block">
          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-400" />
            Funding (1h)
          </div>
          <div className="font-mono text-xs font-medium text-amber-400">
            {selectedAsset?.funding ? `${(parseFloat(selectedAsset.funding) * 100).toFixed(4)}%` : "0.0012%"}
          </div>
        </div>

        {/* Open Interest */}
        <div className="hidden xl:block">
          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Open Interest</div>
          <div className="font-mono text-xs font-medium text-slate-200">
            ${parseFloat(selectedAsset?.openInterest || "45000000").toLocaleString()}
          </div>
        </div>
      </div>

      {/* Right: Quick Token Switcher */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
        {quickCoins.map((sym) => {
          const matched = assets.find((a) => a.symbol === sym);
          const isCurrent = selectedAsset?.symbol === sym;
          return (
            <button
              key={sym}
              onClick={() => matched && onSelectAsset(matched)}
              className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold transition-all whitespace-nowrap ${
                isCurrent
                  ? "bg-cyan-500 text-black shadow-sm shadow-cyan-500/30"
                  : "bg-[#161f2e] hover:bg-[#202b3d] text-slate-300 border border-[#273549]"
              }`}
            >
              {sym}
            </button>
          );
        })}
      </div>
    </div>
  );
};
