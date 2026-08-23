import { useEffect, useRef, useState } from 'react';

/** Next top-of-hour in the user's locale — matches worker cycle boundaries. */
export function formatNextHourlyCycle(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function msUntilNextHourlyCycle(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return Math.max(0, d.getTime() - nowMs);
}

/** Compact countdown to the next worker hourly cycle (`m:ss` or `h:mm:ss`). */
export function formatCycleCountdown(msLeft: number): string {
  const totalSec = Math.floor(msLeft / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Shared 1s tick toward the next hourly agent cycle. */
export function useNextCycleCountdown(onCycleRollover?: () => void): string {
  const [label, setLabel] = useState(() => formatCycleCountdown(msUntilNextHourlyCycle()));
  const onRolloverRef = useRef(onCycleRollover);
  onRolloverRef.current = onCycleRollover;
  const prevMsRef = useRef(msUntilNextHourlyCycle());
  useEffect(() => {
    const tick = () => {
      const ms = msUntilNextHourlyCycle();
      // Crossed the hour: previous tick was near zero, now back near a full hour.
      if (prevMsRef.current < 2_000 && ms > 3_500_000) {
        onRolloverRef.current?.();
      }
      prevMsRef.current = ms;
      setLabel(formatCycleCountdown(ms));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return label;
}
