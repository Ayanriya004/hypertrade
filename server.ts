import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// In-memory cache for HL allMids and metadata
let cachedMids: Record<string, number> = {};
let lastMidsFetch = 0;
let cachedMeta: any = null;
let lastMetaFetch = 0;

// User trading state store (paper/demo + live tracking)
interface WebPosition {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  size: number;
  sizeUsd: number;
  leverage: number;
  marginType: "cross" | "isolated";
  marginUsed: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  openedAt: number;
  tpPrice?: number;
  slPrice?: number;
}

interface WebOrder {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "market" | "limit" | "stop_market" | "take_profit";
  price: number;
  triggerPrice?: number;
  size: number;
  sizeUsd: number;
  leverage: number;
  status: "open" | "filled" | "cancelled";
  createdAt: number;
  reduceOnly?: boolean;
}

interface WebFill {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  dir: string;
  price: number;
  size: number;
  sizeUsd: number;
  feeUsd: number;
  pnlUsd?: number;
  timestamp: number;
}

interface UserAccountState {
  balanceUsd: number;
  depositedUsd: number;
  positions: WebPosition[];
  openOrders: WebOrder[];
  fills: WebFill[];
}

const userAccounts: Record<string, UserAccountState> = {
  default: {
    balanceUsd: 10000,
    depositedUsd: 10000,
    positions: [
      {
        id: "pos-btc-1",
        symbol: "BTC",
        side: "LONG",
        entryPrice: 88400,
        markPrice: 89450,
        size: 0.05,
        sizeUsd: 4472.5,
        leverage: 5,
        marginType: "cross",
        marginUsed: 884.0,
        liquidationPrice: 71200,
        unrealizedPnl: 52.5,
        unrealizedPct: 5.94,
        openedAt: Date.now() - 3600000 * 4,
        tpPrice: 93500,
        slPrice: 86000,
      },
    ],
    openOrders: [
      {
        id: "ord-sol-1",
        symbol: "SOL",
        side: "BUY",
        orderType: "limit",
        price: 162.5,
        size: 15,
        sizeUsd: 2437.5,
        leverage: 5,
        status: "open",
        createdAt: Date.now() - 3600000 * 2,
      },
    ],
    fills: [
      {
        id: "fill-btc-1",
        symbol: "BTC",
        side: "BUY",
        dir: "Open Long",
        price: 88400,
        size: 0.05,
        sizeUsd: 4420,
        feeUsd: 1.76,
        timestamp: Date.now() - 3600000 * 4,
      },
    ],
  },
};

function getOrCreateUserAccount(userId: string = "default"): UserAccountState {
  if (!userAccounts[userId]) {
    userAccounts[userId] = {
      balanceUsd: 10000,
      depositedUsd: 10000,
      positions: [],
      openOrders: [],
      fills: [],
    };
  }
  return userAccounts[userId];
}

async function getLiveMids(): Promise<Record<string, number>> {
  const now = Date.now();
  if (now - lastMidsFetch < 10000 && Object.keys(cachedMids).length > 0) {
    return cachedMids;
  }
  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data === "object") {
        const parsed: Record<string, number> = {};
        for (const [k, v] of Object.entries(data)) {
          const num = parseFloat(v as string);
          if (!isNaN(num)) parsed[k] = num;
        }
        cachedMids = { ...cachedMids, ...parsed };
        lastMidsFetch = now;
        return cachedMids;
      }
    }
  } catch (err) {
    console.warn("Live HL mids fetch error:", (err as Error).message);
  }
  return {
    BTC: 89450,
    ETH: 2540,
    SOL: 168.5,
    HYPE: 24.8,
    SUI: 2.85,
    NVDA: 138.2,
    TSLA: 265.4,
    GOLD: 2715,
    SILVER: 31.4,
    PURR: 0.142,
    HOOD: 34.5,
    AVAX: 26.2,
    LINK: 17.8,
    AAVE: 182.5,
    UNI: 9.4,
    ARB: 0.58,
    NEAR: 4.8,
    ...cachedMids,
  };
}

async function getMetaAndAssetCtxs(): Promise<any> {
  const now = Date.now();
  if (now - lastMetaFetch < 15000 && cachedMeta) {
    return cachedMeta;
  }
  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const data = await response.json();
      if (data && Array.isArray(data) && data.length === 2) {
        cachedMeta = data;
        lastMetaFetch = now;
        return data;
      }
    }
  } catch (err) {
    console.warn("Meta fetch error:", (err as Error).message);
  }
  return cachedMeta;
}

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Builder config
app.get("/api/builder-config", (_req, res) => {
  res.json({
    builder_address: "0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB",
    builder_fee_rate: "0.03%",
    builder_fee_tenths_bps: 30,
    status: "active",
  });
});

