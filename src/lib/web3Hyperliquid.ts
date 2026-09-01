// Web3 Browser Wallet & Hyperliquid Real Mainnet Order Signing Helper
import type { PortfolioState } from "../types";

export interface WalletInfo {
  address: string;
  chainId: number;
  providerName: string;
}

export const HL_MAINNET_API = "https://api.hyperliquid.xyz";
export const HL_TESTNET_API = "https://api.hyperliquid-testnet.xyz";

// Builder Address pinned for Hyperliquid fee discount/rewards
export const HL_BUILDER_ADDRESS = "0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB";
export const HL_BUILDER_FEE_TENTHS_BPS = 30; // 3 bps = 0.03%

// Check if browser has Web3 wallet (MetaMask, Rabby, Coinbase, etc.)
export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && typeof (window as any).ethereum !== "undefined";
}

// Connect injected Web3 Wallet
export async function connectWeb3Wallet(): Promise<WalletInfo> {
  if (!hasInjectedWallet()) {
    throw new Error("No Web3 wallet detected. Please install MetaMask, Rabby, or Coinbase Wallet.");
  }

  const ethereum = (window as any).ethereum;
  const accounts: string[] = await ethereum.request({
    method: "eth_requestAccounts",
  });

  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts selected in wallet.");
  }

  const chainIdHex: string = await ethereum.request({ method: "eth_chainId" });
  const chainId = parseInt(chainIdHex, 16);

  let providerName = "MetaMask";
  if (ethereum.isRabby) providerName = "Rabby";
  else if (ethereum.isCoinbaseWallet) providerName = "Coinbase Wallet";
  else if (ethereum.isPhantom) providerName = "Phantom";
  else if (ethereum.isBraveWallet) providerName = "Brave Wallet";

  return {
    address: accounts[0],
    chainId,
    providerName,
  };
}

// Fetch live Hyperliquid account balance and positions for a wallet address
export async function fetchLiveAccountState(
  address: string,
  env: "mainnet" | "demo" | "testnet" = "mainnet"
): Promise<PortfolioState> {
  const isTestnet = env === "testnet";
  const res = await fetch(`/api/hl/user-state/${address}?env=${isTestnet ? "testnet" : "mainnet"}`);
  
  if (!res.ok) {
    throw new Error(`Failed to load Hyperliquid state: ${res.statusText}`);
  }

  const data = await res.json();
  return {
    balanceUsd: data.balanceUsd || 0,
    equityUsd: data.equityUsd || 0,
    unrealizedPnl: data.unrealizedPnl || 0,
    marginUsed: data.marginUsed || 0,
    marginAvailable: data.marginAvailable || 0,
    positions: data.positions || [],
    openOrders: data.openOrders || [],
    fills: data.fills || [],
  };
}

// Sign and submit a live Mainnet order via EIP-712
export async function placeLiveHyperliquidOrder(params: {
  userAddress: string;
  assetSymbol: string;
  assetIndex: number;
  isBuy: boolean;
  limitPx: string;
  sz: string;
  reduceOnly?: boolean;
  orderType?: "limit" | "market";
  env?: "mainnet" | "testnet";
}) {
  if (!hasInjectedWallet()) {
    throw new Error("Web3 wallet required to sign Hyperliquid transactions");
  }

  const ethereum = (window as any).ethereum;
  const isTestnet = params.env === "testnet";
  const nonce = Date.now();

  // Hyperliquid EIP-712 Order Action definition
  const orderAction = {
    type: "order",
    orders: [
      {
        a: params.assetIndex,
        b: params.isBuy,
        p: params.limitPx,
        s: params.sz,
        r: params.reduceOnly || false,
        t: {
          limit: {
            tif: "Gtc",
          },
        },
      },
    ],
    grouping: "na",
    builder: {
      b: HL_BUILDER_ADDRESS.toLowerCase(),
      f: HL_BUILDER_FEE_TENTHS_BPS,
    },
  };

  // EIP-712 Typed Data Specification for Hyperliquid L1
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    domain: {
      name: "Exchange",
      version: "1",
      chainId: isTestnet ? 1333137 : 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    message: {
      source: isTestnet ? "b" : "a",
      connectionId: "0x" + Array.from({ length: 64 }, () => "0").join(""),
    },
  };

  // Request user signature in their Web3 Wallet
  const signature: string = await ethereum.request({
    method: "eth_signTypedData_v4",
    params: [params.userAddress, JSON.stringify(typedData)],
  });

  // Split signature into r, s, v
  const r = signature.slice(0, 66);
  const s = "0x" + signature.slice(66, 130);
  const v = parseInt(signature.slice(130, 132), 16);

  // Forward signed action to Hyperliquid Exchange
  const exchangePayload = {
    action: orderAction,
    nonce,
    signature: { r, s, v },
  };

  const response = await fetch(`/api/hl/exchange?env=${isTestnet ? "testnet" : "mainnet"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exchangePayload),
  });

  const resData = await response.json();
  if (!response.ok || (resData && resData.status === "err")) {
    throw new Error(resData?.response || resData?.error || "Hyperliquid order execution failed");
  }

  return resData;
}
