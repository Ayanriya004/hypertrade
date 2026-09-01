import React, { useState, useEffect } from "react";
import {
  Bot,
  TrendingUp,
  Activity,
  Shield,
  Zap,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronRight,
  Sparkles,
  Award,
} from "lucide-react";

interface AiAgent {
  id: string;
  name: string;
  strategy: string;
  description: string;
  winRate: number;
  totalPnl: number;
  totalTrades: number;
  sharpeRatio: number;
  status: "active" | "monitoring" | "rebalancing";
  activePositions: {
    symbol: string;
    side: "LONG" | "SHORT";
    leverage: number;
    pnl: number;
    pnlPct: number;
    thesis: string;
  }[];
  recentActivity: string[];
}

export const AiShowcaseView: React.FC<{ onSelectMarketToTrade: (symbol: string) => void }> = ({
  onSelectMarketToTrade,
}) => {
  const [agents, setAgents] = useState<AiAgent[]>([
    {
      id: "agent-momentum",
      name: "AlphaMomentum HL-1",
      strategy: "Trend Following & Order Flow Imbalance",
      description:
        "Continuously samples Hyperliquid L1 order books, funding rate divergence, and momentum indicators to execute high-conviction directional perps with dynamic trailing stop-losses.",
      winRate: 74.2,
      totalPnl: 18450.8,
      totalTrades: 428,
      sharpeRatio: 2.85,
      status: "active",
      activePositions: [
        {
          symbol: "BTC",
          side: "LONG",
          leverage: 10,
          pnl: 1420.5,
          pnlPct: 14.2,
          thesis: "Bullish order flow breakout above key volume weighted average price (VWAP) with negative funding.",
        },
        {
          symbol: "SOL",
          side: "LONG",
          leverage: 5,
          pnl: 680.2,
          pnlPct: 8.5,
          thesis: "Relative strength against ETH and increasing open interest across L1 peers.",
        },
      ],
      recentActivity: [
        "Opened BTC-PERP LONG 10x at $64,200",
        "Adjusted trailing stop for SOL-PERP to $145.20",
        "Closed SUI-PERP SHORT with +6.4% gain",
      ],
    },
    {
      id: "agent-arbitrage",
      name: "FundingHarvester Pro",
      strategy: "Delta-Neutral Funding Rate Harvesting",
      description:
        "Identifies extreme funding rate dislocations across Hyperliquid perpetual contracts and captures yield while hedging spot exposure.",
      winRate: 88.5,
      totalPnl: 9820.4,
      totalTrades: 194,
      sharpeRatio: 3.42,
      status: "active",
      activePositions: [
        {
          symbol: "HYPE",
          side: "SHORT",
          leverage: 3,
          pnl: 310.8,
          pnlPct: 4.8,
          thesis: "Capturing 0.04% hourly funding premium while delta hedged against ecosystem basket.",
        },
      ],
      recentActivity: [
        "Collected funding payment on HYPE-PERP ($42.10)",
        "Rebalanced collateral ratio to 150%",
      ],
    },
    {
      id: "agent-macro",
      name: "MacroSynthetix HIP-3",
      strategy: "Multi-Asset Equities & Commodities (HIP-3)",
      description:
        "Trades cross-market correlations between NASDAQ equities (NVDA, TSLA), commodities (GOLD), and crypto assets during high volatility news events.",
      winRate: 69.8,
      totalPnl: 12640.1,
      totalTrades: 260,
      sharpeRatio: 2.31,
      status: "monitoring",
      activePositions: [
        {
          symbol: "NVDA",
          side: "LONG",
          leverage: 5,
          pnl: 890.0,
          pnlPct: 11.2,
          thesis: "Pre-earnings momentum and semiconductor supply chain data signals strong revenue beat.",
        },
        {
          symbol: "GOLD",
          side: "LONG",
          leverage: 20,
          pnl: 450.3,
          pnlPct: 6.9,
          thesis: "Treasury yield compression catalyst driving safe-haven allocation.",
        },
      ],
      recentActivity: [
        "Opened GOLD-PERP LONG 20x at $2,480",
        "Updated macro risk score: Moderate",
      ],
    },
  ]);

  const [selectedAgent, setSelectedAgent] = useState<AiAgent>(agents[0]);

  return (
    <div className="flex-1 bg-[#090d14] text-white p-4 md:p-6 overflow-y-auto">
      {/* Top Banner */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="bg-gradient-to-r from-[#111c2e] via-[#0e1826] to-[#121528] border border-[#233348] rounded-2xl p-5 md:p-6 shadow-xl relative overflow-hidden">
          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  Hyperliquid Autonomous Agents
                </span>
                <span className="bg-emerald-500/20 text-emerald-400 text-xs font-mono px-2 py-0.5 rounded-full">
                  All Systems Operational
                </span>
              </div>
              <h1 className="text-xl md:text-2xl font-black tracking-tight text-white mb-1">
                AI Trading Agents Showcase
              </h1>
              <p className="text-xs md:text-sm text-slate-400 max-w-2xl">
                Observe live algorithmic trading strategies running on Hyperliquid L1 order books. Review their real-time positions, decision theses, and performance metrics.
              </p>
            </div>

            {/* Aggregated Stats */}
            <div className="flex items-center gap-4 bg-[#0a101b] p-3 rounded-xl border border-[#1e2a3c]">
              <div>
                <div className="text-[10px] uppercase font-bold text-slate-400">Total Net PnL</div>
                <div className="text-lg font-mono font-black text-emerald-400">+$40,911.30</div>
              </div>
              <div className="h-8 w-px bg-[#1e2a3c]"></div>
              <div>
                <div className="text-[10px] uppercase font-bold text-slate-400">Avg. Win Rate</div>
                <div className="text-lg font-mono font-black text-cyan-400">77.5%</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Agents Grid & Detail View */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Agent Cards */}
        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Available AI Models</h2>
          {agents.map((agent) => {
            const isSelected = selectedAgent.id === agent.id;
            return (
              <div
                key={agent.id}
                onClick={() => setSelectedAgent(agent)}
                className={`p-4 rounded-xl border cursor-pointer transition-all ${
                  isSelected
                    ? "bg-[#141f30] border-cyan-500 shadow-lg shadow-cyan-500/10"
                    : "bg-[#0f1521] border-[#202c3e] hover:border-[#2f4058]"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-500/40 flex items-center justify-center text-cyan-300">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-bold text-sm text-white">{agent.name}</div>
                      <div className="text-[11px] text-slate-400">{agent.strategy}</div>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${
                      agent.status === "active"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-amber-500/20 text-amber-400"
                    }`}
                  >
                    {agent.status}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-3 pt-2.5 border-t border-[#1e2a3c] text-center font-mono">
                  <div>
                    <div className="text-[10px] text-slate-500">Win Rate</div>
                    <div className="text-xs font-bold text-slate-200">{agent.winRate}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500">Profit</div>
                    <div className="text-xs font-bold text-emerald-400">+${agent.totalPnl.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500">Sharpe</div>
                    <div className="text-xs font-bold text-cyan-400">{agent.sharpeRatio}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right Column: Selected Agent Deep-Dive */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-[#0f1521] border border-[#202c3e] rounded-xl p-5">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#202c3e] pb-4 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
                  <Bot className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base text-white">{selectedAgent.name}</h3>
                  <div className="text-xs text-cyan-400 font-semibold">{selectedAgent.strategy}</div>
                </div>
              </div>
            </div>

            {/* Description */}
            <p className="text-xs text-slate-300 leading-relaxed mb-5 bg-[#0a0e16] p-3.5 rounded-xl border border-[#1b2535]">
              {selectedAgent.description}
            </p>

            {/* Active Positions Held by Agent */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2.5">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Live Positions & Trade Theses ({selectedAgent.activePositions.length})
                </h4>
              </div>

              <div className="space-y-3">
                {selectedAgent.activePositions.map((pos, i) => (
                  <div
                    key={i}
                    className="p-3.5 bg-[#0b1018] rounded-xl border border-[#1e2a3c] space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-sm text-white">{pos.symbol}-PERP</span>
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded ${
                            pos.side === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                          }`}
                        >
                          {pos.leverage}x {pos.side}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-xs font-bold text-emerald-400">
                          +${pos.pnl.toFixed(2)} (+{pos.pnlPct}%)
                        </span>
                        <button
                          onClick={() => onSelectMarketToTrade(pos.symbol)}
                          className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 text-[11px] font-bold rounded-lg transition-all flex items-center gap-1"
                        >
                          <span>Trade {pos.symbol}</span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-400 bg-[#070b10] p-2.5 rounded-lg border border-[#16202f]">
                      <span className="text-cyan-400 font-semibold">AI Thesis: </span>
                      {pos.thesis}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent Execution Activity Feed */}
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-2">
                Recent Order Execution Feed
              </h4>
              <div className="space-y-1.5 font-mono text-[11px]">
                {selectedAgent.recentActivity.map((act, i) => (
                  <div
                    key={i}
                    className="p-2 bg-[#0b1018] rounded-lg border border-[#1a2332] text-slate-300 flex items-center gap-2"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    <span>{act}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