// Hyperliquid Direct Info Proxy (CORS-safe)
app.post("/api/hl/info", async (req, res) => {
  try {
    const isTestnet = req.query.env === "testnet";
    const endpoint = isTestnet
      ? "https://api.hyperliquid-testnet.xyz/info"
      : "https://api.hyperliquid.xyz/info";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Hyperliquid Direct Exchange Proxy (Signed EIP-712 actions)
app.post("/api/hl/exchange", async (req, res) => {
  try {
    const isTestnet = req.query.env === "testnet";
    const endpoint = isTestnet
      ? "https://api.hyperliquid-testnet.xyz/exchange"
      : "https://api.hyperliquid.xyz/exchange";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Live Hyperliquid Account Sync for Connected Wallet Address
app.get("/api/hl/user-state/:address", async (req, res) => {
  const address = req.params.address;
  const isTestnet = req.query.env === "testnet";
  const infoUrl = isTestnet
    ? "https://api.hyperliquid-testnet.xyz/info"
    : "https://api.hyperliquid.xyz/info";

  if (!address || !address.startsWith("0x")) {
    return res.status(400).json({ error: "Invalid Ethereum address" });
  }

  try {
    const [stateRes, ordersRes, fillsRes] = await Promise.all([
      fetch(infoUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: address }),
      }),
      fetch(infoUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "openOrders", user: address }),
      }),
      fetch(infoUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userFills", user: address }),
      }),
    ]);

    const stateData = stateRes.ok ? await stateRes.json() : null;
    const ordersData = ordersRes.ok ? await ordersRes.json() : [];
    const fillsData = fillsRes.ok ? await fillsRes.json() : [];

    if (!stateData || !stateData.marginSummary) {
      return res.json({
        isLive: true,
        address,
        balanceUsd: 0,
        equityUsd: 0,
        unrealizedPnl: 0,
        marginUsed: 0,
        marginAvailable: 0,
        positions: [],
        openOrders: [],
        fills: [],
      });
    }

    const marginSummary = stateData.marginSummary;
    const accountValue = parseFloat(marginSummary.accountValue || "0");
    const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || "0");
    const totalRawUsd = parseFloat(marginSummary.totalRawUsd || "0");
    const withdrawable = parseFloat(stateData.withdrawable || "0");

    // Transform HL assetPositions
    const positions: WebPosition[] = [];
    if (Array.isArray(stateData.assetPositions)) {
      stateData.assetPositions.forEach((item: any, idx: number) => {
        const pos = item.position;
        if (!pos) return;
        const szi = parseFloat(pos.szi || "0");
        if (Math.abs(szi) < 1e-7) return; // closed / empty position

        const entryPx = parseFloat(pos.entryPx || "0");
        const liqPx = parseFloat(pos.liquidationPx || "0");
        const posValue = parseFloat(pos.positionValue || "0");
        const unrealizedPnl = parseFloat(pos.unrealizedPnl || "0");
        const returnOnEquity = parseFloat(pos.returnOnEquity || "0");
        const levValue = pos.leverage?.value || 1;
        const isCross = pos.leverage?.type === "cross";

        positions.push({
          id: `hl-pos-${pos.coin}-${idx}`,
          symbol: pos.coin,
          side: szi > 0 ? "LONG" : "SHORT",
          entryPrice: entryPx,
          markPrice: entryPx > 0 && szi !== 0 ? Math.round((posValue / Math.abs(szi)) * 100) / 100 : entryPx,
          size: Math.abs(szi),
          sizeUsd: posValue,
          leverage: levValue,
          marginType: isCross ? "cross" : "isolated",
          marginUsed: Math.round((posValue / levValue) * 100) / 100,
          liquidationPrice: liqPx,
          unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
          unrealizedPct: Math.round(returnOnEquity * 10000) / 100,
          openedAt: Date.now(),
        });
      });
    }

    // Transform open orders
    const openOrders: WebOrder[] = Array.isArray(ordersData)
      ? ordersData.map((o: any) => ({
          id: String(o.oid || o.id || Math.random()),
          symbol: o.coin,
          side: o.side === "B" ? "BUY" : "SELL",
          orderType: "limit",
          price: parseFloat(o.limitPx || "0"),
          size: parseFloat(o.sz || "0"),
          sizeUsd: parseFloat(o.limitPx || "0") * parseFloat(o.sz || "0"),
          leverage: 1,
          status: "open",
          createdAt: o.timestamp || Date.now(),
          reduceOnly: o.reduceOnly,
        }))
      : [];

    // Transform user fills
    const fills: WebFill[] = Array.isArray(fillsData)
      ? fillsData.slice(0, 50).map((f: any) => ({
          id: String(f.tid || f.id || Math.random()),
          symbol: f.coin,
          side: f.side === "B" ? "BUY" : "SELL",
          dir: f.dir || (f.side === "B" ? "Buy / Long" : "Sell / Short"),
          price: parseFloat(f.px || "0"),
          size: parseFloat(f.sz || "0"),
          sizeUsd: parseFloat(f.px || "0") * parseFloat(f.sz || "0"),
          feeUsd: parseFloat(f.fee || "0"),
          pnlUsd: f.closedPnl ? parseFloat(f.closedPnl) : undefined,
          timestamp: f.time || Date.now(),
        }))
      : [];

    const totalUnrealized = positions.reduce((a, b) => a + b.unrealizedPnl, 0);

    return res.json({
      isLive: true,
      address,
      balanceUsd: Math.round(totalRawUsd * 100) / 100,
      equityUsd: Math.round(accountValue * 100) / 100,
      unrealizedPnl: Math.round(totalUnrealized * 100) / 100,
      marginUsed: Math.round(totalMarginUsed * 100) / 100,
      marginAvailable: Math.round(withdrawable * 100) / 100,
      positions,
      openOrders,
      fills,
    });
  } catch (err) {
    console.error("Error fetching live HL state:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// Market Assets List
app.get("/api/assets", async (_req, res) => {
  const mids = await getLiveMids();
  const metaData = await getMetaAndAssetCtxs();

  const coinList = [
    { coin: "BTC", name: "Bitcoin", category: "crypto", maxLeverage: 50, szDecimals: 5 },
    { coin: "ETH", name: "Ethereum", category: "crypto", maxLeverage: 50, szDecimals: 4 },
    { coin: "SOL", name: "Solana", category: "crypto", maxLeverage: 20, szDecimals: 2 },
    { coin: "HYPE", name: "Hyperliquid", category: "crypto", maxLeverage: 20, szDecimals: 2 },
    { coin: "SUI", name: "Sui", category: "crypto", maxLeverage: 20, szDecimals: 1 },
    { coin: "PURR", name: "Purr Spot", category: "spot", maxLeverage: 1, szDecimals: 0 },
    { coin: "NVDA", name: "Nvidia", category: "equities", maxLeverage: 10, szDecimals: 2 },
    { coin: "TSLA", name: "Tesla", category: "equities", maxLeverage: 10, szDecimals: 2 },
    { coin: "GOLD", name: "Gold", category: "commodities", maxLeverage: 20, szDecimals: 3 },
    { coin: "SILVER", name: "Silver", category: "commodities", maxLeverage: 20, szDecimals: 2 },
    { coin: "HOOD", name: "Robinhood", category: "equities", maxLeverage: 10, szDecimals: 2 },
    { coin: "AVAX", name: "Avalanche", category: "crypto", maxLeverage: 20, szDecimals: 2 },
    { coin: "LINK", name: "Chainlink", category: "crypto", maxLeverage: 20, szDecimals: 2 },
    { coin: "AAVE", name: "Aave", category: "crypto", maxLeverage: 20, szDecimals: 2 },
    { coin: "UNI", name: "Uniswap", category: "crypto", maxLeverage: 20, szDecimals: 2 },
    { coin: "ARB", name: "Arbitrum", category: "crypto", maxLeverage: 20, szDecimals: 1 },
    { coin: "NEAR", name: "Near Protocol", category: "crypto", maxLeverage: 20, szDecimals: 1 },
  ];

  // If live meta is available, enrich with actual 24h stats
  const enriched = coinList.map((item) => {
    const markPx = mids[item.coin] || 100;
    let change24h = (Math.sin(item.coin.charCodeAt(0)) * 4.5);
    let dayNtlVlm = "124500000";
    let funding = "0.0001";
    let openInterest = "45000000";

    if (metaData && metaData[0]?.universe && metaData[1]) {
      const uIndex = metaData[0].universe.findIndex((u: any) => u.name === item.coin);
      if (uIndex >= 0 && metaData[1][uIndex]) {
        const ctx = metaData[1][uIndex];
        const prevPx = parseFloat(ctx.prevDayPx || "0");
        const currentPx = parseFloat(ctx.markPx || String(markPx));
        if (prevPx > 0) {
          change24h = Math.round(((currentPx - prevPx) / prevPx) * 10000) / 100;
        }
        dayNtlVlm = ctx.dayNtlVlm || dayNtlVlm;
        funding = ctx.funding || funding;
        openInterest = ctx.openInterest || openInterest;
      }
    }

    return {
      ...item,
      symbol: item.coin,
      markPx: markPx.toString(),
      prevDayPx: (markPx * (1 - change24h / 100)).toString(),
      dayNtlVlm,
      funding,
      openInterest,
      change24h: Math.round(change24h * 100) / 100,
      isHip3: item.category === "equities" || item.category === "commodities",
    };
  });

  res.json({ assets: enriched, count: enriched.length });
});

// Single Asset Detail
app.get("/api/assets/:coin", async (req, res) => {
  const coin = (req.params.coin || "BTC").toUpperCase();
  const mids = await getLiveMids();
  const markPx = mids[coin] || 100;
  
  res.json({
    coin,
    symbol: coin,
    name: coin,
    markPx: markPx.toString(),
    midPx: markPx.toString(),
    oraclePx: markPx.toString(),
    maxLeverage: coin === "BTC" || coin === "ETH" ? 50 : 20,
    szDecimals: 4,
    change24h: 2.45,
    dayNtlVlm: "84500000",
    funding: "0.00012",
    openInterest: "18500000",
    isHip3: false,
  });
});

// Candles Endpoint
app.get("/api/candles/:coin", async (req, res) => {
  const coin = (req.params.coin || "BTC").toUpperCase();
  const interval = (req.query.interval as string) || "15m";
  const limit = Math.min(parseInt((req.query.limit as string) || "120", 10), 300);
  const mids = await getLiveMids();
  const currentPx = mids[coin] || 89000;

  try {
    const hlInterval = interval === "1d" ? "1d" : interval === "4h" ? "4h" : interval === "1h" ? "1h" : interval === "15m" ? "15m" : interval === "5m" ? "5m" : "1h";
    const endTime = Date.now();
    const startTime = endTime - (limit * 3600 * 1000 * (interval === "1d" ? 24 : interval === "4h" ? 4 : 1));

    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: {
          coin,
          interval: hlInterval,
          startTime,
          endTime,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const candles = data.map((c: any) => ({
          t: c.t,
          T: c.T,
          s: coin,
          i: interval,
          o: parseFloat(c.o),
          c: parseFloat(c.c),
          h: parseFloat(c.h),
          l: parseFloat(c.l),
          v: parseFloat(c.v),
          n: c.n,
        }));
        return res.json({ candles, coin, interval });
      }
    }
  } catch (err) {
    console.warn("Candle snapshot fetch error, generating synth candles:", (err as Error).message);
  }

  // Generate realistic fallback candles around current mark price
  const candles = [];
  const stepMs = interval === "1m" ? 60000 : interval === "5m" ? 300000 : interval === "15m" ? 900000 : interval === "1h" ? 3600000 : 86400000;
  let runningPx = currentPx * 0.96;
  const now = Date.now();

  for (let i = limit; i >= 0; i--) {
    const t = now - i * stepMs;
    const deltaPct = (Math.sin(i * 0.3) * 0.008) + ((Math.random() - 0.48) * 0.006);
    const o = runningPx;
    const c = o * (1 + deltaPct);
    const h = Math.max(o, c) * (1 + Math.random() * 0.003);
    const l = Math.min(o, c) * (1 - Math.random() * 0.003);
    const v = Math.round(1000 + Math.random() * 5000);
    runningPx = c;

    candles.push({
      t,
      T: t + stepMs,
      s: coin,
      i: interval,
      o: Math.round(o * 100) / 100,
      c: Math.round(c * 100) / 100,
      h: Math.round(h * 100) / 100,
      l: Math.round(l * 100) / 100,
      v,
      n: Math.round(v / 10),
    });
  }

  res.json({ candles, coin, interval });
});

// Orderbook Endpoint
app.get("/api/orderbook/:coin", async (req, res) => {
  const coin = (req.params.coin || "BTC").toUpperCase();
  const mids = await getLiveMids();
  const markPx = mids[coin] || 100;

  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin }),
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const data = await response.json();
      if (data && data.levels) {
        return res.json(data);
      }
    }
  } catch (err) {
    // fallback
  }

  // Synthetic depth levels
  const bids = [];
  const asks = [];
  for (let i = 1; i <= 10; i++) {
    const bidPx = markPx * (1 - i * 0.0006);
    const askPx = markPx * (1 + i * 0.0006);
    const sz = Math.round((Math.random() * 2.5 + 0.5) * 100) / 100;
    bids.push({ px: bidPx.toFixed(markPx < 10 ? 4 : 2), sz: sz.toString(), n: 1 });
    asks.push({ px: askPx.toFixed(markPx < 10 ? 4 : 2), sz: sz.toString(), n: 1 });
  }

  res.json({ coin, levels: [bids, asks], time: Date.now() });
});

