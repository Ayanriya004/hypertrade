-- Extend activate_ai_agent_under_cap with a product-slot ceiling (2 Shared /
-- 10 Dedicated-eligible). Draft → active consumes a slot; resume of
-- stopped/paused already holds one so the product count is unchanged.
-- Superseded by ai_agents_activate_product_slots_per_mode.sql (per-mode pools).
-- See product_slot_max_for_mode in backend/ai_agents.py.

-- Drop the previous 3-arg overload so PostgREST binds the new signature.
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
BEGIN
  -- Namespace 87201401 = ai_agent_activate; second key hashes the user id.
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

  -- Product slots: non-draft / non-revoked. Only draft activation adds one.
  IF v_row.status = 'draft' THEN
    SELECT COUNT(*)::integer INTO v_slot_count
    FROM ai_agents
    WHERE privy_user_id = p_privy_user_id
      AND status NOT IN ('draft', 'revoked');

    IF v_slot_count >= p_max_product_slots THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'slots',
        'used', v_slot_count,
        'max', p_max_product_slots
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
