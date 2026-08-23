-- UR.APP / Fiat24 banking tables (Tier 2 — optional)
-- Exported from production shape for fresh forks. Service-role only:
-- RLS enabled with NO policies (deny-all for anon/authenticated).
--
-- Apply after backend/supabase_schema.sql.
-- Safe on existing DBs: CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
-- The later file ur_links_add_kyc_mirror_columns.sql remains idempotent.

-- ---------------------------------------------------------------------------
-- ur_links — Privy DID ↔ URID binding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ur_links (
  privy_user_id text PRIMARY KEY,
  ur_id bigint NOT NULL,
  evm_address text,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source = ANY (ARRAY['manual'::text, 'mint'::text, 'import'::text])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Analytics mirror of UR /v1/profile enums — NEVER use for authorization.
  chain_status smallint,
  kyc_current_step smallint,
  CONSTRAINT ur_links_ur_id_unique UNIQUE (ur_id),
  CONSTRAINT ur_links_chain_status_range
    CHECK (chain_status IS NULL OR (chain_status >= 1 AND chain_status <= 5)),
  CONSTRAINT ur_links_kyc_current_step_range
    CHECK (kyc_current_step IS NULL OR (kyc_current_step >= 0 AND kyc_current_step <= 5))
);

COMMENT ON TABLE public.ur_links IS
  'Maps a Privy user (privy_user_id, i.e. did:privy:...) to their UR account NFT (ur_id) on Mantle. Backend-only (service role); frontend never reads or writes it. ur_id is unique to prevent two Privy users sharing the same URID.';

COMMENT ON COLUMN public.ur_links.source IS
  'How the link was established: ''manual'' (dev/admin set), ''mint'' (created via UR mint API), ''import'' (user already had a UR account).';

COMMENT ON COLUMN public.ur_links.chain_status IS
  'Cached UR chainStatus from /v1/profile (1=SoftBlocked, 2=Tourist, 3=Blocked, 4=Closed, 5=Live). Analytics only — never use for authz.';

COMMENT ON COLUMN public.ur_links.kyc_current_step IS
  'Cached UR kycCurrentStep from /v1/profile (0=UNKNOWN … 5=Rejected). Analytics only — never use for authz.';

CREATE INDEX IF NOT EXISTS ur_links_chain_status_idx
  ON public.ur_links (chain_status);
CREATE INDEX IF NOT EXISTS ur_links_kyc_current_step_idx
  ON public.ur_links (kyc_current_step);

ALTER TABLE public.ur_links ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- ur_webhook_events — inbound webhook log + idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ur_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  ur_id bigint,
  tx_hash text,
  payload jsonb NOT NULL,
  signature text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received'
    CHECK (status = ANY (ARRAY[
      'received'::text, 'processed'::text, 'failed'::text, 'skipped'::text
    ])),
  error_message text
);

COMMENT ON TABLE public.ur_webhook_events IS
  'Inbound UR webhook log + idempotency. UR delivery is at-least-once; event_id is a deterministic key derived from event payload so retries collapse to the same row (insert ON CONFLICT DO NOTHING).';

COMMENT ON COLUMN public.ur_webhook_events.event_id IS
  'Deterministic dedupe key. For transaction events: data.txHash. For others: sha256(event + canonical(data) + timestamp).';

CREATE INDEX IF NOT EXISTS ix_ur_webhook_events_received_at
  ON public.ur_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS ix_ur_webhook_events_status
  ON public.ur_webhook_events (status) WHERE status <> 'processed';
CREATE INDEX IF NOT EXISTS ix_ur_webhook_events_tx_hash
  ON public.ur_webhook_events (tx_hash);
CREATE INDEX IF NOT EXISTS ix_ur_webhook_events_ur_id
  ON public.ur_webhook_events (ur_id);

