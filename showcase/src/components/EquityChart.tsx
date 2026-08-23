import { useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { EquityPoint } from '../api';
import { smoothLinePath } from '../lib/smoothPath';

type Props = {
  points: EquityPoint[];
  height?: number;
};

const BASELINE = 1000;
const VIEW_W = 1000;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function formatSignedUsd(n: number, digits = 2) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}`;
}

function formatHoverTime(t: number) {
  const ms = t < 1e12 ? t * 1000 : t;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function EquityChart({ points, height = 260 }: Props) {
  const gradId = useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { path, area, up, baselineY, coords } = useMemo(() => {
    const vals = points.map((p) => p.indexed);
    const minV = Math.min(...vals, BASELINE);
    const maxV = Math.max(...vals, BASELINE);
    const pad = Math.max((maxV - minV) * 0.08, 8);
    const lo = minV - pad;
    const hi = maxV + pad;
    const h = height;
    const n = points.length;
    const xy = points.map((p, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * VIEW_W;
      const y = h - ((p.indexed - lo) / (hi - lo || 1)) * h;
      return { x, y, indexed: p.indexed, t: p.t };
    });
    const line = smoothLinePath(xy);
    const areaPath = `${line} L${VIEW_W},${h} L0,${h} Z`;
    const last = vals[vals.length - 1] ?? BASELINE;
    const by = hi === lo ? h / 2 : h - ((BASELINE - lo) / (hi - lo)) * h;
    return {
      path: line,
      area: areaPath,
      up: last >= BASELINE,
      baselineY: by,
      coords: xy,
    };
  }, [points, height]);

  const stroke = up ? '#10B981' : '#F43F5E';
  const lastIdx = Math.max(0, coords.length - 1);
  const activeIdx = hoverIdx ?? lastIdx;
  const active = coords[activeIdx];
  const hovering = hoverIdx != null;

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (coords.length < 2 || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const xPct = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    setHoverIdx(Math.round(xPct * (coords.length - 1)));
  };

  if (!active || points.length === 0) {
    return (
      <div className="chart-wrap" style={{ height }}>
        <div className="chart-stage">
          <div className="chart-empty">No equity history yet</div>
        </div>
      </div>
    );
  }

  const leftPct = (active.x / VIEW_W) * 100;
  const topPct = (active.y / height) * 100;
  const pnl = active.indexed - BASELINE;
  const tooltipOnLeft = leftPct > 68;

  return (
    <div className="chart-wrap" style={{ height }}>
      <div
        className="chart-stage"
        ref={wrapRef}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIdx(null)}
        onPointerDown={onPointerMove}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Equity curve indexed to $1000 starting capital"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1="0"
              x2={VIEW_W}
              y1={height * f}
              y2={height * f}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth="1"
            />
          ))}
          <line
            x1="0"
            x2={VIEW_W}
            y1={baselineY}
            y2={baselineY}
            stroke="rgba(92,225,230,0.45)"
            strokeWidth="1"
            strokeDasharray="4 6"
          />
          <path d={area} fill={`url(#${gradId})`} />
          <path
            d={path}
            fill="none"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* HTML label — SVG text stretches under preserveAspectRatio="none". */}
        <div
          className="chart-baseline-label"
          style={{
            top: `${clamp((baselineY / height) * 100, 4, 92)}%`,
          }}
        >
          baseline $1,000
        </div>

        {hovering ? <div className="chart-crosshair" style={{ left: `${leftPct}%` }} /> : null}

        <div
          className={`chart-dot${hovering ? ' is-hover' : ' is-live'}`}
          style={{
            left: `${leftPct}%`,
            top: `${topPct}%`,
            borderColor: stroke,
            color: stroke,
          }}
        />

        {hovering ? (
          <div
            className={`chart-tooltip${tooltipOnLeft ? ' flip' : ''}`}
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
          >
            <div className={`chart-tooltip-pnl ${pnl >= 0 ? 'up' : 'down'}`}>
              {formatSignedUsd(pnl, 2)}
            </div>
            <div className="chart-tooltip-eq">
              $
              {active.indexed.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}{' '}
              indexed
            </div>
            {active.t ? (
              <div className="chart-tooltip-time">{formatHoverTime(active.t)}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
