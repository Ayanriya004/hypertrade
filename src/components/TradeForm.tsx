import React, { useState, useEffect } from "react";
import {
  TrendingUp,
  TrendingDown,
  Shield,
  Zap,
  Sliders,
  AlertCircle,
  CheckCircle2,
  Wallet,
} from "lucide-react";
import type { Asset } from "../types";
import { placeLiveHyperliquidOrder, hasInjectedWallet } from "../lib/web3Hyperliquid";

interface TradeFormProps {
  asset: Asset | null;
  markPrice: number;
  availableBalance: number;
  onOrderPlaced: () => void;
  presetPrice: string | null;
  onClearPresetPrice: () => void;
  walletConnected?: boolean;
  walletAddress?: string | null;
  onConnectWallet?: () => void;
}

export const TradeForm: React.FC<TradeFormProps> = ({
  asset,
  markPrice,
  availableBalance,
  onOrderPlaced,
  presetPrice,
  onClearPresetPrice,
  walletConnected = false,
  walletAddress = null,
  onConnectWallet,
}) => {
  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [leverage, setLeverage] = useState<number>(5);
  const [sizeUsd, setSizeUsd] = useState<string>("100");
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [orderResult, setOrderResult] = useState<{ success: boolean; message: string } | null>(null);

  const symbol = asset?.symbol || "BTC";
  const maxLev = asset?.maxLeverage || 50;

  // Sync preset price from order book clicks
  useEffect(() => {
    if (presetPrice) {
      setLimitPrice(presetPrice);
      setOrderType("limit");
      onClearPresetPrice();
    }
  }, [presetPrice]);

  // Calculations
  const parsedSizeUsd = parseFloat(sizeUsd) || 0;
  const execPrice = orderType === "limit" && limitPrice ? parseFloat(limitPrice) || markPrice : markPrice;
  const tokenSize = execPrice > 0 ? parsedSizeUsd / execPrice : 0;
  const marginRequired = leverage > 0 ? parsedSizeUsd / leverage : parsedSizeUsd;
  const feeEstimate = parsedSizeUsd * 0.00035;

  // Estimated Liquidation Price
  const liqBuffer = (1 / leverage) * 0.9;
  const estLiquidation =
    side === "long"
      ? Math.max(0, execPrice * (1 - liqBuffer))
      : execPrice * (1 + liqBuffer);

  // Quick percentage handler
  const handlePercentage = (pct: number) => {
    if (availableBalance <= 0) return;
    const targetMargin = availableBalance * (pct / 100);
    const targetSizeUsd = Math.round(targetMargin * leverage);
    setSizeUsd(targetSizeUsd.toString());
  };

  // Submit Real Mainnet Order
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!walletConnected || !walletAddress) {
      if (onConnectWallet) onConnectWallet();
      return;
    }

    if (parsedSizeUsd <= 0 || isSubmitting) return;

    setIsSubmitting(true);
    setOrderResult(null);

    try {
      const isBuy = side === "long";
      const szFormatted = tokenSize.toFixed(asset?.szDecimals || 4);
      const pxFormatted = execPrice.toFixed(execPrice < 10 ? 4 : 1);

      await placeLiveHyperliquidOrder({
        userAddress: walletAddress,
        assetSymbol: symbol,
        assetIndex: 0,
        isBuy,
        limitPx: pxFormatted,
        sz: szFormatted,
        orderType: orderType === "market" ? "market" : "limit",
        env: "mainnet",
      });

      setOrderResult({
        success: true,
        message: `Order broadcast to Hyperliquid L1: ${side.toUpperCase()} ${szFormatted} ${symbol} @ $${pxFormatted}`,
      });
      onOrderPlaced();
      setTimeout(() => setOrderResult(null), 5000);
    } catch (err) {
      setOrderResult({ success: false, message: (err as Error).message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0d121c] border-l border-[#1f2937] p-3.5 text-xs text-white">
      {/* Trading Mode Banner */}
      <div className="mb-2 px-2.5 py-1.5 rounded-lg bg-[#141b27] border border-emerald-500/30 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-semibold text-[11px] text-emerald-300">
            Hyperliquid Mainnet L1
          </span>
        </div>
        <span className="text-[10px] text-slate-400 font-mono">
          Builder: 0.03%
        </span>
      </div>

      {/* Side Toggle: Long / Short */}
      <div className="grid grid-cols-2 gap-2 p-1 bg-[#141b27] rounded-xl border border-[#243144] mb-3">
        <button
          type="button"
          id="btn-trade-long"
          onClick={() => setSide("long")}
          className={`py-2 rounded-lg font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
            side === "long"
              ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/25"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          Buy / Long
        </button>
        <button
          type="button"
          id="btn-trade-short"
          onClick={() => setSide("short")}
          className={`py-2 rounded-lg font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
            side === "short"
              ? "bg-rose-500 text-white shadow-lg shadow-rose-500/25"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <TrendingDown className="w-3.5 h-3.5" />
          Sell / Short
        </button>
      </div>

      {/* Order Type & Margin Mode */}
      <div className="flex items-center justify-between gap-2 mb-3">
        {/* Market vs Limit */}
        <div className="flex items-center bg-[#141b27] p-0.5 rounded-lg border border-[#243144] flex-1">
          <button
            type="button"
            onClick={() => setOrderType("market")}
            className={`flex-1 py-1 text-[11px] font-bold rounded ${
              orderType === "market" ? "bg-cyan-500/20 text-cyan-400" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Market
          </button>
          <button
            type="button"
            onClick={() => setOrderType("limit")}
            className={`flex-1 py-1 text-[11px] font-bold rounded ${
              orderType === "limit" ? "bg-cyan-500/20 text-cyan-400" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Limit
          </button>
        </div>

        {/* Cross vs Isolated */}
        <div className="flex items-center bg-[#141b27] p-0.5 rounded-lg border border-[#243144]">
          <button
            type="button"
            onClick={() => setMarginMode("cross")}
            className={`px-2.5 py-1 text-[10px] font-bold rounded uppercase ${
              marginMode === "cross" ? "bg-slate-700 text-white" : "text-slate-400"
            }`}
          >
            Cross
          </button>
          <button
            type="button"
            onClick={() => setMarginMode("isolated")}
            className={`px-2.5 py-1 text-[10px] font-bold rounded uppercase ${
              marginMode === "isolated" ? "bg-slate-700 text-white" : "text-slate-400"
            }`}
          >
            Iso
          </button>
        </div>
      </div>

      {/* Limit Price Input if Limit Order */}
      {orderType === "limit" && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-slate-400 text-[11px] mb-1">
            <span>Limit Price</span>
            <span className="font-mono text-slate-300">Mark: ${markPrice.toFixed(2)}</span>
          </div>
          <div className="relative">
            <input
              type="number"
              placeholder={markPrice.toString()}
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className="w-full bg-[#141b27] border border-[#243144] focus:border-cyan-500 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none"
            />
            <span className="absolute right-3 top-2 text-slate-500 font-mono">USD</span>
          </div>
        </div>
      )}

      {/* Leverage Slider */}
      <div className="mb-3 bg-[#141b27] p-2.5 rounded-xl border border-[#243144]">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-slate-400 flex items-center gap-1 font-semibold">
            <Sliders className="w-3 h-3 text-cyan-400" />
            Leverage
          </span>
          <span className="font-mono font-bold text-cyan-400 text-xs px-2 py-0.5 bg-cyan-950/60 border border-cyan-500/30 rounded">
            {leverage}x
          </span>
        </div>
        <input
          type="range"
          min="1"
          max={maxLev}
          step="1"
          value={leverage}
          onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
          className="w-full h-1.5 bg-[#243144] rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
        <div className="flex justify-between text-[10px] text-slate-500 font-mono mt-1">
          <span>1x</span>
          <span>10x</span>
          <span>25x</span>
          <span>{maxLev}x</span>
        </div>
      </div>

      {/* Order Size Input */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-slate-400 text-[11px] mb-1">
          <span>Order Size (USD)</span>
          <span className="font-mono text-slate-300">
            Avail: ${availableBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="relative">
          <input
            type="number"
            min="1"
            value={sizeUsd}
            onChange={(e) => setSizeUsd(e.target.value)}
            className="w-full bg-[#141b27] border border-[#243144] focus:border-cyan-500 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none"
          />
          <span className="absolute right-3 top-2 text-slate-500 font-mono">USD</span>
        </div>

        {/* Quick Percent Buttons */}
        <div className="grid grid-cols-4 gap-1.5 mt-1.5">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => handlePercentage(pct)}
              className="bg-[#192231] hover:bg-[#222e42] border border-[#29384e] py-1 rounded text-[10px] font-mono text-slate-300 transition-all"
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* Summary Matrix */}
      <div className="bg-[#121722] p-2.5 rounded-xl border border-[#1f2937] space-y-1.5 text-[11px] mb-3">
        <div className="flex justify-between text-slate-400">
          <span>Token Size</span>
          <span className="font-mono text-slate-200">
            {tokenSize.toFixed(asset?.szDecimals || 4)} {symbol}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Margin Required</span>
          <span className="font-mono text-slate-200">
            ${marginRequired.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Est. Liq Price</span>
          <span className="font-mono text-amber-400">${estLiquidation.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Est. Fee (0.035%)</span>
          <span className="font-mono text-slate-400">${feeEstimate.toFixed(3)}</span>
        </div>
      </div>

      {/* Notification Toast */}
      {orderResult && (
        <div
          className={`p-2.5 rounded-lg mb-3 flex items-start gap-2 text-xs border ${
            orderResult.success
              ? "bg-emerald-950/80 border-emerald-500/50 text-emerald-300"
              : "bg-rose-950/80 border-rose-500/50 text-rose-300"
          }`}
        >
          {orderResult.success ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          )}
          <span className="leading-snug break-words">{orderResult.message}</span>
        </div>
      )}

      {/* Submit Button */}
      <div className="mt-auto pt-2">
        {!walletConnected ? (
          <button
            type="button"
            id="btn-connect-to-trade"
            onClick={onConnectWallet}
            className="w-full py-3 rounded-xl font-extrabold text-xs transition-all shadow-lg flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-black shadow-cyan-500/25"
          >
            <Wallet className="w-4 h-4" />
            Connect Web3 Wallet to Trade
          </button>
        ) : (
          <button
            type="button"
            id="btn-submit-order"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className={`w-full py-3 rounded-xl font-extrabold text-xs transition-all shadow-lg flex items-center justify-center gap-2 ${
              isSubmitting
                ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                : side === "long"
                ? "bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-black shadow-emerald-500/25"
                : "bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-400 hover:to-pink-500 text-white shadow-rose-500/25"
            }`}
          >
            {isSubmitting ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Waiting for Wallet EIP-712 Signature...</span>
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5" />
                <span>Sign & Place Order on Hyperliquid</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
