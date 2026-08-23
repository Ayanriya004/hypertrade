/** Next top-of-hour — matches the ai-agent worker cycle boundary. */
export function msUntilNextHourlyCycle(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return Math.max(0, d.getTime() - nowMs);
}

/** Compact countdown (`m:ss` or `h:mm:ss`). */
export function formatCycleCountdown(msLeft: number): string {
  const totalSec = Math.floor(msLeft / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
