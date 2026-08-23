-- AI Trading Agents V1 schema (see docs/ai-agents-v1.md)
-- All tables are backend/worker-only via service role. RLS is enabled with NO
-- policies (deny-all for anon/authenticated) — matching ur_jobs/ur_links style.

CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id text NOT NULL,
  name text NOT NULL DEFAULT 'AI Agent',
  -- copilot = trades on the user's main account (soft isolation);
  -- dedicated = trades on an HL subaccount (hard isolation).
  mode text NOT NULL DEFAULT 'copilot' CHECK (mode IN ('copilot', 'dedicated')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'stopped', 'revoked')),
  -- When true the agent runs the full decision loop but never places orders.
  -- Default false (live). Shadow toggle is a local/dev affordance only.
  dry_run boolean NOT NULL DEFAULT false,
  hl_master_address text NOT NULL,
  hl_agent_address text NOT NULL,
  -- AES-256-GCM ciphertext (base64: iv || tag || data) under AGENT_KMS_KEY.
  hl_agent_key_ciphertext text NOT NULL,
  hl_subaccount_address text,
  -- { symbols: string[], models: {opening:{provider,model}, monitor_win?, monitor_loss?},
  --   max_capital_usd: number, leverage_cap: number, schedule_minutes?: number }
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- BYOK keys, encrypted with the same KMS envelope as the agent key.
  coinglass_key_ciphertext text,
  model_keys_ciphertext jsonb,
  trading_env text NOT NULL DEFAULT 'mainnet' CHECK (trading_env IN ('mainnet', 'demo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_user ON ai_agents (privy_user_id);
CREATE INDEX IF NOT EXISTS idx_ai_agents_active ON ai_agents (status) WHERE status = 'active';

COMMENT ON TABLE ai_agents IS
  'AI trading agent instances. One row per user-created agent. Agent HL keys are AES-GCM encrypted; worker decrypts at run time. Service-role only.';

CREATE TABLE IF NOT EXISTS ai_agent_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  symbol text NOT NULL,
  dex text NOT NULL DEFAULT '',
  direction text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLOSED', 'CLOSED_BY_USER')),
  entry_price numeric NOT NULL,
  size_usd numeric NOT NULL,
  leverage numeric NOT NULL,
  stop_loss numeric,
  take_profit numeric,
  take_profit_targets jsonb,
  tp_hit_count int NOT NULL DEFAULT 0,
  trim_count int NOT NULL DEFAULT 0,
  checks_count int NOT NULL DEFAULT 0,
  conviction int,
  invalidation_criteria jsonb,
  cloid_prefix text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text,
  close_price numeric,
  realized_pnl numeric,
  last_check_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_positions_agent ON ai_agent_positions (agent_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_positions_open
  ON ai_agent_positions (agent_id, symbol) WHERE status = 'OPEN';

COMMENT ON TABLE ai_agent_positions IS
  'Agent-tracked positions. Reconciled against HL each cycle. External vanishes use CLOSED_BY_USER + classified close_reason (stop_fill / take_profit_fill / liquidated / closed_externally); agent exits use CLOSED.';

COMMENT ON COLUMN ai_agent_positions.close_reason IS
  'Canonical close label. External (CLOSED_BY_USER): stop_fill | take_profit_fill | liquidated | closed_externally | adopted_on_revoke. Agent exit (CLOSED): exit | cut | flip | trim_escalated.';

CREATE TABLE IF NOT EXISTS ai_agent_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  run_id uuid,
  symbol text,
  -- opening | monitor_win | monitor_loss | skipped_user_conflict | error | ...
  type text NOT NULL,
  decision jsonb,
  -- Full prompt + model response + parsed action. Replaces Pinata IPFS CIDs.
  reasoning jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_agent
  ON ai_agent_decisions (agent_id, created_at DESC);

-- Added in migration ai_agent_decisions_model_cols: LLM attribution for
-- usage analytics (most-used models etc.). Null for non-LLM rows.
ALTER TABLE ai_agent_decisions
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS model text;
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_model
  ON ai_agent_decisions (provider, model) WHERE model IS NOT NULL;

COMMENT ON TABLE ai_agent_decisions IS
  'Every AI decision with full reasoning payload (jsonb, replaces IPFS/Pinata). Feeds the agent dashboard decision feed.';

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  error text,
  -- Account (or subaccount) equity at run time — feeds the dashboard chart.
  equity_snapshot numeric
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_agent ON ai_agent_runs (agent_id, started_at DESC);

COMMENT ON TABLE ai_agent_runs IS
  'Per-cycle audit trail + equity snapshots (absorbs old chart-history.ts).';

-- Deny-all RLS: service role bypasses; anon/authenticated get nothing.
ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_runs ENABLE ROW LEVEL SECURITY;

-- Added in migration global_context_cache: worker-owned cache for globally
-- shared AI context (identical across agents, expensive/rate-limited to fetch)
-- with per-key TTL. Deribit DVOL now; macro-calendar / rates events later.
CREATE TABLE IF NOT EXISTS global_context_cache (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
ALTER TABLE global_context_cache ENABLE ROW LEVEL SECURITY;
