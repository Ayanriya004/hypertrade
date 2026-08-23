-- Atomic AI-agent activation under the per-user active + product-slot caps.
-- Serializes concurrent /activate calls for the same privy_user_id via a
-- transaction-scoped advisory lock, then count-checks + flips status.
-- See activate_ai_agent in backend/server.py.
--
-- Product slots are per mode (independent pools):
--   Shared/copilot → p_max_product_slots = 2
--   Dedicated      → p_max_product_slots = 10
-- Draft → active consumes a slot in that mode; resume does not.

DROP FUNCTION IF EXISTS activate_ai_agent_under_cap(uuid, text, integer);

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
