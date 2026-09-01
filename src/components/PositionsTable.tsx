import React, { useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  X,
  Share2,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  History,
  Shield,
} from "lucide-react";
import type { Position, OpenOrder, TradeFill } from "../types";

interface PositionsTableProps {
  positions: Position[];
  openOrders: OpenOrder[];
  fills: TradeFill[];
  onClosePosition: (pos: Position) => void;
  onSharePnl: (pos: Position) => void;
  onRefresh: () => void;
}

export const PositionsTable: React.FC<PositionsTableProps> = ({
  positions,
  openOrders,
  fills,
  onClosePosition,
  onSharePnl,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<"positions" | "orders" | "fills">("positions");
  const [closingId, setClosingId] = useState<string | null>(null);

  const handleClose = async (pos: Position) => {
    setClosingId(pos.id);
    try {
      await onClosePosition(pos);
    } finally {
      setClosingId(null);
    }
  };

  return (
    <div className="bg-[#0c1017] border-t border-[#1f2937] flex flex-col h-full text-xs">
      {/* Table Navigation Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1f2937] bg-[#0f141f]">
        <div className="flex items-center gap-4">
          <button
            id="tab-positions"
            onClick={() => setActiveTab("positions")}
            className={`font-bold pb-1 transition-all border-b-2 flex items-center gap-1.5 ${
              activeTab === "positions"
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>Open Positions</span>
            <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
              {positions.length}
            </span>
          </button>

          <button
            id="tab-orders"
            onClick={() => setActiveTab("orders")}
            className={`font-bold pb-1 transition-all border-b-2 flex items-center gap-1.5 ${
              activeTab === "orders"
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>Open Orders</span>
            <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
              {openOrders.length}
            </span>
          </button>

          <button
            id="tab-fills"
            onClick={() => setActiveTab("fills")}
            className={`font-bold pb-1 transition-all border-b-2 flex items-center gap-1.5 ${
              activeTab === "fills"
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>Trade History & Fills</span>
            <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
              {fills.length}
            </span>
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-x-auto overflow-y-auto p-2">
        {activeTab === "positions" && (
          <div>
            {positions.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <div className="text-sm font-medium mb-1">No open positions</div>
                <div className="text-[11px]">Use the trade panel to open a Long or Short position on Hyperliquid.</div>
              </div>
            ) : (
              <table className="w-full text-left font-mono">
                <thead>
                  <tr className="text-[10px] uppercase font-bold text-slate-400 border-b border-[#1f2937]/80 pb-2">
                    <th className="pb-2 pl-2">Market</th>
                    <th className="pb-2">Size</th>
                    <th className="pb-2">Entry Price</th>
                    <th className="pb-2">Mark Price</th>
                    <th className="pb-2">Liq. Price</th>
                    <th className="pb-2">Margin</th>
                    <th className="pb-2">Unrealized PnL</th>
                    <th className="pb-2 text-right pr-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]/50">
                  {positions.map((pos) => {
                    const isLong = pos.side === "LONG";
                    const isProfitable = pos.unrealizedPnl >= 0;

                    return (
                      <tr key={pos.id} className="hover:bg-[#141c2b] transition-all">
                        {/* Market & Side */}
                        <td className="py-2.5 pl-2">
                          <div className="flex items-center gap-1.5 font-sans">
                            <span className="font-bold text-white text-xs">{pos.symbol}</span>
                            <span
                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                              }`}
                            >
                              {pos.leverage}x {pos.side}
                            </span>
                            <span className="text-[10px] text-slate-400 uppercase">{pos.marginType}</span>
                          </div>
                        </td>

                        {/* Size */}
                        <td className="py-2.5">
                          <div className="text-white font-medium">{pos.size.toFixed(4)} {pos.symbol}</div>
                          <div className="text-[10px] text-slate-400">
                            ${pos.sizeUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                        </td>

                        {/* Entry Price */}
                        <td className="py-2.5 text-slate-300">
                          ${pos.entryPrice.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 4,
                          })}
                        </td>

                        {/* Mark Price */}
                        <td className="py-2.5 text-cyan-300 font-bold">
                          ${pos.markPrice.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 4,
                          })}
                        </td>

                        {/* Liquidation Price */}
                        <td className="py-2.5 text-amber-400 font-semibold">
                          ${pos.liquidationPrice.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 4,
                          })}
                        </td>

                        {/* Margin */}
                        <td className="py-2.5 text-slate-300">
                          ${pos.marginUsed.toFixed(2)}
                        </td>

                        {/* Unrealized PnL */}
                        <td className="py-2.5">
                          <div className={`font-bold text-xs ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
                            {isProfitable ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                          </div>
                          <div className={`text-[10px] ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
                            ({isProfitable ? "+" : ""}{pos.unrealizedPct.toFixed(2)}%)
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="py-2.5 text-right pr-2">
                          <div className="flex items-center justify-end gap-2 font-sans">
                            <button
                              onClick={() => onSharePnl(pos)}
                              className="p-1.5 rounded-lg bg-[#182333] hover:bg-[#202f45] text-slate-300 hover:text-white"
                              title="Share PnL Card"
                            >
                              <Share2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              id={`btn-close-pos-${pos.symbol}`}
                              onClick={() => handleClose(pos)}
                              disabled={closingId === pos.id}
                              className="px-2.5 py-1 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-500/40 text-rose-300 font-bold text-[11px] transition-all"
                            >
                              {closingId === pos.id ? "Closing..." : "Close Market"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === "orders" && (
          <div>
            {openOrders.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <div className="text-sm font-medium mb-1">No resting open orders</div>
                <div className="text-[11px]">Placed limit or trigger orders will appear here.</div>
              </div>
            ) : (
              <table className="w-full text-left font-mono">
                <thead>
                  <tr className="text-[10px] uppercase font-bold text-slate-400 border-b border-[#1f2937]/80 pb-2">
                    <th className="pb-2 pl-2">Market</th>
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Side</th>
                    <th className="pb-2">Limit Price</th>
                    <th className="pb-2">Size</th>
                    <th className="pb-2">Order Value</th>
                    <th className="pb-2 text-right pr-2">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]/50">
                  {openOrders.map((ord) => (
                    <tr key={ord.id} className="hover:bg-[#141c2b] transition-all">
                      <td className="py-2.5 pl-2 font-bold text-white font-sans">{ord.symbol}</td>
                      <td className="py-2.5 uppercase text-slate-400 text-[10px]">{ord.orderType}</td>
                      <td className="py-2.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            ord.side === "BUY" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                          }`}
                        >
                          {ord.side}
                        </span>
                      </td>
                      <td className="py-2.5 text-cyan-300 font-bold">${ord.price.toLocaleString()}</td>
                      <td className="py-2.5 text-slate-300">{ord.size} {ord.symbol}</td>
                      <td className="py-2.5 text-slate-300">${ord.sizeUsd.toLocaleString()}</td>
                      <td className="py-2.5 text-right pr-2 font-sans">
                        <button className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px]">
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === "fills" && (
          <div>
            {fills.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <div className="text-sm font-medium mb-1">No trade executions yet</div>
                <div className="text-[11px]">Filled orders will be recorded here in real-time.</div>
              </div>
            ) : (
              <table className="w-full text-left font-mono">
                <thead>
                  <tr className="text-[10px] uppercase font-bold text-slate-400 border-b border-[#1f2937]/80 pb-2">
                    <th className="pb-2 pl-2">Time</th>
                    <th className="pb-2">Market</th>
                    <th className="pb-2">Action</th>
                    <th className="pb-2">Fill Price</th>
                    <th className="pb-2">Executed Size</th>
                    <th className="pb-2">Notional ($)</th>
                    <th className="pb-2">Fee ($)</th>
                    <th className="pb-2 text-right pr-2">Realized PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]/50">
                  {fills.map((fill) => {
                    const date = new Date(fill.timestamp);
                    const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date
                      .getMinutes()
                      .toString()
                      .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
                    return (
                      <tr key={fill.id} className="hover:bg-[#141c2b] transition-all">
                        <td className="py-2 pl-2 text-slate-400 text-[11px]">{timeStr}</td>
                        <td className="py-2 font-bold text-white font-sans">{fill.symbol}</td>
                        <td className="py-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              fill.side === "BUY"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : "bg-rose-500/20 text-rose-400"
                            }`}
                          >
                            {fill.dir}
                          </span>
                        </td>
                        <td className="py-2 text-slate-200">${fill.price.toLocaleString()}</td>
                        <td className="py-2 text-slate-300">{fill.size.toFixed(4)} {fill.symbol}</td>
                        <td className="py-2 text-slate-300">${fill.sizeUsd.toLocaleString()}</td>
                        <td className="py-2 text-slate-400">${fill.feeUsd.toFixed(3)}</td>
                        <td className="py-2 text-right pr-2">
                          {fill.pnlUsd !== undefined ? (
                            <span
                              className={`font-bold ${
                                fill.pnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                              }`}
                            >
                              {fill.pnlUsd >= 0 ? "+" : ""}${fill.pnlUsd.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-slate-600">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
