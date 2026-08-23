-- New AI agents trade live by default. Shadow (dry_run) remains available for
-- local/dev via AI_AGENT_ALLOW_SHADOW_TOGGLE + the __DEV__ UI switch.
ALTER TABLE ai_agents
  ALTER COLUMN dry_run SET DEFAULT false;
