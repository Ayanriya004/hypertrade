-- AI agents: expose config.risk_profile as a first-class column for
-- analytics (win-rate / engagement comparisons per profile).
--
-- GENERATED column on purpose: the source of truth stays config jsonb
-- (backend validate_agent_config always writes it; worker reads
-- config.risk_profile), so this column can never drift from the code.
-- Rows created before the field existed resolve to 'standard'.

alter table public.ai_agents
  add column if not exists risk_profile text
  generated always as (coalesce(config->>'risk_profile', 'standard')) stored;

create index if not exists idx_ai_agents_risk_profile
  on public.ai_agents (risk_profile);