ALTER TABLE public.ur_webhook_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- ur_jobs — deposit / withdraw / fx / payout / transfer FSM
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ur_jobs (
  id text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  privy_user_id text NOT NULL,
  ur_id bigint NOT NULL,
  kind text NOT NULL
    CHECK (kind = ANY (ARRAY[
      'deposit'::text, 'withdraw'::text, 'fx'::text, 'payout'::text, 'transfer'::text
    ])),
  source_chain_id integer NOT NULL,
  source_token text NOT NULL,
  source_amount numeric(38, 18) NOT NULL,
  target_chain_id integer,
  target_currency text NOT NULL,
  target_amount numeric(38, 18),
  quote_id text,
  quote_expires_at timestamptz,
  idempotency_key text NOT NULL,
  source_tx_hash text,
  dest_tx_hash text,
  ur_event_id text,
  status text NOT NULL DEFAULT 'created'
    CHECK (status = ANY (ARRAY[
      'created'::text, 'quoting'::text, 'awaiting_user_sig'::text,
      'submitted'::text, 'source_confirmed'::text, 'bridged'::text,
      'completed'::text, 'failed'::text, 'expired'::text
    ])),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ur_jobs_idempotency_unique UNIQUE (privy_user_id, idempotency_key)
);

COMMENT ON TABLE public.ur_jobs IS
  'In-flight UR off-ramps (kind=deposit, USDC -> USD24) and on-ramps (kind=withdraw, USD24 -> USDC). Status FSM driven by relayer + UR webhooks.';

COMMENT ON COLUMN public.ur_jobs.kind IS
  'Job classification: deposit (USDC -> USD24), withdraw (USD24 -> USDC), fx (intra-fiat swap on Mantle), payout (bank send), transfer (P2P URID).';

COMMENT ON COLUMN public.ur_jobs.idempotency_key IS
  'Client-provided key (per privy_user_id) preventing double-submission on retries.';

COMMENT ON COLUMN public.ur_jobs.ur_event_id IS
  'UR transaction webhook eventId once UR confirms the on-chain settlement.';

CREATE INDEX IF NOT EXISTS ix_ur_jobs_user_status
  ON public.ur_jobs (privy_user_id, status);
CREATE INDEX IF NOT EXISTS ix_ur_jobs_pending
  ON public.ur_jobs (status, updated_at)
  WHERE status <> ALL (ARRAY['completed'::text, 'failed'::text, 'expired'::text]);
CREATE INDEX IF NOT EXISTS ix_ur_jobs_source_tx
  ON public.ur_jobs (source_tx_hash) WHERE source_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ur_jobs_ur_event
  ON public.ur_jobs (ur_event_id) WHERE ur_event_id IS NOT NULL;

ALTER TABLE public.ur_jobs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- ur_notifications — in-app banking inbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ur_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  ur_id bigint,
  category text NOT NULL DEFAULT 'transaction'
    CHECK (category = ANY (ARRAY['transaction'::text, 'system'::text])),
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ur_notifications IS
  'Per-user banking notification inbox (KYC outcome, pay-ins, card spend, withdraw/payout). Backend-only via service role; frontend reads/marks-read through the FastAPI /api/notifications/* endpoints scoped by Privy user_id. dedupe_key (e.g. tx hash) collapses at-least-once UR webhook retries.';

CREATE UNIQUE INDEX IF NOT EXISTS ur_notifications_dedupe_idx
  ON public.ur_notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ur_notifications_user_created_idx
  ON public.ur_notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ur_notifications_user_unread_idx
  ON public.ur_notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE public.ur_notifications ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- ur_p2p_recipients — saved P2P counterparties
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ur_p2p_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id text NOT NULL,
  recipient_ur_id bigint NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ur_p2p_recipients_ur_id_positive CHECK (recipient_ur_id > 0),
  CONSTRAINT ur_p2p_recipients_label_len
    CHECK (char_length(TRIM(BOTH FROM label)) >= 1 AND char_length(label) <= 64)
);

COMMENT ON TABLE public.ur_p2p_recipients IS
  'Saved HyperTrade P2P recipients (label + URID) per Privy user. Backend-only via service role; scoped by privy_user_id in FastAPI.';

CREATE UNIQUE INDEX IF NOT EXISTS ur_p2p_recipients_user_recipient_unique
  ON public.ur_p2p_recipients (privy_user_id, recipient_ur_id);
CREATE INDEX IF NOT EXISTS ur_p2p_recipients_user_last_used_idx
  ON public.ur_p2p_recipients (privy_user_id, last_used_at DESC);

ALTER TABLE public.ur_p2p_recipients ENABLE ROW LEVEL SECURITY;