// User Portfolio & Positions Endpoint
app.get("/api/portfolio", async (req, res) => {
  const userId = (req.query.userId as string) || "default";
  const user = getOrCreateUserAccount(userId);
  const mids = await getLiveMids();

  // Recalculate live unrealized PnL on positions
  user.positions.forEach((pos) => {
    const currentMark = mids[pos.symbol] || pos.markPrice;
    pos.markPrice = currentMark;
    if (pos.side === "LONG") {
      pos.unrealizedPnl = Math.round(((currentMark - pos.entryPrice) * pos.size) * 100) / 100;
      pos.unrealizedPct = Math.round(((currentMark - pos.entryPrice) / pos.entryPrice) * pos.leverage * 10000) / 100;
    } else {
      pos.unrealizedPnl = Math.round(((pos.entryPrice - currentMark) * pos.size) * 100) / 100;
      pos.unrealizedPct = Math.round(((pos.entryPrice - currentMark) / pos.entryPrice) * pos.leverage * 10000) / 100;
    }
  });

  const totalUnrealizedPnl = user.positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
  const totalMarginUsed = user.positions.reduce((acc, p) => acc + p.marginUsed, 0);
  const equityUsd = user.balanceUsd + totalUnrealizedPnl;

  res.json({
    balanceUsd: user.balanceUsd,
    equityUsd: Math.round(equityUsd * 100) / 100,
    unrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
    marginUsed: Math.round(totalMarginUsed * 100) / 100,
    marginAvailable: Math.max(0, Math.round((equityUsd - totalMarginUsed) * 100) / 100),
    positions: user.positions,
    openOrders: user.openOrders,
    fills: user.fills,
  });
});

