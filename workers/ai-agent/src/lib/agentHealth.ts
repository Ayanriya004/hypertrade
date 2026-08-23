/**
 * Pure fallback health tracking for AI agents.
 *
 * Never mutates agent `status`. Never auto-stops. Only updates the `health`
 * jsonb so the UI can show a degraded hint after sustained outages — not
 * single-cycle blips or in-flight retries.
 */
import { getSupabase } from './supabase.js';

/** Consecutive fully-blocked data cycles before degraded (hourly ≈ 3h). */
export const MARKET_DATA_STREAK_TO_DEGRADE = 3;
/** Consecutive cycles where every decide attempt errored (had data). */
export const LLM_ERROR_STREAK_TO_DEGRADE = 4;
/** Consecutive cycles with intended exit/cut/flip-close failing after adapter retries. */
export const EXIT_FAIL_STREAK_TO_DEGRADE = 3;
/** Min hours between degraded push alerts for the same agent. */
export const ALERT_DEDUP_HOURS = 24;

export type HealthReason =
  | 'market_data_unavailable'
  | 'llm_errors'
  | 'exit_retrying';

export interface AgentHealth {
  degraded: boolean;
  reasons: HealthReason[];
  marketDataBadStreak: number;
  llmErrorStreak: number;
  exitFailStreak: number;
  lastOkAt: string | null;
  since: string | null;
  lastAlertAt: string | null;
  /** Set on the degraded→healthy transition; cleared when degrading again. */
  recoveredAt: string | null;
  updatedAt: string;
}

/** Per-cycle counters collected by the monitor (additive; never throws). */
export interface CycleHealthSignals {
  symbolsConfigured: number;
  /** Skipped before any decide (CoinGlass / entitlement / no bar). */
  noData: number;
  /** Completed a decide path (incl. intentional flats/skips with data). */
  decideOk: number;
  /** LLM/network decide failure after data was available. */
  decideError: number;
  /** Intended exit/cut/flip-close failed after adapter retries. */
  exitFail: number;
  /** Intended exit/cut succeeded (or flip close succeeded). */
  exitOk: number;
  /** Whole executeAgentMonitoring threw (decrypt / HL bundle, etc.). */
  runFatal?: boolean;
}

export function emptySignals(symbolsConfigured: number): CycleHealthSignals {
  return {
    symbolsConfigured,
    noData: 0,
    decideOk: 0,
    decideError: 0,
    exitFail: 0,
    exitOk: 0,
  };
}

