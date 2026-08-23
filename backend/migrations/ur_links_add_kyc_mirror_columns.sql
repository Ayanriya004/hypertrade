-- Analytics mirror of UR /v1/profile KYC fields on ur_links.
-- Nullable on purpose: existing rows fill in on next successful profile
-- (or KYC status) sync. These columns are NEVER an authorization source;
-- all KYC/banking gates continue to use the live UR API.
-- Table remains RLS-enabled with zero policies (service-role only).
--
-- Fresh forks: prefer backend/migrations/ur_banking_v1.sql (includes these
-- columns). This file stays for older DBs created before KYC mirror landed.

ALTER TABLE public.ur_links
  ADD COLUMN IF NOT EXISTS chain_status smallint,
  ADD COLUMN IF NOT EXISTS kyc_current_step smallint;

COMMENT ON COLUMN public.ur_links.chain_status IS
  'Cached UR chainStatus from /v1/profile (1=SoftBlocked, 2=Tourist, 3=Blocked, 4=Closed, 5=Live). Analytics only — never use for authz.';

COMMENT ON COLUMN public.ur_links.kyc_current_step IS
  'Cached UR kycCurrentStep from /v1/profile (0=UNKNOWN … 5=Rejected). Analytics only — never use for authz.';

ALTER TABLE public.ur_links
  DROP CONSTRAINT IF EXISTS ur_links_chain_status_range;
ALTER TABLE public.ur_links
  ADD CONSTRAINT ur_links_chain_status_range
  CHECK (chain_status IS NULL OR (chain_status >= 1 AND chain_status <= 5));

ALTER TABLE public.ur_links
  DROP CONSTRAINT IF EXISTS ur_links_kyc_current_step_range;
ALTER TABLE public.ur_links
  ADD CONSTRAINT ur_links_kyc_current_step_range
  CHECK (kyc_current_step IS NULL OR (kyc_current_step >= 0 AND kyc_current_step <= 5));

CREATE INDEX IF NOT EXISTS ur_links_chain_status_idx
  ON public.ur_links (chain_status);

CREATE INDEX IF NOT EXISTS ur_links_kyc_current_step_idx
  ON public.ur_links (kyc_current_step);
