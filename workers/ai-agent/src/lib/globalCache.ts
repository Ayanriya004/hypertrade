/**
 * Global context cache — Supabase-backed, shared across ALL agents and worker
 * restarts. For data that is identical for every agent and expensive or
 * rate-limited to fetch (Deribit DVOL today; macro-calendar / rates events
 * later). Each key sets its own TTL, so fast-moving context (DVOL) refreshes
 * often while slow context (economic calendar) can refresh every 12h+.
 *
 * Intentionally minimal — this is foundational plumbing, not brain logic.
 */
import { getSupabase } from './supabase.js';

/**
 * Return a fresh cached value for `key`, or produce + persist a new one.
 * On producer failure, serves the last stale value if present (better stale
 * than nothing), else null. Values must be JSON-serializable (jsonb).
 */
export async function getOrRefreshGlobalContext<T>(args: {
  key: string;
  ttlMs: number;
  /** Optional per-value TTL (e.g. shorter when a series is still missing). */
  ttlMsForValue?: (value: T) => number;
  produce: () => Promise<T>;
}): Promise<T | null> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('global_context_cache')
    .select('value, expires_at')
    .eq('key', args.key)
    .maybeSingle();

  if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
    return existing.value as T;
  }

  try {
    const fresh = await args.produce();
    const now = Date.now();
    const ttl = Math.max(1_000, args.ttlMsForValue?.(fresh) ?? args.ttlMs);
    await supabase.from('global_context_cache').upsert({
      key: args.key,
      value: fresh as unknown as Record<string, unknown>,
      refreshed_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl).toISOString(),
    });
    return fresh;
  } catch (err) {
    console.error(`[globalCache] refresh failed for "${args.key}":`, err instanceof Error ? err.message : err);
    return existing ? (existing.value as T) : null;
  }
}

/** Plain read (fresh values only) — for write-through state, not produce/TTL. */
export async function readGlobalContext<T>(key: string): Promise<T | null> {
  try {
    const { data } = await getSupabase()
      .from('global_context_cache')
      .select('value, expires_at')
      .eq('key', key)
      .maybeSingle();
    if (!data || new Date(data.expires_at).getTime() <= Date.now()) return null;
    return data.value as T;
  } catch (err) {
    console.warn(`[globalCache] read failed for "${key}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Plain read ignoring TTL — for diffing against an expired prior board. */
export async function readGlobalContextAny<T>(key: string): Promise<T | null> {
  try {
    const { data } = await getSupabase()
      .from('global_context_cache')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    return data ? (data.value as T) : null;
  } catch (err) {
    console.warn(`[globalCache] readAny failed for "${key}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Plain upsert — best-effort, never throws. */
export async function writeGlobalContext(
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  try {
    const now = Date.now();
    await getSupabase().from('global_context_cache').upsert({
      key,
      value: value as Record<string, unknown>,
      refreshed_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(),
    });
  } catch (err) {
    console.warn(`[globalCache] write failed for "${key}":`, err instanceof Error ? err.message : err);
  }
}