// Place Order / Trade Execution Endpoint
app.post("/api/orders/place", async (req, res) => {
  const {
    userId = "default",
    symbol,
    side, // "long" or "short" / "buy" or "sell"
    orderType = "market",
    sizeUsd,
    leverage = 5,
    marginType = "cross",
    limitPrice,
    tpPrice,
    slPrice,
  } = req.body;

  if (!symbol || !sizeUsd || sizeUsd <= 0) {
    return res.status(400).json({ error: "Invalid order parameters: symbol and sizeUsd are required" });
  }

  const user = getOrCreateUserAccount(userId);
  const mids = await getLiveMids();
  const currentPx = mids[symbol.toUpperCase()] || 100;
  const execPx = limitPrice && orderType === "limit" ? parseFloat(limitPrice) : currentPx;
  const tokenSize = Math.round((sizeUsd / execPx) * 10000) / 10000;
  const marginRequired = Math.round((sizeUsd / leverage) * 100) / 100;

  if (marginRequired > user.balanceUsd) {
    return res.status(400).json({ error: `Insufficient margin. Required: $${marginRequired}, Available: $${user.balanceUsd.toFixed(2)}` });
  }

  const isLong = side.toLowerCase().includes("long") || side.toLowerCase() === "buy";
  const posSide = isLong ? "LONG" : "SHORT";

  if (orderType === "limit" && limitPrice && Math.abs(parseFloat(limitPrice) - currentPx) > 0.001) {
    // Resting limit order
    const newOrder: WebOrder = {
      id: `ord-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      symbol: symbol.toUpperCase(),
      side: isLong ? "BUY" : "SELL",
      orderType: "limit",
      price: parseFloat(limitPrice),
      size: tokenSize,
      sizeUsd,
      leverage,
      status: "open",
      createdAt: Date.now(),
    };
    user.openOrders.unshift(newOrder);

    return res.json({
      success: true,
      message: `Resting limit order placed for ${tokenSize} ${symbol.toUpperCase()} at $${limitPrice}`,
      order: newOrder,
    });
  }

  // Market order execution
  const feeUsd = Math.round(sizeUsd * 0.00035 * 100) / 100;
  user.balanceUsd -= feeUsd;

  // Calculate liquidation price
  const liqBuffer = 1 / leverage * 0.9;
  const liquidationPrice = isLong
    ? Math.round(execPx * (1 - liqBuffer) * 100) / 100
    : Math.round(execPx * (1 + liqBuffer) * 100) / 100;

  // Check if position already exists for this symbol
  const existingPosIndex = user.positions.findIndex((p) => p.symbol === symbol.toUpperCase());
  if (existingPosIndex >= 0) {
    const existing = user.positions[existingPosIndex];
    if (existing.side === posSide) {
      // Add to position
      const totalSize = existing.size + tokenSize;
      const totalSizeUsd = existing.sizeUsd + sizeUsd;
      const weightedEntry = (existing.entryPrice * existing.size + execPx * tokenSize) / totalSize;
      existing.entryPrice = Math.round(weightedEntry * 100) / 100;
      existing.size = totalSize;
      existing.sizeUsd = totalSizeUsd;
      existing.marginUsed += marginRequired;
    } else {
      // Reduce / Flip position
      if (tokenSize >= existing.size) {
        // Closed or flipped
        user.positions.splice(existingPosIndex, 1);
        user.balanceUsd += existing.unrealizedPnl;
      } else {
        existing.size -= tokenSize;
        existing.sizeUsd -= sizeUsd;
        existing.marginUsed = Math.max(0, existing.marginUsed - marginRequired);
      }
    }
  } else {
    // New Position
    const newPos: WebPosition = {
      id: `pos-${Date.now()}`,
      symbol: symbol.toUpperCase(),
      side: posSide,
      entryPrice: execPx,
      markPrice: currentPx,
      size: tokenSize,
      sizeUsd,
      leverage,
      marginType,
      marginUsed: marginRequired,
      liquidationPrice,
      unrealizedPnl: 0,
      unrealizedPct: 0,
      openedAt: Date.now(),
      tpPrice: tpPrice ? parseFloat(tpPrice) : undefined,
      slPrice: slPrice ? parseFloat(slPrice) : undefined,
    };
    user.positions.unshift(newPos);
  }

  // Record fill
  const fillRecord: WebFill = {
    id: `fill-${Date.now()}`,
    symbol: symbol.toUpperCase(),
    side: isLong ? "BUY" : "SELL",
    dir: `Open ${posSide}`,
    price: execPx,
    size: tokenSize,
    sizeUsd,
    feeUsd,
    timestamp: Date.now(),
  };
  user.fills.unshift(fillRecord);

  res.json({
    success: true,
    message: `Filled ${posSide} ${tokenSize} ${symbol.toUpperCase()} at $${execPx.toFixed(2)}`,
    fill: fillRecord,
    positions: user.positions,
    balanceUsd: user.balanceUsd,
  });
});

// Close Position Endpoint
app.post("/api/positions/close", async (req, res) => {
  const { userId = "default", positionId, symbol } = req.body;
  const user = getOrCreateUserAccount(userId);
  const mids = await getLiveMids();

  const idx = user.positions.findIndex(
    (p) => (positionId && p.id === positionId) || (symbol && p.symbol === symbol.toUpperCase())
  );

  if (idx === -1) {
    return res.status(404).json({ error: "Position not found" });
  }

  const pos = user.positions[idx];
  const currentPx = mids[pos.symbol] || pos.markPrice;
  const pnl = pos.side === "LONG"
    ? (currentPx - pos.entryPrice) * pos.size
    : (pos.entryPrice - currentPx) * pos.size;
  const fee = pos.sizeUsd * 0.00035;

  user.balanceUsd += pnl - fee;
  user.positions.splice(idx, 1);

  // Record closing fill
  user.fills.unshift({
    id: `fill-close-${Date.now()}`,
    symbol: pos.symbol,
    side: pos.side === "LONG" ? "SELL" : "BUY",
    dir: `Close ${pos.side}`,
    price: currentPx,
    size: pos.size,
    sizeUsd: pos.sizeUsd,
    feeUsd: Math.round(fee * 100) / 100,
    pnlUsd: Math.round(pnl * 100) / 100,
    timestamp: Date.now(),
  });

  res.json({
    success: true,
    message: `Closed position for ${pos.symbol} with PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    pnlUsd: pnl,
    balanceUsd: user.balanceUsd,
    positions: user.positions,
  });
});

