import React from "react";
import { X, TrendingUp, TrendingDown, Share2, Copy, Check } from "lucide-react";
import type { Position } from "../types";

interface PnlShareModalProps {
  position: Position | null;
  isOpen: boolean;
  onClose: () => void;
}

export const PnlShareModal: React.FC<PnlShareModalProps> = ({
  position,
  isOpen,
  onClose,
}) => {
  const [copied, setCopied] = React.useState(false);

  if (!isOpen || !position) return null;

  const isProfitable = position.unrealizedPnl >= 0;

  const handleCopy = () => {
    navigator.clipboard?.writeText(
      `HyperTrade: ${position.symbol} ${position.side} ${position.leverage}x | PnL: ${
        isProfitable ? "+" : ""
      }${position.unrealizedPct.toFixed(2)}% ($${position.unrealizedPnl.toFixed(2)})`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-[#101622] border border-[#273549] rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl text-white">
        <div className="flex items-center justify-between p-3 border-b border-[#1f2937] bg-[#0c1017]">
          <span className="font-bold text-xs">Position Performance Card</span>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Visual Share Card */}
        <div className="p-4">
          <div
            className={`p-5 rounded-2xl border relative overflow-hidden ${
              isProfitable
                ? "bg-gradient-to-br from-[#0c2419] to-[#0a151b] border-emerald-500/40"
                : "bg-gradient-to-br from-[#290d13] to-[#140b10] border-rose-500/40"
            }`}
          >
            {/* Watermark Logo */}
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-cyan-500 flex items-center justify-center text-black font-extrabold text-xs">
                  H
                </div>
                <span className="font-extrabold text-sm tracking-tight text-white">HyperTrade</span>
              </div>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-white/10 text-slate-300">
                Hyperliquid Perp
              </span>
            </div>

            {/* Market & Direction */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg font-black text-white">{position.symbol}/USD</span>
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded ${
                  position.side === "LONG" ? "bg-emerald-500 text-black" : "bg-rose-500 text-white"
                }`}
              >
                {position.leverage}x {position.side}
              </span>
            </div>

            {/* Big PnL Percent */}
            <div
              className={`font-mono text-3xl font-black tracking-tight mb-4 ${
                isProfitable ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {isProfitable ? "+" : ""}
              {position.unrealizedPct.toFixed(2)}%
            </div>

            {/* Price Details */}
            <div className="grid grid-cols-2 gap-2 pt-3 border-t border-white/10 text-xs font-mono">
              <div>
                <div className="text-[10px] text-slate-400">Entry Price</div>
                <div className="font-bold text-slate-200">${position.entryPrice.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Mark Price</div>
                <div className="font-bold text-slate-200">${position.markPrice.toLocaleString()}</div>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={handleCopy}
              className="flex-1 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md shadow-cyan-500/20"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? "Copied to Clipboard!" : "Copy Stats"}</span>
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2.5 bg-[#182333] hover:bg-[#223147] text-slate-300 font-bold text-xs rounded-xl"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
