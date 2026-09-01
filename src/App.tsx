import React, { useEffect, useState, useCallback } from "react";
import { Navbar } from "./components/Navbar";
import { MarketBar } from "./components/MarketBar";
import { TradingChart } from "./components/TradingChart";
import { OrderBook } from "./components/OrderBook";
import { TradeForm } from "./components/TradeForm";
import { PositionsTable } from "./components/PositionsTable";
import { DepositModal } from "./components/DepositModal";
import { PnlShareModal } from "./components/PnlShareModal";
import { AiShowcaseView } from "./components/AiShowcaseView";
import type { Asset, PortfolioState, Position } from "./types";
import { connectWeb3Wallet, fetchLiveAccountState, hasInjectedWallet } from "./lib/web3Hyperliquid";
import "./styles.css";

export default function App() {
  const [currentView, setCurrentView] = useState<"trading" | "agents">("trading");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [presetLimitPrice, setPresetLimitPrice] = useState<string | null>(null);

  // Real Hyperliquid Clearinghouse Portfolio State
  const [portfolio, setPortfolio] = useState<PortfolioState>({
    balanceUsd: 0,
    equityUsd: 0,
    unrealizedPnl: 0,
    marginUsed: 0,
    marginAvailable: 0,
    positions: [],
    openOrders: [],
    fills: [],
  });

  // Modals & Web3
  const [depositOpen, setDepositOpen] = useState(false);
  const [sharePosition, setSharePosition] = useState<Position | null>(null);
  const [walletConnected, setWalletConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // Load Markets / Assets from Live Hyperliquid Mainnet
  const loadAssets = useCallback(async () => {
    try {
      const res = await fetch("/api/assets");
      const data = await res.json();
      if (data && Array.isArray(data.assets) && data.assets.length > 0) {
        setAssets(data.assets);
        if (!selectedAsset) {
          setSelectedAsset(data.assets[0]);
        } else {
          const updated = data.assets.find((a: Asset) => a.symbol === selectedAsset.symbol);
          if (updated) setSelectedAsset(updated);
        }
      }
    } catch (err) {
      console.error("Failed to load assets from Hyperliquid:", err);
    }
  }, [selectedAsset]);

  // Load Real Hyperliquid Clearinghouse State for Connected Wallet
  const loadPortfolio = useCallback(async () => {
    if (!walletConnected || !walletAddress) {
      setPortfolio({
        balanceUsd: 0,
        equityUsd: 0,
        unrealizedPnl: 0,
        marginUsed: 0,
        marginAvailable: 0,
        positions: [],
        openOrders: [],
        fills: [],
      });
      return;
    }

    try {
      const liveState = await fetchLiveAccountState(walletAddress, "mainnet");
      setPortfolio(liveState);
    } catch (err) {
      console.error("Failed to load live Hyperliquid portfolio:", err);
    }
  }, [walletConnected, walletAddress]);

  // Recurring Live Polling
  useEffect(() => {
    loadAssets();
    loadPortfolio();

    const timer = window.setInterval(() => {
      loadAssets();
      loadPortfolio();
    }, 4000);

    return () => window.clearInterval(timer);
  }, [loadAssets, loadPortfolio]);

  // Web3 Wallet Connect
  const handleConnectWallet = async () => {
    if (walletConnected) {
      setWalletConnected(false);
      setWalletAddress(null);
      return;
    }

    try {
      if (hasInjectedWallet()) {
        const wallet = await connectWeb3Wallet();
        setWalletAddress(wallet.address);
        setWalletConnected(true);
      } else {
        alert("Please install MetaMask, Rabby, or Coinbase Wallet to trade on Hyperliquid Mainnet.");
      }
    } catch (err) {
      console.warn("Wallet connect error:", (err as Error).message);
    }
  };

  // Close Position Handler via Hyperliquid
  const handleClosePosition = async (pos: Position) => {
    if (!walletAddress) return;
    try {
      // Placing market reduce-only order to close position on Mainnet
      const isBuyToClose = pos.side === "SHORT";
      const szFormatted = pos.size.toString();
      const pxFormatted = isBuyToClose
        ? (pos.markPrice * 1.05).toFixed(1)
        : (pos.markPrice * 0.95).toFixed(1);

      await fetch("/api/positions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: pos.id }),
      });
      loadPortfolio();
    } catch (err) {
      console.error("Error closing position on Hyperliquid:", err);
    }
  };

  const markPrice = parseFloat(selectedAsset?.markPx || "0");

  return (
    <div className="flex flex-col min-h-screen bg-[#070a0f] text-slate-100 font-sans selection:bg-cyan-500 selection:text-black">
      {/* Top Navigation */}
      <Navbar
        currentView={currentView}
        onViewChange={setCurrentView}
        selectedAsset={selectedAsset}
        assets={assets}
        onSelectAsset={setSelectedAsset}
        balanceUsd={portfolio.marginAvailable}
        equityUsd={portfolio.equityUsd}
        onOpenDeposit={() => setDepositOpen(true)}
        walletConnected={walletConnected}
        walletAddress={walletAddress}
        onConnectWallet={handleConnectWallet}
      />

      {/* Main View Router */}
      {currentView === "trading" ? (
        <div className="flex-1 flex flex-col">
          {/* Market Stats Bar */}
          <MarketBar
            selectedAsset={selectedAsset}
            assets={assets}
            onSelectAsset={setSelectedAsset}
          />

          {/* Core Trading Terminal Workspace */}
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden border-b border-[#1f2937]">
            {/* Center Area: Chart + Orderbook */}
            <div className="lg:col-span-8 xl:col-span-9 flex flex-col md:flex-row border-b lg:border-b-0 border-[#1f2937]">
              {/* Candlestick & Volume Chart */}
              <div className="flex-1 min-h-[380px] md:min-h-[440px] flex flex-col">
                <TradingChart
                  symbol={selectedAsset?.symbol || "BTC"}
                  markPrice={markPrice}
                />
              </div>

              {/* Order Book & Recent Fills */}
              <div className="w-full md:w-64 xl:w-72 min-h-[340px] flex flex-col">
                <OrderBook
                  symbol={selectedAsset?.symbol || "BTC"}
                  markPrice={markPrice}
                  onSelectPrice={(px) => setPresetLimitPrice(px)}
                />
              </div>
            </div>

            {/* Right Area: Trade Form (Long/Short, Leverage, Order Placement) */}
            <div className="lg:col-span-4 xl:col-span-3 flex flex-col bg-[#0d121c]">
              <TradeForm
                asset={selectedAsset}
                markPrice={markPrice}
                availableBalance={portfolio.marginAvailable}
                onOrderPlaced={loadPortfolio}
                presetPrice={presetLimitPrice}
                onClearPresetPrice={() => setPresetLimitPrice(null)}
                walletConnected={walletConnected}
                walletAddress={walletAddress}
                onConnectWallet={handleConnectWallet}
              />
            </div>
          </div>

          {/* Bottom Area: Open Positions, Orders, and Trade History */}
          <div className="h-72 min-h-[220px]">
            <PositionsTable
              positions={portfolio.positions}
              openOrders={portfolio.openOrders}
              fills={portfolio.fills}
              onClosePosition={handleClosePosition}
              onSharePnl={(pos) => setSharePosition(pos)}
              onRefresh={loadPortfolio}
            />
          </div>
        </div>
      ) : (
        /* AI Trading Agents Showcase */
        <AiShowcaseView
          onSelectMarketToTrade={(sym) => {
            const match = assets.find((a) => a.symbol === sym);
            if (match) setSelectedAsset(match);
            setCurrentView("trading");
          }}
        />
      )}

      {/* Deposit Bridge Modal */}
      <DepositModal
        isOpen={depositOpen}
        onClose={() => setDepositOpen(false)}
        onDepositSuccess={loadPortfolio}
        currentBalance={portfolio.marginAvailable}
      />

      {/* PnL Card Sharing Modal */}
      <PnlShareModal
        position={sharePosition}
        isOpen={!!sharePosition}
        onClose={() => setSharePosition(null)}
      />
    </div>
  );
}
