/** Catmull-Rom → cubic bezier SVG path (visual smoothness only). */
export function smoothLinePath(
  coords: Array<{ x: number; y: number }>,
  digits = 1,
): string {
  if (coords.length === 0) return '';
  const f = (n: number) => n.toFixed(digits);
  if (coords.length === 1) return `M${f(coords[0].x)},${f(coords[0].y)}`;
  if (coords.length === 2) {
    return `M${f(coords[0].x)},${f(coords[0].y)} L${f(coords[1].x)},${f(coords[1].y)}`;
  }
  let d = `M${f(coords[0].x)},${f(coords[0].y)}`;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const p0 = coords[i === 0 ? 0 : i - 1];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${f(cp1x)},${f(cp1y)} ${f(cp2x)},${f(cp2y)} ${f(p2.x)},${f(p2.y)}`;
  }
  return d;
}