export function parseHealth(raw: unknown): AgentHealth {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const reasons = Array.isArray(o.reasons)
    ? (o.reasons.filter((r) => typeof r === 'string') as HealthReason[])
    : [];
  return {
    degraded: o.degraded === true,
    reasons,
    marketDataBadStreak: num(o.marketDataBadStreak),
    llmErrorStreak: num(o.llmErrorStreak),
    exitFailStreak: num(o.exitFailStreak),
    lastOkAt: typeof o.lastOkAt === 'string' ? o.lastOkAt : null,
    since: typeof o.since === 'string' ? o.since : null,
    lastAlertAt: typeof o.lastAlertAt === 'string' ? o.lastAlertAt : null,
    recoveredAt: typeof o.recoveredAt === 'string' ? o.recoveredAt : null,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date(0).toISOString(),
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Merge one cycle's signals into prior health.
 * Conservative: a cycle only advances a streak when that failure mode is
 * unambiguous for the whole cycle (not "some symbols ok, some not").
 */
export function mergeCycleHealth(
  prevRaw: unknown,
  signals: CycleHealthSignals,
  now = new Date(),
): { health: AgentHealth; becameDegraded: boolean; becameRecovered: boolean } {
  const prev = parseHealth(prevRaw);
  const nowIso = now.toISOString();
  const configured = Math.max(0, signals.symbolsConfigured);

  // Fully decide-blocked by data: every configured symbol hit no-data, and we
  // never reached a decide path. Empty symbol list → ignore (misconfig).
  const marketDataFullyBlocked =
    configured > 0 &&
    signals.noData >= configured &&
    signals.decideOk === 0 &&
    signals.decideError === 0 &&
    !signals.runFatal;

  // Had data and attempted decides, but every attempt errored (no ok).
  const llmFullyBlocked =
    signals.decideError > 0 &&
    signals.decideOk === 0 &&
    !marketDataFullyBlocked;

  const exitAttempted = signals.exitFail + signals.exitOk > 0;
  const exitFullyFailed = exitAttempted && signals.exitOk === 0 && signals.exitFail > 0;

  const marketDataBadStreak = marketDataFullyBlocked
    ? prev.marketDataBadStreak + 1
    : signals.decideOk > 0 || signals.decideError > 0
      ? 0
      : prev.marketDataBadStreak; // inconclusive (e.g. runFatal) — don't reset or bump

  const llmErrorStreak = llmFullyBlocked
    ? prev.llmErrorStreak + 1
    : signals.decideOk > 0
      ? 0
      : prev.llmErrorStreak;

  // Exit streak is consecutive exit-attempt cycles only. A cycle that
  // successfully decided and did not fail an exit (e.g. hold) clears it —
  // sparse failures weeks apart must not accumulate into "degraded".
  const exitFailStreak = exitFullyFailed
    ? prev.exitFailStreak + 1
    : signals.exitOk > 0 || (signals.decideOk > 0 && !exitAttempted)
      ? 0
      : prev.exitFailStreak;

  const reasons: HealthReason[] = [];
  if (marketDataBadStreak >= MARKET_DATA_STREAK_TO_DEGRADE) {
    reasons.push('market_data_unavailable');
  }
  if (llmErrorStreak >= LLM_ERROR_STREAK_TO_DEGRADE) {
    reasons.push('llm_errors');
  }
  if (exitFailStreak >= EXIT_FAIL_STREAK_TO_DEGRADE) {
    reasons.push('exit_retrying');
  }

  const degraded = reasons.length > 0;
  const becameDegraded = degraded && !prev.degraded;
  const becameRecovered = !degraded && prev.degraded;

  let lastOkAt = prev.lastOkAt;
  if (signals.decideOk > 0 || signals.exitOk > 0) {
    lastOkAt = nowIso;
  }

  let since = prev.since;
  if (degraded) {
    since = prev.degraded && prev.since ? prev.since : nowIso;
  } else {
    since = null;
  }

  // recoveredAt marks the last degraded→healthy transition (UI "recovered
  // at" hint + recovery push); a new degradation clears it.
  const recoveredAt = degraded
    ? null
    : becameRecovered
      ? nowIso
      : prev.recoveredAt;

  return {
    health: {
      degraded,
      reasons,
      marketDataBadStreak,
      llmErrorStreak,
      exitFailStreak,
      lastOkAt,
      since,
      lastAlertAt: prev.lastAlertAt,
      recoveredAt,
      updatedAt: nowIso,
    },
    becameDegraded,
    becameRecovered,
  };
}

export async function persistAgentHealth(
  agentId: string,
  health: AgentHealth,
): Promise<void> {
  const { error } = await getSupabase()
    .from('ai_agents')
    .update({ health })
    .eq('id', agentId);
  if (error) {
    console.warn(`[health] persist failed for ${agentId}:`, error.message);
  }
}

/**
 * Best-effort Expo push for health transitions. Never throws; never changes
 * agent status. Alert policy:
 *   • degraded transition → alert (deduped by lastAlertAt vs ALERT_DEDUP_HOURS
 *     so a degrade→recover→degrade flap within a day doesn't double-ping)
 *   • STILL degraded with `exit_retrying` → RE-alert daily: the agent wants
 *     out of a position and can't get out — funds actively at stake, silence
 *     is the wrong default. Other reasons stay transition-only.
 *   • recovered transition → "back to normal" push, only if we alerted about
 *     the incident (lastAlertAt set) — never announce recoveries from
 *     degradations the user was never told about.
 */
export async function maybeAlertDegraded(args: {
  privyUserId: string;
  agentId: string;
  agentName: string;
  health: AgentHealth;
  becameDegraded: boolean;
  becameRecovered: boolean;
}): Promise<AgentHealth> {
  const last = args.health.lastAlertAt
    ? Date.parse(args.health.lastAlertAt)
    : 0;
  const alertedRecently =
    Number.isFinite(last) && last > 0 && Date.now() - last < ALERT_DEDUP_HOURS * 3600_000;

  // Recovery: one push, no dedup window needed (guarded by the transition
  // itself + the "did we alert about THIS incident" heuristic — an alert in
  // the last 7 days; lastAlertAt from months-old incidents doesn't count).
  if (args.becameRecovered && !args.health.degraded) {
    if (last > 0 && Date.now() - last < 7 * 24 * 3600_000) {
      await sendHealthPush({
        privyUserId: args.privyUserId,
        title: 'AI agent recovered',
        body: `${args.agentName} is back to normal operation.`,
        data: { type: 'ai_agent_recovered', agentId: args.agentId },
      });
    }
    return args.health;
  }

  if (!args.health.degraded) return args.health;

  const reason = args.health.reasons[0] ?? 'market_data_unavailable';
  const stuckExit = args.health.reasons.includes('exit_retrying');
  // Transition alerts for everything; daily RE-alerts only while an exit is
  // stuck (see policy above).
  const shouldAlert =
    (args.becameDegraded && !alertedRecently) || (stuckExit && !alertedRecently);
  if (!shouldAlert) return args.health;

  const body =
    reason === 'exit_retrying' || stuckExit
      ? `${args.agentName} couldn’t close a position after several tries — it’s still retrying; check Hyperliquid.`
      : reason === 'llm_errors'
        ? `${args.agentName} couldn’t reach its AI model for several hours — existing positions keep their stops; will retry.`
        : `${args.agentName} couldn’t load market data for several hours — existing positions keep their stops; will retry.`;

  await sendHealthPush({
    privyUserId: args.privyUserId,
    title: 'AI agent needs attention',
    body,
    data: { type: 'ai_agent_degraded', agentId: args.agentId, reason },
  });

  return {
    ...args.health,
    lastAlertAt: new Date().toISOString(),
  };
}

/** Best-effort Expo push to all of a user's registered tokens. Never throws. */
async function sendHealthPush(args: {
  privyUserId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  try {
    const { data: tokens } = await getSupabase()
      .from('push_tokens')
      .select('push_token')
      .eq('user_id', args.privyUserId)
      .limit(20);
    const list = (tokens ?? [])
      .map((t) => t.push_token as string)
      .filter(Boolean);
    if (!list.length) return;

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        list.map((to) => ({
          to,
          title: args.title,
          body: args.body,
          data: args.data,
          sound: 'default',
        })),
      ),
    }).catch(() => null);
  } catch (err) {
    console.warn('[health] push alert failed:', err);
  }
}
