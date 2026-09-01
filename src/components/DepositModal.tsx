import React, { useState } from "react";
import { X, Coins, Shield, ExternalLink, ArrowUpRight, Copy, Check } from "lucide-react";

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDepositSuccess: () => void;
  currentBalance: number;
}

export const DepositModal: React.FC<DepositModalProps> = ({
  isOpen,
  onClose,
  currentBalance,
}) => {
  const [copied, setCopied] = useState(false);
  const bridgeContract = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7"; // Hyperliquid Arbitrum Bridge

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(bridgeContract);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#121824] border border-[#273549] rounded-2xl w-full max-w-md overflow-hidden shadow-2xl text-white">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#1f2937] bg-[#0c1017]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Coins className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-sm">Deposit USDC to Hyperliquid</div>
              <div className="text-[11px] text-slate-400">Arbitrum One Native Bridge</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div className="bg-[#0c1017] p-3 rounded-xl border border-[#1f2937] flex items-center justify-between">
            <span className="text-xs text-slate-400">Current Margin Available</span>
            <span className="text-sm font-mono font-bold text-cyan-400">
              ${currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              How to deposit to Hyperliquid Mainnet:
            </div>
            <div className="text-xs text-slate-400 space-y-2 bg-[#161f2e] p-3 rounded-xl border border-[#273549]">
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                  1
                </span>
                <span>Connect your Web3 Wallet (MetaMask, Rabby, Coinbase) on Arbitrum One network.</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                  2
                </span>
                <span>Deposit native USDC directly to the Hyperliquid Bridge contract on Arbitrum.</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                  3
                </span>
                <span>Funds will automatically reflect in your Hyperliquid L1 clearinghouse account.</span>
              </div>
            </div>

            <div className="bg-[#0c1017] p-3 rounded-xl border border-[#1f2937]">
              <div className="text-[10px] text-slate-400 mb-1 font-semibold uppercase tracking-wider">
                Official Hyperliquid Arbitrum Bridge:
              </div>
              <div className="flex items-center justify-between gap-2 bg-[#161f2e] px-2.5 py-1.5 rounded-lg border border-[#273549]">
                <span className="font-mono text-xs text-slate-300 truncate">{bridgeContract}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 text-slate-400 hover:text-cyan-400 transition-all shrink-0"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-emerald-950/40 p-3 rounded-xl border border-emerald-500/30 text-[11px] text-emerald-300 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              Direct Mainnet Execution
            </div>
            <p className="text-slate-400">
              Orders are signed with your private key via EIP-712 and submitted directly to the Hyperliquid L1 node.
            </p>
          </div>

          <a
            href="https://app.hyperliquid.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-extrabold text-xs transition-all shadow-lg shadow-cyan-500/30 flex items-center justify-center gap-1.5"
          >
            <span>Open Official Hyperliquid Bridge</span>
            <ArrowUpRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
};