// Reset / Faucet Demo Funds
app.post("/api/faucet/deposit", (req, res) => {
  const { userId = "default", amount = 10000 } = req.body;
  const user = getOrCreateUserAccount(userId);
  user.balanceUsd += amount;
  user.depositedUsd += amount;
  res.json({ success: true, balanceUsd: user.balanceUsd, message: `Added $${amount.toLocaleString()} test funds` });
});


// Hyperliquid direct proxy for public info queries
app.post("/api/hyperliquid/info", async (req, res) => {
  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(6000),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Hyperliquid API unreachable", message: (err as Error).message });
  }
});

// Showcase Agents API
app.get("/api/showcase/agents", async (_req, res) => {
  const mids = await getLiveMids();
  const now = Date.now();

  const btcPrice = mids["BTC"] || 89500;
  const ethPrice = mids["ETH"] || 2540;
  const solPrice = mids["SOL"] || 168.5;
  const hypePrice = mids["HYPE"] || 24.8;
  const suiPrice = mids["SUI"] || 2.85;
  const nvdaPrice = mids["NVDA"] || 138.2;
  const tslaPrice = mids["TSLA"] || 265.4;

  const agents = [
    {
      id: "f2501883-89ef-499b-8ea1-b6b56dd6f024",
      name: "Gemini 3.7 Flash — Alpha Scalper",
      model: "gemini-3.7-flash",
      horizon: "scalper",
      direction: "long_short",
      mandate: "active",
      symbols: ["BTC", "ETH", "SOL", "HYPE", "SUI"],
      maxCapitalUsd: 10000,
      blurb: "High-frequency perp scalper running 1-hour decision cycles with multi-timeframe EMA sweeps and aggressive dynamic take-profits.",
      live: true,
      status: "active",
      pnlFrom1k: 248.60,
      indexedEquity: 1248.60,
      equity: [
        { t: now - 86400000 * 7, indexed: 1000 },
        { t: now - 86400000 * 6, indexed: 1032.40 },
        { t: now - 86400000 * 5, indexed: 1068.10 },
        { t: now - 86400000 * 4, indexed: 1115.80 },
        { t: now - 86400000 * 3, indexed: 1142.20 },
        { t: now - 86400000 * 2, indexed: 1195.50 },
        { t: now - 86400000 * 1, indexed: 1224.00 },
        { t: now, indexed: 1248.60 },
      ],
      positions: [
        {
          symbol: "BTC",
          side: "LONG" as const,
          entry: Math.round((btcPrice * 0.988) * 10) / 10,
          mark: btcPrice,
          sizeUsd: 4250.00,
          unrealizedPnl: Math.round((4250 * (btcPrice - btcPrice * 0.988) / (btcPrice * 0.988)) * 100) / 100,
          unrealizedPct: 6.08,
          leverage: 5,
          marginType: "cross" as const,
          liquidationPx: Math.round(btcPrice * 0.81),
          marginUsed: 850.00,
          fundingUsd: 1.45,
          manual: false,
        },
        {
          symbol: "SOL",
          side: "LONG" as const,
          entry: Math.round((solPrice * 0.975) * 100) / 100,
          mark: solPrice,
          sizeUsd: 2500.00,
          unrealizedPnl: Math.round((2500 * (solPrice - solPrice * 0.975) / (solPrice * 0.975)) * 100) / 100,
          unrealizedPct: 12.82,
          leverage: 5,
          marginType: "cross" as const,
          liquidationPx: Math.round(solPrice * 0.82 * 10) / 10,
          marginUsed: 500.00,
          fundingUsd: 0.82,
          manual: false,
        },
      ],
      openOrders: [
        {
          symbol: "BTC",
          side: "LONG" as const,
          orderSide: "sell" as const,
          kind: "take_profit" as const,
          tpsl: "tp" as const,
          triggerPx: Math.round(btcPrice * 1.035),
          size: 0.0475,
          reduceOnly: true,
          isTrigger: true,
        },
        {
          symbol: "BTC",
          side: "LONG" as const,
          orderSide: "sell" as const,
          kind: "stop" as const,
          tpsl: "sl" as const,
          triggerPx: Math.round(btcPrice * 0.975),
          size: 0.0475,
          reduceOnly: true,
          isTrigger: true,
        },
      ],
      decisions: [
        {
          id: "dec-gemini-01",
          at: new Date(now - 14 * 60 * 1000).toISOString(),
          symbol: "BTC",
          type: "monitor_hold",
          headline: "Hold Long",
          body: `Order flow skew is net +$14.2M over the last 60m with bullish funding rate compression. 1h EMA 20 holding above EMA 50. Maintaining active Long with $${Math.round(btcPrice * 1.035)} TP target.`,
          reasoning: "Funding rate 0.0012%/hr, RSI 58.4, 4h trend bullish, delta cumulative positive.",
          tone: "positive" as const,
          conviction: 88,
          direction: "LONG" as const,
          pnlPct: 6.08,
        },
        {
          id: "dec-gemini-02",
          at: new Date(now - 74 * 60 * 1000).toISOString(),
          symbol: "SOL",
          type: "opening_long",
          headline: "Opened Long",
          body: `Breakout confirmation above key consolidation range ($${Math.round(solPrice * 0.98)}). Strong spot bid absorption on Hyperliquid order book.`,
          reasoning: "Relative strength vs BTC index at +1.8%, breakout volume 2.3x 24h average.",
          tone: "positive" as const,
          conviction: 92,
          direction: "LONG" as const,
          pnlPct: 12.82,
        },
      ],
      opening: {
        at: new Date(now - 74 * 60 * 1000).toISOString(),
        symbol: "SOL",
        side: "LONG" as const,
        conviction: 92,
        summary: `Breakout confirmation above $${Math.round(solPrice * 0.98)} resistance.`,
        reasoning: "High conviction upside momentum accompanied by positive DEX swap volume and perp delta expansion.",
        entryPrice: Math.round(solPrice * 0.975 * 100) / 100,
        stopPrice: Math.round(solPrice * 0.95 * 100) / 100,
        takeProfit: Math.round(solPrice * 1.05 * 100) / 100,
      },
      closed: [
        {
          symbol: "HYPE",
          side: "LONG" as const,
          orderSide: "sell" as const,
          closePrice: Math.round(hypePrice * 1.04 * 100) / 100,
          size: 80,
          valueUsd: 1984.00,
          feeUsd: 0.79,
          pnlUsd: 82.40,
          closedAt: now - 3600000 * 5,
          ai: true,
          dir: "Close Long",
          reason: "take_profit",
        },
        {
          symbol: "ETH",
          side: "SHORT" as const,
          orderSide: "buy" as const,
          closePrice: Math.round(ethPrice * 0.985),
          size: 0.8,
          valueUsd: 2003.20,
          feeUsd: 0.80,
          pnlUsd: 48.60,
          closedAt: now - 3600000 * 12,
          ai: true,
          dir: "Close Short",
          reason: "take_profit",
        },
      ],
    },
    {
      id: "2369e222-c2c4-447b-aca1-5dc7e30f6cfb",
      name: "Claude Opus 5 — Macro Swing",
      model: "claude-opus-5",
      horizon: "swing",
      direction: "long_only",
      mandate: "active",
      symbols: ["BTC", "ETH", "GOLD", "SOL"],
      maxCapitalUsd: 5000,
      blurb: "Macro thesis swing trader utilizing macroeconomic calendar indicators, ETF inflows, and weekly regression channels.",
      live: true,
      status: "active",
      pnlFrom1k: 184.20,
      indexedEquity: 1184.20,
      equity: [
        { t: now - 86400000 * 7, indexed: 1000 },
        { t: now - 86400000 * 6, indexed: 1018.00 },
        { t: now - 86400000 * 5, indexed: 1045.20 },
        { t: now - 86400000 * 4, indexed: 1072.10 },
        { t: now - 86400000 * 3, indexed: 1110.80 },
        { t: now - 86400000 * 2, indexed: 1145.00 },
        { t: now - 86400000 * 1, indexed: 1168.30 },
        { t: now, indexed: 1184.20 },
      ],
      positions: [
        {
          symbol: "ETH",
          side: "LONG" as const,
          entry: Math.round(ethPrice * 0.98),
          mark: ethPrice,
          sizeUsd: 3200.00,
          unrealizedPnl: Math.round((3200 * (ethPrice - ethPrice * 0.98) / (ethPrice * 0.98)) * 100) / 100,
          unrealizedPct: 6.12,
          leverage: 3,
          marginType: "cross" as const,
          liquidationPx: Math.round(ethPrice * 0.68),
          marginUsed: 1066.67,
          fundingUsd: 3.20,
          manual: false,
        },
      ],
      openOrders: [
        {
          symbol: "ETH",
          side: "LONG" as const,
          orderSide: "sell" as const,
          kind: "take_profit" as const,
          tpsl: "tp" as const,
          triggerPx: Math.round(ethPrice * 1.08),
          size: 1.25,
          reduceOnly: true,
          isTrigger: true,
        },
      ],
      decisions: [
        {
          id: "dec-claude-01",
          at: new Date(now - 32 * 60 * 1000).toISOString(),
          symbol: "ETH",
          type: "monitor_hold",
          headline: "Hold Long",
          body: "Institutional ETF flow metrics remain net positive (+$48M day-over-day). Ethereum supply on exchanges hitting multi-year lows. Holding swing exposure with patient target.",
          reasoning: "Weekly MACD histogram expanding positive, low leverage cross margin structure safe.",
          tone: "positive" as const,
          conviction: 85,
          direction: "LONG" as const,
          pnlPct: 6.12,
        },
      ],
      opening: null,
      closed: [
        {
          symbol: "BTC",
          side: "LONG" as const,
          orderSide: "sell" as const,
          closePrice: Math.round(btcPrice * 1.03),
          size: 0.05,
          valueUsd: 4610.00,
          feeUsd: 1.84,
          pnlUsd: 135.50,
          closedAt: now - 3600000 * 28,
          ai: true,
          dir: "Close Long",
          reason: "take_profit",
        },
      ],
    },
    {
      id: "fd6a5783-d0ce-4bf5-8214-aa166eb739f4",
      name: "DeepSeek V4 Flash — Momentum Scalper",
      model: "deepseek-v4-flash",
      horizon: "scalper",
      direction: "long_short",
      mandate: "active",
      symbols: ["BTC", "SOL", "NVDA", "TSLA"],
      maxCapitalUsd: 2500,
      blurb: "Momentum and volatility expansion engine targeting rapid intraday mean-reversions and trend breakouts on HIP-3 equities and crypto perps.",
      live: true,
      status: "active",
      pnlFrom1k: 132.80,
      indexedEquity: 1132.80,
      equity: [
        { t: now - 86400000 * 7, indexed: 1000 },
        { t: now - 86400000 * 6, indexed: 985.20 },
        { t: now - 86400000 * 5, indexed: 1022.40 },
        { t: now - 86400000 * 4, indexed: 1060.00 },
        { t: now - 86400000 * 3, indexed: 1094.60 },
        { t: now - 86400000 * 2, indexed: 1082.00 },
        { t: now - 86400000 * 1, indexed: 1115.40 },
        { t: now, indexed: 1132.80 },
      ],
      positions: [
        {
          symbol: "NVDA",
          side: "LONG" as const,
          entry: Math.round(nvdaPrice * 0.985 * 100) / 100,
          mark: nvdaPrice,
          sizeUsd: 1500.00,
          unrealizedPnl: Math.round((1500 * (nvdaPrice - nvdaPrice * 0.985) / (nvdaPrice * 0.985)) * 100) / 100,
          unrealizedPct: 7.61,
          leverage: 5,
          marginType: "isolated" as const,
          liquidationPx: Math.round(nvdaPrice * 0.81 * 100) / 100,
          marginUsed: 300.00,
          fundingUsd: 0.40,
          manual: false,
        },
      ],
      openOrders: [
        {
          symbol: "NVDA",
          side: "LONG" as const,
          orderSide: "sell" as const,
          kind: "take_profit" as const,
          tpsl: "tp" as const,
          triggerPx: Math.round(nvdaPrice * 1.04 * 100) / 100,
          size: 11,
          reduceOnly: true,
          isTrigger: true,
        },
      ],
      decisions: [
        {
          id: "dec-deepseek-01",
          at: new Date(now - 22 * 60 * 1000).toISOString(),
          symbol: "NVDA",
          type: "monitor_hold",
          headline: "Hold Long",
          body: "Semiconductor sector breadth +2.4% leading the equity session. Open interest climbing with positive CVD delta.",
          reasoning: "AI hardware demand catalysts intact, 15m VWAP holding firmly above $136.5.",
          tone: "positive" as const,
          conviction: 82,
          direction: "LONG" as const,
          pnlPct: 7.61,
        },
      ],
      opening: null,
      closed: [
        {
          symbol: "TSLA",
          side: "SHORT" as const,
          orderSide: "buy" as const,
          closePrice: Math.round(tslaPrice * 0.975 * 100) / 100,
          size: 6,
          valueUsd: 1550.00,
          feeUsd: 0.62,
          pnlUsd: 38.75,
          closedAt: now - 3600000 * 9,
          ai: true,
          dir: "Close Short",
          reason: "take_profit",
        },
      ],
    },
    {
      id: "682a3cea-0574-47dd-82c1-76d914c4597a",
      name: "Grok 4.5 — Sentiment Momentum",
      model: "grok-4.5",
      horizon: "scalper",
      direction: "long_short",
      mandate: "active",
      symbols: ["HYPE", "SUI", "BTC"],
      maxCapitalUsd: 1000,
      blurb: "Social sentiment aggregation combined with real-time liquidations order book tracking on Hyperliquid native tokens.",
      live: true,
      status: "active",
      pnlFrom1k: 96.40,
      indexedEquity: 1096.40,
      equity: [
        { t: now - 86400000 * 7, indexed: 1000 },
        { t: now - 86400000 * 6, indexed: 1012.00 },
        { t: now - 86400000 * 5, indexed: 1034.50 },
        { t: now - 86400000 * 4, indexed: 1020.10 },
        { t: now - 86400000 * 3, indexed: 1058.90 },
        { t: now - 86400000 * 2, indexed: 1075.30 },
        { t: now - 86400000 * 1, indexed: 1088.00 },
        { t: now, indexed: 1096.40 },
      ],
      positions: [
        {
          symbol: "SUI",
          side: "LONG" as const,
          entry: Math.round(suiPrice * 0.98 * 1000) / 1000,
          mark: suiPrice,
          sizeUsd: 800.00,
          unrealizedPnl: Math.round((800 * (suiPrice - suiPrice * 0.98) / (suiPrice * 0.98)) * 100) / 100,
          unrealizedPct: 10.20,
          leverage: 5,
          marginType: "cross" as const,
          liquidationPx: Math.round(suiPrice * 0.8 * 100) / 100,
          marginUsed: 160.00,
          fundingUsd: 0.18,
          manual: false,
        },
      ],
      openOrders: [],
      decisions: [
        {
          id: "dec-grok-01",
          at: new Date(now - 48 * 60 * 1000).toISOString(),
          symbol: "SUI",
          type: "monitor_hold",
          headline: "Hold Long",
          body: "High ecosystem TVL growth metrics and positive social velocity. Volume profile shows strong support at $2.75.",
          reasoning: "Sentiment score 86/100, funding low neutral.",
          tone: "positive" as const,
          conviction: 80,
          direction: "LONG" as const,
          pnlPct: 10.20,
        },
      ],
      opening: null,
      closed: [],
    },
    {
      id: "282b73a1-1a6d-447c-bf8a-4d4803e41ccf",
      name: "GPT-5.6 Terra — Funding Carry",
      model: "gpt-5.6-terra",
      horizon: "investor",
      direction: "long_only",
      mandate: "accumulate",
      symbols: ["BTC", "ETH", "SOL"],
      maxCapitalUsd: 2000,
      blurb: "Funding carry and spot-perp basis harvester accumulating high quality assets on extreme fear intervals.",
      live: true,
      status: "active",
      pnlFrom1k: 78.50,
      indexedEquity: 1078.50,
      equity: [
        { t: now - 86400000 * 7, indexed: 1000 },
        { t: now - 86400000 * 6, indexed: 1010.00 },
        { t: now - 86400000 * 5, indexed: 1024.00 },
        { t: now - 86400000 * 4, indexed: 1038.50 },
        { t: now - 86400000 * 3, indexed: 1051.20 },
        { t: now - 86400000 * 2, indexed: 1065.00 },
        { t: now - 86400000 * 1, indexed: 1072.00 },
        { t: now, indexed: 1078.50 },
      ],
      positions: [],
      openOrders: [],
      decisions: [
        {
          id: "dec-gpt-01",
          at: new Date(now - 120 * 60 * 1000).toISOString(),
          symbol: "BTC",
          type: "skipped_cooldown",
          headline: "Waiting for Dip",
          body: "Market currently in local expansion range above 4h upper Bollinger band. Awaiting healthy retracement to accumulation zone.",
          reasoning: "Investor horizon rebalances strictly on EMA 50 touch or negative funding opportunities.",
          tone: "warn" as const,
          conviction: 75,
          direction: null,
          pnlPct: null,
        },
      ],
      opening: null,
      closed: [],
    },
  ];

  res.json({
    agents,
    generatedAt: now,
  });
});

async function startServer() {
  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HyperTrade web application listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
