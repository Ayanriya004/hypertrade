import type { AiAgentPosition } from './api';

/**
 * Badge matching is stricter than worker reconcile.
 * Worker uses fills (cloid + flat gap) and can tolerate add/DCA entry drift;
 * the portfolio badge must fail closed between cycles so a same-side manual
 * reopen near the AI entry does not keep the robot icon.
 */
/** ~0.5% — BTC rarely reopens that close by accident after a flatten. */
export const AI_ENTRY_MATCH_TOL = 0.005;
/** Live notional vs tracked size_usd. */
export const AI_SIZE_MATCH_TOL = 0.25;

export function aiEntriesLikelySame(
  trackedEntry: number,
  liveEntry: number,
  tol = AI_ENTRY_MATCH_TOL,
): boolean {
  if (!(trackedEntry > 0 && liveEntry > 0)) return false;
  return Math.abs(liveEntry - trackedEntry) / trackedEntry <= tol;
}

export function aiSizesLikelySame(
  trackedSizeUsd: number,
  liveSizeUsd: number,
  tol = AI_SIZE_MATCH_TOL,
): boolean {
  if (!(trackedSizeUsd > 0 && liveSizeUsd > 0)) return false;
  return Math.abs(liveSizeUsd - trackedSizeUsd) / trackedSizeUsd <= tol;
}

/**
 * Bot badge / Reasoning only (does not close DB rows).
 *
 * Master / Shared: coin + side + entry + size (fail closed). Size mismatch
 * hides the icon after a manual resize/reopen on the shared wallet; worker
 * must not drop tracking on size alone — add/DCA grows notional.
 *
 * Dedicated book (`dedicatedScope`): coin + side only — the whole HL sub is
 * that agent's book, so a manual trade on another symbol must not hide the
 * badge, and entry/size sync lag must not either.
 */
export function findAiPositionForLive(args: {
  aiByCoin: Map<string, AiAgentPosition>;
  coin: string;
  /** HL szi — positive long, negative short. */
  szi: number;
  entryPx: number;
  /** True when PortfolioTabs is scoped to a Dedicated agent book. */
  dedicatedScope?: boolean;
}): AiAgentPosition | undefined {
  const coin = String(args.coin ?? '').toUpperCase();
  if (!coin || !(Math.abs(args.szi) > 0)) return undefined;
  const ai = args.aiByCoin.get(coin);
  if (!ai) return undefined;
  const dir = args.szi > 0 ? 'LONG' : 'SHORT';
  if (ai.direction !== dir) return undefined;

  if (args.dedicatedScope) return ai;

  const tracked = Number(ai.entryPrice);
  const live = Number(args.entryPx);
  if (!(tracked > 0 && live > 0 && Number.isFinite(tracked) && Number.isFinite(live))) {
    return undefined;
  }
  if (!aiEntriesLikelySame(tracked, live)) return undefined;

  const trackedSz = Number(ai.sizeUsd);
  const liveSz = Math.abs(args.szi) * live;
  if (!(trackedSz > 0 && liveSz > 0 && Number.isFinite(trackedSz) && Number.isFinite(liveSz))) {
    return undefined;
  }
  if (!aiSizesLikelySame(trackedSz, liveSz)) return undefined;

  return ai;
}
