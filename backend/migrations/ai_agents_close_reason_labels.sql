-- Document canonical ai_agent_positions.close_reason tokens.
-- Status stays OPEN | CLOSED | CLOSED_BY_USER; analytics uses close_reason.

COMMENT ON COLUMN public.ai_agent_positions.close_reason IS
  'Canonical close label. External (status=CLOSED_BY_USER): stop_fill | take_profit_fill | liquidated | closed_externally | adopted_on_revoke. Agent exit (status=CLOSED): exit | cut | flip | trim_escalated. stop_fill/take_profit_fill = close price ≈ tracked SL/TP (±15 bps); otherwise closed_externally (manual / drifted levels).';

COMMENT ON TABLE public.ai_agent_positions IS
  'Agent-tracked positions. Reconciled against HL each cycle. External vanishes use CLOSED_BY_USER + classified close_reason (stop_fill / take_profit_fill / liquidated / closed_externally); agent exits use CLOSED.';
