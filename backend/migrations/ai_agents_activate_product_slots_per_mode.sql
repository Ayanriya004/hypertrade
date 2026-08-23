-- Product slots are per mode: Shared/copilot max 2, Dedicated max 10
-- (independent pools). Count only peers in the same mode when activating
-- a draft. Dedicated drafts already occupy a slot (HL sub at Create) — this
-- RPC still counts non-draft/non-revoked only, so activating a Dedicated
-- draft does not require a *new* slot. Shared drafts are gated here.
-- See counts_toward_product_slot / product_slot_max_for_mode in ai_agents.py.

CREATE OR REPLACE FUNCTION activate_ai_agent_under_cap(
  p_agent_id uuid,
  p_privy_user_id text,
  p_max_active integer,
  p_max_product_slots integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row ai_agents%ROWTYPE;
  v_active_count integer;
  v_slot_count integer;
  v_mode text;
BEGIN
  PERFORM pg_advisory_xact_lock(87201401, hashtext(p_privy_user_id));

  SELECT * INTO v_row
  FROM ai_agents
  WHERE id = p_agent_id AND privy_user_id = p_privy_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.status = 'active' THEN
    RETURN jsonb_build_object('ok', true, 'agent', to_jsonb(v_row));
  END IF;

  IF v_row.status NOT IN ('draft', 'paused', 'stopped') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'bad_status',
      'status', v_row.status
    );
  END IF;

  -- Per-mode product slots. Only draft activation adds one.
  IF v_row.status = 'draft' THEN
    v_mode := COALESCE(v_row.mode, 'copilot');

    SELECT COUNT(*)::integer INTO v_slot_count
    FROM ai_agents
    WHERE privy_user_id = p_privy_user_id
      AND status NOT IN ('draft', 'revoked')
      AND COALESCE(mode, 'copilot') = v_mode;

    IF v_slot_count >= p_max_product_slots THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'slots',
        'used', v_slot_count,
        'max', p_max_product_slots,
        'mode', v_mode
      );
    END IF;
  END IF;

  SELECT COUNT(*)::integer INTO v_active_count
  FROM ai_agents
  WHERE privy_user_id = p_privy_user_id AND status = 'active';

  IF v_active_count >= p_max_active THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cap');
  END IF;

  UPDATE ai_agents
  SET status = 'active', updated_at = now()
  WHERE id = p_agent_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'agent', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION activate_ai_agent_under_cap(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_ai_agent_under_cap(uuid, text, integer, integer) TO service_role;
