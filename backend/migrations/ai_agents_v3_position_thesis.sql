-- AI agents: persist the opening model's thesis on each position so the
-- monitor prompts can check the original reasoning / invalidation criteria
-- instead of receiving empty placeholders.
--
-- thesis jsonb shape (written by the worker, read-only elsewhere):
--   {
--     "reasoning": string,
--     "invalidation_criteria": string[],
--     "key_metrics": object | null,
--     "add_trigger": string | null
--   }

alter table public.ai_agent_positions
  add column if not exists thesis jsonb;
