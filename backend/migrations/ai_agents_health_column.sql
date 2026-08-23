-- Orthogonal runtime health hint for AI agents.
-- Never overloads status (active/stopped/…); worker writes, API reads.
ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS health jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_agents.health IS
  'Worker-written runtime health. Shape: {degraded, reasons[], streaks, lastOkAt, since, lastAlertAt, updatedAt}. Does not change status; fallback/degraded signaling only.';
