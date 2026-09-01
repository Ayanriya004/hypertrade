import React, { useState } from "react";
import {
  TrendingUp,
  Bot,
  Wallet,
  Coins,
  ChevronDown,
  ExternalLink,
  PlusCircle,
  Activity,
  Search,
  CheckCircle2,
} from "lucide-react";
import type { Asset } from "../types";

interface NavbarProps {
  currentView: "trading" | "agents";
  onViewChange: (view: "trading" | "agents") => void;
  selectedAsset: Asset | null;
  assets: Asset[];
  onSelectAsset: (asset: Asset) => void;
  balanceUsd: number;
  equityUsd: number;
  onOpenDeposit: () => void;
  walletConnected: boolean;
  walletAddress: string | null;
  onConnectWallet: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onViewChange,
  selectedAsset,
  assets,
  onSelectAsset,
  balanceUsd,
  equityUsd,
  onOpenDeposit,
  walletConnected,
  walletAddress,
  onConnectWallet,
}) => {
  const [showAssetDropdown, setShowAssetDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredAssets = assets.filter(
    (a) =>
      a.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <header className="sticky top-0 z-50 bg-[#0c1017] border-b border-[#1f2937] px-4 py-2.5 text-white flex items-center justify-between">
      {/* Left: Logo & Nav items */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => onViewChange("trading")}>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <TrendingUp className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="font-extrabold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
              HyperTrade
            </div>
          </div>
        </div>

        {/* View Switchers */}
        <div className="hidden md:flex items-center bg-[#161f2e] p-1 rounded-xl border border-[#273549]">
          <button
            id="nav-tab-trading"
            onClick={() => onViewChange("trading")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              currentView === "trading"
                ? "bg-cyan-500 text-black shadow-md shadow-cyan-500/25"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Trading Terminal
          </button>
          <button
            id="nav-tab-agents"
            onClick={() => onViewChange("agents")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              currentView === "agents"
                ? "bg-cyan-500 text-black shadow-md shadow-cyan-500/25"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            AI Agents Showcase
            <span className="bg-emerald-500/20 text-emerald-400 text-[10px] px-1.5 py-0.5 rounded font-mono">
              LIVE
            </span>
          </button>
        </div>

        {/* Quick Market Selector for Trading */}
        {currentView === "trading" && (
          <div className="relative">
            <button
              id="market-selector-btn"
              onClick={() => setShowAssetDropdown(!showAssetDropdown)}
              className="flex items-center gap-2.5 bg-[#161f2e] hover:bg-[#1f2c40] px-3 py-1.5 rounded-lg border border-[#273549] transition-all text-sm"
            >
              <div className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-500/40 flex items-center justify-center text-[10px] font-bold text-cyan-300">
                {selectedAsset?.symbol?.[0] || "B"}
              </div>
              <span className="font-bold tracking-wide">{selectedAsset?.symbol || "BTC"}-PERP</span>
              <span
                className={`text-xs font-semibold ${
                  (selectedAsset?.change24h || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {(selectedAsset?.change24h || 0) >= 0 ? "+" : ""}
                {selectedAsset?.change24h || 0}%
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {/* Dropdown Menu */}
            {showAssetDropdown && (
              <div className="absolute left-0 mt-2 w-72 bg-[#121824] border border-[#273549] rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="p-2 border-b border-[#273549] flex items-center gap-2 bg-[#0c1017]">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search crypto, equities, gold..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none w-full"
                    autoFocus
                  />
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-[#1f2937]/50">
                  {filteredAssets.map((asset) => (
                    <div
                      key={asset.symbol}
                      onClick={() => {
                        onSelectAsset(asset);
                        setShowAssetDropdown(false);
                      }}
                      className="px-3 py-2.5 flex items-center justify-between hover:bg-[#1a2333] cursor-pointer transition-all"
                    >
                      <div className="flex items-center gap-2">
                        <div className="font-bold text-sm text-white">{asset.symbol}</div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">
                          {asset.category}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-mono text-slate-200">
                          ${parseFloat(asset.markPx || "0").toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 4,
                          })}
                        </div>
                        <div
                          className={`text-[11px] font-mono font-medium ${
                            (asset.change24h || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {(asset.change24h || 0) >= 0 ? "+" : ""}
                          {asset.change24h || 0}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: Balances, Network status, Deposit & Wallet */}
      <div className="flex items-center gap-3">
        {/* Network Badge: Pinned Hyperliquid Mainnet */}
        <div className="flex items-center gap-1.5 text-xs bg-[#161f2e] border border-emerald-500/30 px-2.5 py-1.5 rounded-lg text-emerald-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="font-semibold uppercase tracking-wider text-[11px]">
            HL Mainnet
          </span>
        </div>

        {/* Balance & Equity Indicator */}
        <div className="hidden sm:flex items-center gap-3 bg-[#121824] px-3 py-1.5 rounded-lg border border-[#273549]">
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Account Equity</div>
            <div className="text-xs font-mono font-bold text-cyan-400">
              ${equityUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="h-6 w-px bg-[#273549]"></div>
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Available Margin</div>
            <div className="text-xs font-mono font-medium text-slate-200">
              ${balanceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* Deposit Bridge Button */}
        <button
          id="btn-deposit-faucet"
          onClick={onOpenDeposit}
          className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 text-black px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md shadow-cyan-600/30"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>Deposit USDC</span>
        </button>

        {/* Connect Wallet */}
        <button
          id="btn-connect-wallet"
          onClick={onConnectWallet}
          className="flex items-center gap-2 bg-[#1f2c40] hover:bg-[#273852] border border-[#3b4e6b] text-white px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all"
        >
          <Wallet className="w-3.5 h-3.5 text-cyan-400" />
          <span>
            {walletConnected && walletAddress
              ? `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}`
              : "Connect Wallet"}
          </span>
        </button>
      </div>
    </header>
  );
};
