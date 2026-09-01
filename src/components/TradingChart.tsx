import React, { useEffect, useState, useRef, useMemo } from "react";
import { BarChart3, LineChart, Maximize2, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import type { Candle } from "../types";

interface TradingChartProps {
  symbol: string;
  markPrice: number;
}

export const TradingChart: React.FC<TradingChartProps> = ({ symbol, markPrice }) => {
  const [interval, setInterval] = useState<string>("15m");
  const [chartType, setChartType] = useState<"candle" | "area">("candle");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 420 });

  // Handle Container Resize
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: Math.max(300, entry.contentRect.width),
          height: Math.max(260, entry.contentRect.height),
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Fetch Candles
  const loadCandles = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/candles/${symbol}?interval=${interval}&limit=90`);
      const data = await res.json();
      if (data && Array.isArray(data.candles)) {
        setCandles(data.candles);
      }
    } catch (err) {
      console.error("Candle fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCandles();
    const intervalTimer = window.setInterval(loadCandles, 10000);
    return () => window.clearInterval(intervalTimer);
  }, [symbol, interval]);

  // Update latest candle with live mark price
  useEffect(() => {
    if (candles.length === 0 || !markPrice) return;
    setCandles((prev) => {
      if (prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1] };
      last.c = markPrice;
      last.h = Math.max(last.h, markPrice);
      last.l = Math.min(last.l, markPrice);
      return [...prev.slice(0, prev.length - 1), last];
    });
  }, [markPrice]);

  // Chart bounds and calculations
  const { minPx, maxPx, maxVol, priceRange } = useMemo(() => {
    if (candles.length === 0) return { minPx: 0, maxPx: 100, maxVol: 100, priceRange: 100 };
    let min = Infinity;
    let max = -Infinity;
    let mv = 0;
    candles.forEach((c) => {
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
      if (c.v > mv) mv = c.v;
    });
    const padding = (max - min) * 0.08 || max * 0.02 || 1;
    return {
      minPx: min - padding,
      maxPx: max + padding,
      maxVol: mv || 1,
      priceRange: max - min + padding * 2 || 1,
    };
  }, [candles]);

  const chartHeight = dimensions.height - 40; // reserved 40px for X-axis timestamps
  const volHeight = 65; // bottom volume area
  const mainChartHeight = chartHeight - volHeight;
  const paddingRight = 75; // price scale width
  const plotWidth = dimensions.width - paddingRight;

  const candleWidth = Math.max(3, Math.min(18, (plotWidth / Math.max(candles.length, 1)) * 0.75));
  const candleGap = plotWidth / Math.max(candles.length, 1);

  const getY = (price: number) => {
    return mainChartHeight - ((price - minPx) / priceRange) * mainChartHeight;
  };

  const getVolY = (vol: number) => {
    return chartHeight - (vol / maxVol) * volHeight;
  };

  const activeCandle = hoveredCandle || candles[candles.length - 1];

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] select-none">
      {/* Chart Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-3 py-2 border-b border-[#1b2433] bg-[#0c1017] text-xs gap-2">
        {/* Timeframe Selectors */}
        <div className="flex items-center gap-1">
          {["1m", "5m", "15m", "1h", "4h", "1d"].map((tf) => (
            <button
              key={tf}
              id={`tf-btn-${tf}`}
              onClick={() => setInterval(tf)}
              className={`px-2.5 py-1 rounded font-mono font-bold transition-all ${
                interval === tf
                  ? "bg-cyan-500 text-black shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-[#182232]"
              }`}
            >
              {tf.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Chart Style & Refresh */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-[#151d2a] p-0.5 rounded-lg border border-[#243247]">
            <button
              onClick={() => setChartType("candle")}
              className={`p-1.5 rounded ${
                chartType === "candle" ? "bg-cyan-500/20 text-cyan-400" : "text-slate-400 hover:text-slate-200"
              }`}
              title="Candlestick"
            >
              <BarChart3 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setChartType("area")}
              className={`p-1.5 rounded ${
                chartType === "area" ? "bg-cyan-500/20 text-cyan-400" : "text-slate-400 hover:text-slate-200"
              }`}
              title="Area Line"
            >
              <LineChart className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={loadCandles}
            className="p-1.5 rounded-lg bg-[#151d2a] border border-[#243247] text-slate-400 hover:text-slate-200"
            title="Refresh Data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-cyan-400" : ""}`} />
          </button>
        </div>
      </div>

      {/* Candle HUD Stats */}
      {activeCandle && (
        <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-[11px] font-mono bg-[#0c1017]/80 border-b border-[#1b2433] text-slate-400">
          <div>
            <span className="text-slate-500">O:</span>{" "}
            <span className="text-slate-200">${activeCandle.o.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-500">H:</span>{" "}
            <span className="text-emerald-400">${activeCandle.h.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-500">L:</span>{" "}
            <span className="text-rose-400">${activeCandle.l.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-500">C:</span>{" "}
            <span
              className={`font-bold ${
                activeCandle.c >= activeCandle.o ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              ${activeCandle.c.toLocaleString()}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Vol:</span>{" "}
            <span className="text-slate-300">{activeCandle.v.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-500">Change:</span>{" "}
            <span
              className={`font-bold ${
                activeCandle.c >= activeCandle.o ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {activeCandle.c >= activeCandle.o ? "+" : ""}
              {(((activeCandle.c - activeCandle.o) / activeCandle.o) * 100).toFixed(2)}%
            </span>
          </div>
        </div>
      )}

      {/* Chart Canvas Area */}
      <div
        ref={containerRef}
        className="relative flex-1 w-full min-h-[300px] overflow-hidden cursor-crosshair"
        onMouseLeave={() => setHoveredCandle(null)}
      >
        <svg width={dimensions.width} height={dimensions.height} className="w-full h-full">
          {/* Horizontal Gridlines & Price Scale */}
          {[0.1, 0.3, 0.5, 0.7, 0.9].map((ratio) => {
            const price = maxPx - ratio * priceRange;
            const y = ratio * mainChartHeight;
            return (
              <g key={ratio}>
                <line
                  x1={0}
                  y1={y}
                  x2={plotWidth}
                  y2={y}
                  stroke="#1c2536"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
                <text
                  x={plotWidth + 8}
                  y={y + 3.5}
                  fill="#64748b"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  ${price.toFixed(price < 10 ? 3 : 2)}
                </text>
              </g>
            );
          })}

          {/* Volume Separator Line */}
          <line
            x1={0}
            y1={mainChartHeight}
            x2={plotWidth}
            y2={mainChartHeight}
            stroke="#1f2937"
            strokeWidth={1}
          />

          {/* Volume Bars */}
          {candles.map((c, i) => {
            const x = i * candleGap + candleGap / 2;
            const y = getVolY(c.v);
            const isBullish = c.c >= c.o;
            return (
              <rect
                key={`vol-${c.t}`}
                x={x - candleWidth / 2}
                y={y}
                width={candleWidth}
                height={chartHeight - y}
                fill={isBullish ? "#10b981" : "#f43f5e"}
                opacity={0.3}
              />
            );
          })}

          {/* Candlesticks or Area Line */}
          {chartType === "candle" ? (
            candles.map((c, i) => {
              const x = i * candleGap + candleGap / 2;
              const isBullish = c.c >= c.o;
              const yOpen = getY(c.o);
              const yClose = getY(c.c);
              const yHigh = getY(c.h);
              const yLow = getY(c.l);
              const bodyTop = Math.min(yOpen, yClose);
              const bodyHeight = Math.max(2, Math.abs(yOpen - yClose));
              const color = isBullish ? "#10b981" : "#f43f5e";

              return (
                <g
                  key={c.t}
                  onMouseEnter={() => setHoveredCandle(c)}
                  className="cursor-pointer"
                >
                  {/* High/Low Wick */}
                  <line
                    x1={x}
                    y1={yHigh}
                    x2={x}
                    y2={yLow}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                  {/* Body */}
                  <rect
                    x={x - candleWidth / 2}
                    y={bodyTop}
                    width={candleWidth}
                    height={bodyHeight}
                    fill={color}
                    rx={1}
                  />
                </g>
              );
            })
          ) : (
            // Area Chart
            <g>
              <defs>
                <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path
                d={
                  candles.reduce((acc, c, i) => {
                    const x = i * candleGap + candleGap / 2;
                    const y = getY(c.c);
                    return `${acc} ${i === 0 ? "M" : "L"} ${x} ${y}`;
                  }, "") + ` L ${(candles.length - 1) * candleGap + candleGap / 2} ${mainChartHeight} L ${candleGap / 2} ${mainChartHeight} Z`
                }
                fill="url(#areaGradient)"
              />
              <path
                d={candles.reduce((acc, c, i) => {
                  const x = i * candleGap + candleGap / 2;
                  const y = getY(c.c);
                  return `${acc} ${i === 0 ? "M" : "L"} ${x} ${y}`;
                }, "")}
                fill="none"
                stroke="#06b6d4"
                strokeWidth={2}
              />
            </g>
          )}

          {/* Current Mark Price Line */}
          {markPrice && (
            <g>
              <line
                x1={0}
                y1={getY(markPrice)}
                x2={plotWidth}
                y2={getY(markPrice)}
                stroke="#06b6d4"
                strokeDasharray="2 2"
                strokeWidth={1.5}
              />
              <rect
                x={plotWidth}
                y={getY(markPrice) - 9}
                width={paddingRight}
                height={18}
                fill="#06b6d4"
                rx={3}
              />
              <text
                x={plotWidth + 6}
                y={getY(markPrice) + 4}
                fill="#000000"
                fontSize="10"
                fontWeight="bold"
                fontFamily="monospace"
              >
                ${markPrice.toFixed(markPrice < 10 ? 3 : 2)}
              </text>
            </g>
          )}

          {/* Time Labels on X-axis */}
          {candles
            .filter((_, i) => i % Math.max(1, Math.floor(candles.length / 6)) === 0)
            .map((c) => {
              const idx = candles.indexOf(c);
              const x = idx * candleGap + candleGap / 2;
              const date = new Date(c.t);
              const timeStr =
                interval === "1d"
                  ? `${date.getMonth() + 1}/${date.getDate()}`
                  : `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
              return (
                <text
                  key={`time-${c.t}`}
                  x={x}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  {timeStr}
                </text>
              );
            })}
        </svg>
      </div>
    </div>
  );
};
