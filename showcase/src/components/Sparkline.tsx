import type { EquityPoint } from '../api';
import { smoothLinePath } from '../lib/smoothPath';

type Props = {
  points: EquityPoint[];
  width?: number;
  height?: number;
};

/** Drop interior flat samples so Catmull-Rom doesn't overshoot a long baseline. */
function collapseInteriorPlateaus(points: EquityPoint[]): EquityPoint[] {
  if (points.length < 4) return points;
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const out: EquityPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    if (eq(cur.indexed, prev.indexed) && eq(cur.indexed, next.indexed)) continue;
    out.push(cur);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function Sparkline({ points, width = 72, height = 28 }: Props) {
  const series = collapseInteriorPlateaus(points);
  if (series.length < 2) return null;
  const vals = series.map((p) => p.indexed);
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
  // Keep the stroke inside the viewBox — peaks used to clip and look washed out.
  const padX = 3;
  const padY = 4;
  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padY * 2);

  const coords = vals.map((v, i) => {
    const x = padX + (i / (vals.length - 1)) * innerW;
    const y = flat
      ? height / 2
      : padY + (1 - (v - min) / span) * innerH;
    return { x, y };
  });
  const d = smoothLinePath(coords, 2, { yMin: padY, yMax: height - padY });

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
