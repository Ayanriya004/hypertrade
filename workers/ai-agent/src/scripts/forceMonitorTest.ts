/**
 * One-shot force-monitor test for a single agent.
 *
 * Usage (from workers/ai-agent):
 *   npx tsx --env-file=.env src/scripts/forceMonitorTest.ts
 *
 * Env:
 *   FORCE_MONITOR_AGENT_ID (required)
 *   FORCE_MONITOR_ACTION   hold|add|trim|exit|cut|flip (required)
 *   FORCE_MONITOR_SYMBOL   optional (default BTC)
 *
 * Aborts unless agent.dry_run === true, OR FORCE_ALLOW_LIVE=1 is set.
 */
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { config, isTestnet } from '../config.js';
import type { CoinglassMarketData } from '../data/coinglass.js';
import { barIntervalForAgent, buildSymbolCache, marketDataCacheKey } from '../data/marketCache.js';
import {
  beginHlCycleCache,
  endHlCycleCache,
} from '../hl/adapter.js';
import { decryptSecret } from '../lib/crypto.js';
import { getSupabase } from '../lib/supabase.js';
import { executeAgentMonitoring } from '../monitor.js';
import { getOpenPositions } from '../stores.js';
import type { AgentRow } from '../types.js';

const agentId = config.forceMonitorAgentId;
const action = config.forceMonitorAction;
const symbol = config.forceMonitorSymbol ?? 'BTC';
const allowLive = process.env.FORCE_ALLOW_LIVE === '1';

/** Minimal CG-shaped snapshot so force tests still run when CoinGlass 429s. */
async function stubMarketData(sym: string): Promise<CoinglassMarketData> {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: isTestnet() }),
  });
  const mids = await info.allMids();
  const mid = Number(mids[sym] ?? mids[`U${sym}`] ?? 0);
  if (!(mid > 0)) throw new Error(`No HL mid for ${sym}`);
  const now = Date.now();
  const bar = {
    timestamp: now,
    open_price: mid,
    high_price: mid,
    low_price: mid,
    close_price: mid,
    dollar_volume: 1,
    buy_dollar_volume: 0.5,
    sell_dollar_volume: 0.5,
    dollar_open_interest_close: 1,
    funding_rate: 0,
    premium: 0,
  };
  return {
    symbol: sym,
    fetchedAt: new Date().toISOString(),
    barIntervalMs: 60 * 60 * 1000,
    futures: { timeSeries: Array.from({ length: 72 }, (_, i) => ({ ...bar, timestamp: now - (71 - i) * 14_400_000 })) },
    spot: { timeSeries: [] },
    options: { timeSeries: [] },
  };
}

async function main(): Promise<void> {
  if (!agentId) throw new Error('Set FORCE_MONITOR_AGENT_ID');
  if (!action) throw new Error('Set FORCE_MONITOR_ACTION');

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ai_agents')
    .select('*')
    .eq('id', agentId)
    .maybeSingle();
  if (error) throw new Error(`load agent: ${error.message}`);
  if (!data) throw new Error(`agent not found: ${agentId}`);

  const agent = data as AgentRow;
  if (!agent.dry_run && !allowLive) {
    throw new Error(
      `Refusing to run: agent ${agentId} has dry_run=false. Set FORCE_ALLOW_LIVE=1 to place real orders.`,
    );
  }
  if (agent.status !== 'active') {
    throw new Error(`agent status is ${agent.status}, expected active`);
  }

  const opens = await getOpenPositions(agent.id);
  console.log(
    `[force-test] agent=${agent.id} dry_run=${agent.dry_run} LIVE=${!agent.dry_run} action=${action} symbol=${symbol}`,
  );
  console.log(
    `[force-test] open positions:`,
    opens.map((p) => `${p.symbol} ${p.direction} $${p.size_usd}`).join(', ') || '(none)',
  );

  let { marketData, validKeys } = await buildSymbolCache([agent]);
  // Cache keys are symbol+interval — mirror the monitor's per-agent lookup.
  const dataKey = marketDataCacheKey(
    symbol,
    barIntervalForAgent(symbol, agent.config.horizon),
  );
  if (!marketData.has(dataKey)) {
    console.warn(`[force-test] CoinGlass miss for ${symbol} — stubbing from HL mid`);
    marketData = new Map(marketData);
    marketData.set(dataKey, await stubMarketData(symbol));
  }
  if (validKeys.size === 0 && agent.coinglass_key_ciphertext) {
    try {
      validKeys = new Set([decryptSecret(agent.coinglass_key_ciphertext)]);
    } catch {
      // entitlement still fails without a decryptable key
    }
  }
  console.log(
    `[force-test] market data symbols=${[...marketData.keys()].join(',') || '(none)'} validKeys=${validKeys.size}`,
  );

  const { data: run } = await supabase
    .from('ai_agent_runs')
    .insert({ agent_id: agent.id, status: 'running' })
    .select('id')
    .single();
  const runId = (run?.id as string | undefined) ?? null;

  beginHlCycleCache();
  try {
    const result = await executeAgentMonitoring({
      agent,
      runId,
      marketDataBySymbol: marketData,
      validCoinglassKeys: validKeys,
      openingCache: new Map(),
      sharedWalletClaimedSymbols: new Set(
        opens.map((p) => p.symbol.toUpperCase()),
      ),
    });

    await supabase
      .from('ai_agent_runs')
      .update({
        status: 'ok',
        finished_at: new Date().toISOString(),
        equity_snapshot: result.equityUsd,
      })
      .eq('id', runId ?? '');

    const { data: decisions } = await supabase
      .from('ai_agent_decisions')
      .select('type, symbol, decision, created_at')
      .eq('agent_id', agent.id)
      .eq('run_id', runId ?? '')
      .order('created_at', { ascending: true });

    console.log(
      `[force-test] done symbols=${result.symbolsProcessed} actionsExecuted=${result.actionsExecuted}`,
    );
    for (const d of decisions ?? []) {
      const dec = d.decision as Record<string, unknown> | null;
      console.log(
        `[force-test] decision type=${d.type} symbol=${d.symbol} action=${dec?.action ?? '-'} executed=${dec?.executed ?? '-'} note=${(dec as { note?: string })?.note ?? (dec as { decisionBody?: { note?: string } })?.decisionBody?.note ?? ''}`,
      );
      if (dec?.action === 'flip' || action === 'flip') {
        console.log(
          `[force-test]   flip from=${dec?.fromDirection} to=${dec?.toDirection} body=${JSON.stringify(dec?.decisionBody ?? {}).slice(0, 300)}`,
        );
      }
    }
  } catch (err) {
    await supabase
      .from('ai_agent_runs')
      .update({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId ?? '');
    throw err;
  } finally {
    endHlCycleCache();
    await supabase
      .from('ai_agents')
      .update({ last_run_at: new Date().toISOString() })
      .eq('id', agent.id);
  }
}

main().catch((err) => {
  console.error('[force-test] FAILED', err);
  process.exit(1);
});
