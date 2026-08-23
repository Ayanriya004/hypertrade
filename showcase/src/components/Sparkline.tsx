import type { EquityPoint } from '../api';
import { smoothLinePath } from '../lib/smoothPath';

type Props = {
  points: EquityPoint[];
  width?: number;
  height?: number;
};

export function Sparkline({ points, width = 72, height = 28 }: Props) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.indexed);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min;
  // Flat series: draw through vertical mid — using a fake span parks the line at the bottom.
  const flat = !(range > 1e-9);
  const span = flat ? 1 : range;
  const last = vals[vals.length - 1];
  const first = vals[0];
  const up = last >= first;
  const color = flat ? '#707080' : up ? '#10B981' : '#F43F5E';
  const padY = 2;
  const midY = height / 2;

  const coords = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * width;
    const y = flat
      ? midY
      : height - padY / 2 - ((v - min) / span) * (height - padY);
    return { x, y };
  });
  const d = smoothLinePath(coords, 2);

  return (
    <svg
      className="chip-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
