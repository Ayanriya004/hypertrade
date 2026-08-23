/** Format a decimal exchange-rate string for display. */
export function formatExchangeRateValue(raw: string | undefined): string {
  if (!raw) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

/** Build "1 FROM ≈ RATE TO", optionally inverted (1 TO ≈ 1/RATE FROM). */
export function buildExchangeRateLine(opts: {
  from: string;
  to: string;
  rate: string | undefined;
  inverted?: boolean;
}): string {
  const { from, to, rate, inverted } = opts;
  if (!rate) return '—';
  if (inverted) {
    const n = Number(rate);
    if (!Number.isFinite(n) || n <= 0) return `1 ${to} ≈ — ${from}`;
    return `1 ${to} ≈ ${formatExchangeRateValue(String(1 / n))} ${from}`;
  }
  return `1 ${from} ≈ ${formatExchangeRateValue(rate)} ${to}`;
}
