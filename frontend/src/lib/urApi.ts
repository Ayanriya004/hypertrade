/**
 * UR (Fiat24) API client.
 *
 * All endpoints proxy through the HyperTrade backend at `/api/ur/*`, which
 * adds Partner-auth signing and scopes every call to the caller's URID
 * via the server-side `ur_links` table (Privy DID -> URID).
 *
 * Shapes here mirror what UR's OpenAPI returns on `/v1/profile`,
 * `/v1/balance`, and `/v1/transactions` (Mantle Sepolia testnet today).
 * When UR's testnet flips to the Managed Custody `/api/fma/v1/*` paths
 * the backend will translate transparently; the frontend keeps these
 * canonical shapes.
 */
import { api, withAuth } from './api';

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

/** Numeric on-chain status of the URID NFT. 5 = Live (full banking ops). */
export type UrChainStatus = 1 | 2 | 3 | 4 | 5;

export const UR_CHAIN_STATUS_NAMES: Record<UrChainStatus, string> = {
  1: 'SoftBlocked',
  2: 'Tourist',
  3: 'Blocked',
  4: 'Closed',
  5: 'Live',
};

export interface UrAllowance {
  tokenSymbol: string;
  hasAllowance: boolean;
  chainId?: string;
}

export interface UrBankAccount {
  account: string;          // IBAN
  bankName: string;
  bankAddress: string;
  bic: string;
}

/** Shape returned by /v1/profile via /api/ur/profile (under `data`). */
export interface UrProfileData {
  urId: number;
  chainStatus: UrChainStatus;
  evmAddress: string;
  allowances: UrAllowance[];
  /** CHF-denominated, 2 decimals (so 3905 == 39.05 CHF) on a rolling 30-day window. */
  usedLimit: number;
  clientLimit: number;
  startLimitDate: number;
  kycCurrentStep?: number;
  kycCurrenctStepStr?: string; // typo in UR API
  kycRetryVerificationLevel?: number;
  kycRetryVerificationLevelStr?: string;
  kycMetadata?: unknown;
  /** Map of currency code (CHF, EUR, ...) -> array of issued bank accounts. */
  bankAccounts: Record<string, UrBankAccount[]>;
  /** Saved bank-payout recipients (cash pay-out / "Send"). */
  contacts?: UrPayoutContact[];
  crsInfo?: {
    needCrs: boolean;
    restrictDate: number;
    url: string;
  };
}

/** A saved bank-payout recipient from the profile `contacts` list. UR's
 *  exact shape varies by recipient country, so keep it permissive. */
export interface UrPayoutContact {
  contactId?: string;
  name?: string;
  /** IBAN or local account number (normalized, no spaces). */
  account?: string;
  /** Spaced IBAN from profile (`fullAccount`) when `account` is masked. */
  fullAccount?: string;
  bankName?: string;
  /** Some UR profile payloads use `bank` instead of `bankName`. */
  bank?: string;
  bic?: string;
  /** ISO-2 recipient country. */
  country?: string;
  currency?: string;
  [key: string]: unknown;
}

/** Metadata block UR expects on `POST /api/v1/payout-with-permit` (§6.2.2). */
export interface UrPayoutMetadata {
  bankAccountHolder: string;
  bankName: string;
  bankAccount: string;
  bankReference: string;
}

export function normalizeIbanAccount(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** ISO-13616 IBAN lengths for countries UR payout commonly supports. */
const IBAN_LENGTH_BY_COUNTRY: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27, JO: 30,
  KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27,
  MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SE: 24, SI: 19,
  SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
};

function isValidIbanChecksum(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = numeric;
  while (remainder.length > 2) {
    const block = remainder.slice(0, 9);
    remainder = String(parseInt(block, 10) % 97) + remainder.slice(block.length);
  }
  return parseInt(remainder, 10) % 97 === 1;
}

/** True once the IBAN has the expected length for its country (or passes mod-97). */
export function isIbanStructurallyComplete(raw: string): boolean {
  const iban = normalizeIbanAccount(raw);
  if (iban.length < 15 || iban.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const expected = IBAN_LENGTH_BY_COUNTRY[iban.slice(0, 2)];
  if (expected != null) return iban.length === expected;
  return isValidIbanChecksum(iban);
}

/** UR verify-contact examples use grouped IBANs (`CH93 0076 …`). */
export function formatIbanForUrWire(raw: string): string {
  const clean = normalizeIbanAccount(raw);
  if (clean.length < 15 || !/^[A-Z]{2}\d{2}/.test(clean)) return clean;
  return clean.replace(/(.{4})/g, '$1 ').trim();
}

/** UR `/country-cities` occasionally lists the same city twice — dedupe for UI. */
export function dedupeUrCities(cities: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const city of cities) {
    const key = city.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(city.trim());
  }
  return out;
}

function isMaskedAccount(value: string): boolean {
  return /[•*]/.test(value);
}

function readBankName(raw: Record<string, unknown>): string {
  const v = raw.bankName ?? raw.bank;
  return typeof v === 'string' ? v.trim() : '';
}

/** Bank display name from a normalized or raw contact row. */
export function getUrPayoutContactBankName(c: UrPayoutContact): string {
  return (c.bankName ?? c.bank ?? '').trim();
}

function normalizeUrPayoutContactRow(
  raw: Record<string, unknown>,
  currencyHint?: string,
): UrPayoutContact | null {
  const contactId = String(raw.contactId ?? raw.id ?? '').trim();
  if (!contactId) return null;

  const fullAccountRaw = String(raw.fullAccount ?? '').trim();
  const accountRaw = String(raw.account ?? '').trim();
  const payoutSource = fullAccountRaw || (isMaskedAccount(accountRaw) ? '' : accountRaw);
  const account = payoutSource ? normalizeIbanAccount(payoutSource) : normalizeIbanAccount(accountRaw);
  const bankName = readBankName(raw) || undefined;
  const bicRaw = String(raw.bic ?? raw.BIC ?? '').trim();

  return {
    contactId,
    name: String(raw.name ?? '').trim() || undefined,
    account: account || undefined,
    fullAccount: fullAccountRaw || undefined,
    bankName,
    bank: typeof raw.bank === 'string' ? raw.bank.trim() : undefined,
    bic: bicRaw || undefined,
    country: String(raw.country ?? '').trim() || undefined,
    currency: currencyHint ?? (String(raw.currency ?? '').trim() || undefined),
  };
}

/** Flatten UR profile `contacts` (array or currency-grouped map) for the UI. */
export function normalizeUrPayoutContacts(raw: unknown): UrPayoutContact[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((item) => (
        item && typeof item === 'object'
          ? normalizeUrPayoutContactRow(item as Record<string, unknown>)
          : null
      ))
      .filter((c): c is UrPayoutContact => !!c?.contactId);
  }

  if (typeof raw === 'object') {
    const out: UrPayoutContact[] = [];
    for (const [currency, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const row = normalizeUrPayoutContactRow(item as Record<string, unknown>, currency);
        if (row?.contactId) out.push(row);
      }
    }
    return out;
  }

  return [];
}

export function normalizeUrProfileData(data: UrProfileData): UrProfileData {
  if (!data.contacts) return data;
  return { ...data, contacts: normalizeUrPayoutContacts(data.contacts as unknown) };
}

export function buildUrPayoutMetadata(parts: {
  holder: string;
  bankName: string;
  account: string;
  reference: string;
}): UrPayoutMetadata {
  return {
    bankAccountHolder: parts.holder.trim(),
    bankName: parts.bankName.trim(),
    bankAccount: normalizeIbanAccount(parts.account),
    bankReference: parts.reference.trim(),
  };
}

export interface UrBalanceItem {
  /** Currency or coin symbol, e.g. "USD", "EUR", "CHF", "USDC". */
  symbol: string;
  /** Decimal string, e.g. "50.00". May lack decimals for zero-decimal currencies (JPY -> "0"). */
  amount: string;
}

/** Shape returned by /v1/balance via /api/ur/balance (under `data`). */
export type UrBalanceData = UrBalanceItem[];

export type UrTransactionDirection = 'IN' | 'OUT';

export interface UrTransaction {
  urId: string;
  title: string;
  subtitle: string;
  /** Signed string display amount, e.g. "+50.00" or "-12.34". */
  amount: string;
  /** Two-letter UR type code: CTU, CTF, FRX, PAY, etc. */
  type: string;
  timestamp: number; // unix seconds
  image: string;
  currency: string;
  direction: UrTransactionDirection;
  txHash: string;
  chainId: string;
  inputToken?: string;
  inputAmount?: string;
  inputTokenAddress?: string;
  /** Counter-currency token for FX (e.g. CHF24) on the debit leg. */
  token?: string;
  tokenAddress?: string;
  /** Amount received after FRX / CSW exchange (human decimal string). */
  outputAmount?: string;
  outputToken?: string;
  fromAddress?: string;
  status: string;
  listingTitle: string;
  txHashUrl: string;
  txIdIcon: string;
  /** Stable list key when one on-chain tx is split into debit + credit rows. */
  displayId?: string;
  /** P2P (HyperTrade user transfer) counterparty URID, backend-resolved. */
  counterpartyUrId?: string;
  /** P2P counterparty saved-recipient label, when the viewer saved them. */
  counterpartyName?: string;
}

export type UrTransactionsData = UrTransaction[];

// --------------------------------------------------------------------------- //
// API response envelopes from /api/ur/*
// --------------------------------------------------------------------------- //

export interface UrLinkResponse {
  ur_id: number;
  evm_address: string | null;
  source: string;
  created_at?: string;
}

interface UrProfileEnvelope {
  ur_id: number;
  data: UrProfileData;
}

interface UrBalanceEnvelope {
  ur_id: number;
  data: UrBalanceData | { fiatItems?: unknown; cryptoItems?: unknown };
}

interface UrTransactionsEnvelope {
  ur_id: number;
  data: UrTransactionsData;
}

// --------------------------------------------------------------------------- //
// Calls
// --------------------------------------------------------------------------- //

/** Fetch the caller's UR link. Returns null when no link exists (server 404). */
export async function fetchUrLink(accessToken: string): Promise<UrLinkResponse | null> {
  try {
    const res = await api.get<UrLinkResponse>('/ur/link', withAuth(accessToken));
    return res.data;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * Bind the caller's Privy account to a URID. `urId` is optional — when
 * omitted, the backend uses `UR_TEST_URID` (dev mode).
 */
export async function createUrLink(
  accessToken: string,
  urId?: number,
): Promise<UrLinkResponse> {
  const body = urId != null ? { ur_id: urId } : {};
  const res = await api.post<UrLinkResponse>('/ur/link', body, withAuth(accessToken));
  return res.data;
}

export async function fetchUrProfile(accessToken: string): Promise<UrProfileEnvelope> {
  const res = await api.get<UrProfileEnvelope>('/ur/profile', withAuth(accessToken));
  return {
    ...res.data,
    data: normalizeUrProfileData(res.data.data),
  };
}

export async function fetchUrBalance(accessToken: string): Promise<UrBalanceEnvelope> {
  const res = await api.get<UrBalanceEnvelope>('/ur/balance', withAuth(accessToken));
  return res.data;
}

export async function fetchUrTransactions(
  accessToken: string,
  pageSize = 20,
  reconcile = true,
): Promise<UrTransactionsEnvelope> {
  const res = await api.get<UrTransactionsEnvelope>('/ur/transactions', {
    params: { pageSize, reconcile },
    ...withAuth(accessToken),
  });
  return res.data;
}

// --------------------------------------------------------------------------- //
// Account statement (PDF export)
// --------------------------------------------------------------------------- //

export type UrStatementDirection = 'ALL' | 'IN' | 'OUT';
/** Transaction scope: account-money (CASH), card spend (CARD), or both. */
export type UrStatementScope = 'ALL' | 'CASH' | 'CARD';

export interface UrStatementRequest {
  from_timestamp: number;
  to_timestamp: number;
  currencies?: string[];
  direction?: UrStatementDirection;
  scope?: UrStatementScope;
  user_email?: string;
}

export interface UrStatementSummaryCurrency {
  in: number;
  out: number;
  net: number;
  count: number;
}

export interface UrStatementPreviewResponse {
  ur_id: number;
  state_id: string;
  period: { from_timestamp: number; to_timestamp: number };
  filters: { currencies: string[]; direction: UrStatementDirection; scope?: UrStatementScope };
  summary: {
    transaction_count: number;
    in_count: number;
    out_count: number;
    by_currency: Record<string, UrStatementSummaryCurrency>;
    total_in: number;
    total_out: number;
  };
  generated_at: string;
}

export async function previewUrStatement(
  accessToken: string,
  body: UrStatementRequest,
): Promise<UrStatementPreviewResponse> {
  const res = await api.post<UrStatementPreviewResponse>(
    '/ur/statement/preview',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function exportUrStatementPdf(
  accessToken: string,
  body: UrStatementRequest,
): Promise<ArrayBuffer> {
  const res = await api.post<ArrayBuffer>('/ur/statement/export', body, {
    ...withAuth(accessToken),
    responseType: 'arraybuffer',
  });
  const raw: unknown = res.data;
  if (raw instanceof ArrayBuffer) {
    if (!raw.byteLength) throw new Error('Statement PDF is empty');
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    const copy = new Uint8Array(raw.byteLength);
    copy.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    if (!copy.byteLength) throw new Error('Statement PDF is empty');
    return copy.buffer;
  }
  throw new Error('Could not download statement PDF');
}

export interface UrFxUsdRatesResponse {
  chain_id: number;
  /** ISO code → "how many USD24 you get for 1 unit of that currency". */
  rates: Record<string, number>;
}

/**
 * Fetch live USD-equivalent rates from Fiat24CryptoRelay's `getExchangeRate`.
 * Used by the dashboard to convert non-USD cash balances into a single
 * USD estimate that matches what an actual on-chain swap would clear at —
 * NOT a naive 1:1 sum across currencies.
 */
export async function fetchUrFxUsdRates(
  accessToken: string,
  currencies: string[],
): Promise<UrFxUsdRatesResponse> {
  const unique = Array.from(
    new Set(currencies.map((c) => (c || '').toUpperCase()).filter(Boolean)),
  );
  if (!unique.length) {
    return { chain_id: 0, rates: {} };
  }
  const res = await api.get<UrFxUsdRatesResponse>('/ur/fx/usd-rates', {
    params: { currencies: unique.join(',') },
    ...withAuth(accessToken),
  });
  return res.data;
}

/**
 * LayerZero delivery state for an Add Money (USDC -> USD24) source tx.
 *  - `inflight`  : message sent/verified, destination credit still pending.
 *  - `delivered` : executed on Mantle — the USD24 credit has landed (or is
 *                  about to in the same block).
 *  - `failed`    : destination execution reverted (rare; needs manual retry).
 *  - `unknown`   : not yet indexed by LayerZeroScan, or the lookup failed —
 *                  treat as still-in-flight (do NOT drop the "incoming" pill).
 */
export type UrBridgeStatus = 'inflight' | 'delivered' | 'failed' | 'unknown';

export interface UrBridgeStatusResponse {
  status: UrBridgeStatus;
  scanUrl: string;
  guid: string | null;
}

export async function fetchUrBridgeStatus(
  accessToken: string,
  txHash: string,
  chainId: number,
): Promise<UrBridgeStatusResponse> {
  const res = await api.get<UrBridgeStatusResponse>('/ur/deposit/bridge-status', {
    params: { txHash, chainId },
    ...withAuth(accessToken),
  });
  return res.data;
}

// --------------------------------------------------------------------------- //
// Path F — EIP-7702 deposit
// --------------------------------------------------------------------------- //

/**
 * Contract addresses the frontend needs to construct the batched deposit
 * tx (Ambire delegate, Fiat24CryptoDeposit, USDC). Pulled from the backend
 * so we can swap deployments without a mobile re-release.
 */
export interface UrDeposit7702Info {
  chain_id: number;
  ambire_7702_delegate: string;
  deposit_contract: string;
  usdc: string;
  designator_prefix: string;
}

export async function fetchUrDeposit7702Info(
  accessToken: string,
  chainId: number,
): Promise<UrDeposit7702Info> {
  const res = await api.get<UrDeposit7702Info>('/ur/deposit/7702/info', {
    params: { chain_id: chainId },
    ...withAuth(accessToken),
  });
  return res.data;
}

export interface UrDepositCurrencyOption {
  code: string;
  available: boolean;
  output_token?: string | null;
  dest_token?: string | null;
  reason?: string | null;
}

export interface UrDepositCurrenciesResponse {
  source_chain_id: number;
  dest_chain_id: number;
  deposit_ready: boolean;
  deposit_block_reason?: string | null;
  currencies: UrDepositCurrencyOption[];
}

export async function fetchUrDepositCurrencies(
  accessToken: string,
  sourceChainId: number,
): Promise<UrDepositCurrenciesResponse> {
  const res = await api.get<UrDepositCurrenciesResponse>('/ur/deposit/currencies', {
    params: { source_chain_id: sourceChainId },
    ...withAuth(accessToken),
  });
  return res.data;
}

/** EIP-7702 authorization tuple as returned by Privy `sign7702Authorization`. */
export interface UrDeposit7702Authorization {
  chain_id: number;
  address: string;
  nonce: number;
  y_parity: number;
  r: string;
  s: string;
}

/** One entry in the AmbireAccount.execute calls array. */
export interface UrDeposit7702Call {
  to: string;
  value: string;
  data: string;
}

export interface UrDeposit7702ExecuteRequest {
  idempotency_key: string;
  source_chain_id: number;
  source_token: string;
  source_amount: string;
  target_currency: string;
  target_amount?: string;
  quote_id?: string;
  quote_expires_at?: string;
  user_address: string;
  calls: UrDeposit7702Call[];
  batch_signature: string;
  /** Only on the first deposit per chain; omit once the EOA is already delegated. */
  authorization?: UrDeposit7702Authorization;
}

export interface UrJobSummary {
  id: string;
  kind: string;
  status: string;
  source_chain_id?: number;
  source_token?: string;
  source_amount?: string;
  target_chain_id?: number;
  target_currency?: string;
  target_amount?: string;
  quote_id?: string | null;
  quote_expires_at?: string | null;
  source_tx_hash?: string | null;
  dest_tx_hash?: string | null;
  ur_event_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
}

export interface UrDeposit7702ExecuteResponse {
  job: UrJobSummary;
  /** Set on successful broadcast. */
  tx_hash?: string;
  relayer_address?: string;
  via?: string;
  /** Set when the relayer rejected the dispatch (e.g. role gate, bad payload). */
  dispatch_error?: string;
  /** True when the call was a no-op idempotent retry. */
  idempotent?: boolean;
}

export async function executeUrDeposit7702(
  accessToken: string,
  body: UrDeposit7702ExecuteRequest,
): Promise<UrDeposit7702ExecuteResponse> {
  const res = await api.post<UrDeposit7702ExecuteResponse>(
    '/ur/deposit/execute-7702',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// Deposit quote (raw `/v1/deposit/quote` shape + frontend address bundle)
// --------------------------------------------------------------------------- //

/**
 * UR's quote shape — `best` is empty when the source token IS USDC (no swap),
 * populated when the source needs aggregator-routed swap (Phase 2).
 */
export interface UrDepositQuoteBest {
  aggregator: string;
  to: string;
  swapCalldata: string;
  minUsdcAmount: string;
  expectedUsdcAmount: string;
  slippageBps: number;
  deadline: number;
  priceImpact: string;
}

export interface UrDepositQuoteData {
  quoteId: string;
  /** UR's USDC fee in raw 6-decimal units, e.g. "19400". */
  feeAmountViaUsdc: string;
  /** Human-readable amount the user will receive, e.g. "4.98". */
  outputAmount: string;
  outputAmountBeforeFee: string;
  exchangeRate: string;
  crossChainFee: string;
  best: UrDepositQuoteBest;
  feeAmountViaNativeToken: string;
  processingFee: string;
  networkFee: string;
  totalFee: string;
  allQuotes?: unknown;
  /** Destination canonical chainId — "eip155:5003" for Mantle Sepolia, etc. */
  chainId: string;
}

export interface UrDepositQuoteAddresses {
  /** AmbireAccount7702 implementation the EOA delegates to. */
  ambire_7702_delegate: string | null;
  /** Fiat24CryptoDeposit on the source chain — recipient of the batch. */
  deposit_contract: string | null;
  /** ERC-20 USDC on the source chain. */
  usdc: string | null;
  /** Fiat OFT for the requested target currency on the source chain. */
  output_token: string | null;
}

export interface UrDepositQuoteResponse {
  ur_id: number;
  /** USDC raw amount the backend resolved from the user's input. */
  raw_source_amount: string;
  data: UrDepositQuoteData;
  addresses: UrDepositQuoteAddresses;
  designator_prefix: string;
}

export interface UrDepositQuoteRequest {
  source_chain_id: number;
  /** Either "USDC" or an ERC-20 address. */
  source_token: string;
  /** Human-readable ("5", "5.25") or raw ("5000000"). Backend resolves both. */
  source_amount: string;
  /** ISO currency code ("USD", "EUR", …). */
  target_currency: string;
}

export async function fetchUrDepositQuote(
  accessToken: string,
  body: UrDepositQuoteRequest,
): Promise<UrDepositQuoteResponse> {
  const res = await api.post<UrDepositQuoteResponse>(
    '/ur/deposit/quote',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// FX (Convert) — direct on-chain via Fiat24CryptoRelay on Mantle
//
// Architecture (read before editing this section):
// We are in EXTERNAL WALLET ACCESS mode. The user's URID NFT is owned by
// their own Privy EOA, and fiat balances (USD24/EUR24/CHF24/...) sit at
// that same EOA — not at a UR vault. So FX is not a REST call; it's a
// pair of on-chain txs the user signs themselves via the embedded wallet:
//
//   1. approve(relay, amount) on the source fiat ERC-20
//   2. moneyExchangeExactIn(inputToken, outputToken, amount, minOut) on
//      Fiat24CryptoRelay
//
// Backend role:
//   GET  /api/ur/fx/info    : surface contract + token addresses, min amt
//   POST /api/ur/fx/quote   : read-only on-chain quote (rate * spread)
//   POST /api/ur/fx/record  : persist the user's broadcast tx hash into
//                             ur_jobs (kind=fx) for history
//
// We deliberately do NOT relay these txs (the contract debits/credits
// `_msgSender()`, so the user MUST be the caller). MNT for gas comes from
// the user — testnet faucets, mainnet they hold it. 7702 on Mantle is a
// future optimisation once a delegate is confirmed there.
// --------------------------------------------------------------------------- //

export interface UrFxInfoResponse {
  chain_id: number;
  relay_address: string;
  /** { "USD24": "0x...", "EUR24": "0x...", ... } — only currencies the
   * relay's `validXXX24Tokens` returns true for. */
  fiat_tokens: Record<string, string>;
  /** All UR fiat tokens use 2 decimals on-chain. */
  decimals: number;
  /** Minimum USD24-equivalent the relay accepts, in raw 2-decimal units. */
  min_usd_raw: number | null;
  /** Current standardFee in bps (0 on testnet today). */
  fee_bps: number | null;
  market_closed: boolean | null;
  paused: boolean | null;
  /** Ambire 7702 delegate for gasless Convert via /ur/fx/execute-7702.
   * Null when the chain isn't wired for gasless FX yet — the frontend
   * MUST disable Convert and show a clear message in that case (no
   * silent user-gas fallback). */
  ambire_7702_delegate: string | null;
  /** Standard 7702 designator prefix (0xef0100). Used to detect whether
   * the EOA already has the delegation in place via eth_getCode. */
  designator_prefix: string;
}

export async function fetchUrFxInfo(accessToken: string): Promise<UrFxInfoResponse> {
  const res = await api.get<UrFxInfoResponse>('/ur/fx/info', withAuth(accessToken));
  return res.data;
}

export interface UrFxQuoteData {
  fromCurrency: string;
  toCurrency: string;
  /** Decimal string in the FROM currency, e.g. "10.00". */
  inputAmount: string;
  /** Decimal string in the TO currency, e.g. "8.36". */
  outputAmount: string;
  /** Effective rate after spread, decimal string. */
  exchangeRate: string;
  /** Spread as a decimal "0.9728" (= 2.72% UR margin). */
  spread: string;
  rawSpreadBps: number;
  feeBps: number;
  /** Minimum USD24-equivalent in whole-unit decimal string. */
  minUsdAmount: string;
  marketClosed: boolean;
}

export interface UrFxQuoteRaw {
  /** Raw int strings (string-typed so we can hand them to ethers/viem as-is). */
  inputAmount: string;
  outputAmount: string;
  exchangeRate: string;
  spread: string;
  effectiveRate: string;
  minUsd: string;
}

export interface UrFxAddresses {
  relay: string;
  input_token: string;
  output_token: string;
}

export interface UrFxQuoteResponse {
  chain_id: number;
  data: UrFxQuoteData;
  raw: UrFxQuoteRaw;
  addresses: UrFxAddresses;
}

export interface UrFxQuoteRequest {
  from_currency: string;
  to_currency: string;
  /** Whole-fiat-unit decimal string ("10" = 10 USD24). Server floors to 2 dp. */
  input_amount: string;
}

export async function fetchUrFxQuote(
  accessToken: string,
  body: UrFxQuoteRequest,
): Promise<UrFxQuoteResponse> {
  const res = await api.post<UrFxQuoteResponse>(
    '/ur/fx/quote',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// FX 7702 — gasless Convert via Ambire delegate + UR relayer pool.
//
// Mirrors the Add Money 7702 surface (UrDeposit7702*). The user signs
// off-chain (SetCode authorization + Ambire batch hash) and the backend
// relayer broadcasts the type-4 tx paying MNT for gas. See
// `backend/server.py: ur_fx_execute_7702` and `dispatch_7702_batch_job`.
//
// `recordUrFxSwap` (the old user-gas path) is gone — Convert is always
// relayer-sponsored now. If the relayer / Ambire delegate is missing on
// the requested chain, `/ur/fx/execute-7702` 400s and the UI surfaces it.
// --------------------------------------------------------------------------- //

export interface UrFxExecute7702Request {
  idempotency_key: string;
  source_chain_id: number;
  from_currency: string;
  to_currency: string;
  source_amount: string;
  target_amount?: string;
  user_address: string;
  calls: UrDeposit7702Call[];
  batch_signature: string;
  /** Only on the first Convert per chain; omit once the EOA is delegated. */
  authorization?: UrDeposit7702Authorization;
}

export interface UrFxExecute7702Response {
  job: UrJobSummary;
  /** Set on successful broadcast. */
  tx_hash?: string;
  relayer_address?: string;
  via?: string;
  /** Set when the relayer rejected the dispatch. */
  dispatch_error?: string;
  /** True when the call was a no-op idempotent retry. */
  idempotent?: boolean;
}

export async function executeUrFx7702(
  accessToken: string,
  body: UrFxExecute7702Request,
): Promise<UrFxExecute7702Response> {
  const res = await api.post<UrFxExecute7702Response>(
    '/ur/fx/execute-7702',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// Withdraw (cash-out) — External Wallet Access on-ramp, gasless via permit
//
// Architecture (read before editing):
// We're in EXTERNAL WALLET ACCESS mode. Cash-out (USD24/EUR24/CHF24 -> USDC)
// goes through UR's gasless permit on-ramp, NOT a relayer/7702 batch:
//
//   1. GET  /ur/withdraw/info   : Mantle chain (fiat home) + dest chains/USDC
//   2. User signs Full-Auth headers (personal_sign) — proves wallet ownership
//   3. POST /ur/withdraw/quote  : forwards Full-Auth to UR /api/v1/quote/onramp
//                                 -> quoteId, best.*, fees, + EIP-2612 permit
//                                    domain (name/version/nonce/spender).
//   4. User signs an EIP-2612 permit (eth_signTypedData_v4) over the fiat
//      token authorising the BufferPool spender.
//   5. POST /ur/withdraw/execute: forwards permit to /api/v1/onramp-with-permit
//                                 -> UR validates + executes + pays gas.
//   6. Poll /ur/jobs/:id until terminal.
//
// NOTE (2026-06-01): WORKING. UR lifted the region gate on the QA URID, so the
// old retCode=10000 "Convert is unavailable in your region" no longer fires —
// submit settles on-chain. The region/account error path is kept as a safety
// net (mainnet or other accounts could still hit it).
// --------------------------------------------------------------------------- //

/** Frontend-signed External-Mode Full-Auth header values. */
export interface UrExtAuth {
  hash: string;
  deadline: number;
  sign: string;
}

export interface UrWithdrawDestChain {
  chain_id: number;
  name: string;
  usdc: string | null;
}

export interface UrWithdrawInfoResponse {
  supported: boolean;
  /** Mantle chain where fiat lives (Full-Auth network + permit chainId). */
  mantle_chain_id: number;
  dest_chains: UrWithdrawDestChain[];
  default_dest_chain_id: number | null;
  dest_token: string;
}

export async function fetchUrWithdrawInfo(
  accessToken: string,
): Promise<UrWithdrawInfoResponse> {
  const res = await api.get<UrWithdrawInfoResponse>(
    '/ur/withdraw/info',
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrWithdrawQuoteRequest {
  auth: UrExtAuth;
  source_currency: string;
  source_amount: string;
  dest_chain_id: number;
  dest_token?: string;
  /** URID-owning EOA — backend reads the permit nonce for this address. */
  auth_owner_address: string;
}

/** UR's onramp quote `best` block (aggregator route). For a same-chain
 *  "direct" onramp, `to` is the zero address and `swapCalldata` is "0x". */
export interface UrWithdrawQuoteBest {
  aggregator?: string;
  to?: string;
  swapCalldata?: string;
  minAmountOut?: string;
  expectedAmountOut?: string;
  slippageBps?: number;
  deadline?: number;
}

export interface UrWithdrawQuoteResult {
  quoteId: string;
  best: UrWithdrawQuoteBest;
  /** Human-readable USDC the user will receive, e.g. "4.94". */
  outputAmount: string;
  exchangeRate?: string;
  displayRate?: string;
  needLiveness?: boolean;
  networkFee?: string;
  processingFee?: string;
  totalFee?: string;
  warningMessage?: string;
}

/** Everything the frontend needs to build + sign the EIP-2612 permit. */
export interface UrWithdrawPermit {
  token: string;
  spender: string;
  /** 2dp smallest-unit string (e.g. "500" = $5.00). */
  value: string;
  chain_id: number;
  name: string | null;
  version: string | null;
  nonce: number | null;
}

export interface UrWithdrawQuoteResponse {
  ur_id: number;
  raw_source_amount: string;
  result: UrWithdrawQuoteResult;
  /** Seconds the quote stays fresh before the review screen auto-refreshes. */
  quote_ttl_seconds?: number;
  addresses: {
    src_chain_id_caip2: string;
    dst_chain_id_caip2: string;
    from_token: string;
    dest_token: string;
  };
  permit: UrWithdrawPermit;
}

export async function requestUrWithdrawQuote(
  accessToken: string,
  body: UrWithdrawQuoteRequest,
): Promise<UrWithdrawQuoteResponse> {
  const res = await api.post<UrWithdrawQuoteResponse>(
    '/ur/withdraw/quote',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrWithdrawExecuteRequest {
  auth: UrExtAuth;
  quote_id: string;
  idempotency_key: string;
  source_currency: string;
  source_amount: string;
  dest_chain_id: number;
  dest_token?: string;
  target_amount?: string;
  quote_expires_at?: string;
  dst_aggregator: string;
  dst_token_out: string;
  dst_swap_calldata: string;
  dst_min_amount_out: string;
  permit_deadline: number;
  permit_v: number;
  permit_r: string;
  permit_s: string;
}

export interface UrWithdrawExecuteResponse {
  job: UrJobSummary;
  tx_hash?: string;
  via?: string;
  dispatch_error?: string;
  idempotent?: boolean;
}

export async function executeUrWithdraw(
  accessToken: string,
  body: UrWithdrawExecuteRequest,
): Promise<UrWithdrawExecuteResponse> {
  const res = await api.post<UrWithdrawExecuteResponse>(
    '/ur/withdraw/execute',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// Withdraw (onramp) liveness + retry — External Wallet Access §5.1.3–§5.1.8.
//
// Liveness: when a withdraw quote returns needLiveness=true (larger mainnet
// cash-outs), mint a Sumsub liveness token, run the SDK, then poll status until
// `pass` before submitting. Retry: detect/cancel/re-submit a cash-out whose
// destination swap failed (funds stranded as USDC on the dst chain).
// MAINNET-ONLY per UR.
// --------------------------------------------------------------------------- //

export interface UrLivenessTokenResponse {
  ur_id: number;
  result: { vendor?: string; access_token?: string; user_id?: string };
}

export interface UrLivenessStatusResponse {
  ur_id: number;
  result: {
    liveness_result?: 'pass' | 'pending' | 'rejected' | string;
    checked_at?: number;
    expired_at?: number;
    liveness_fail_reason?: string;
    liveness_locked?: boolean;
    liveness_unlock_at?: number;
  };
}

/** A stranded cash-out awaiting a destination-swap retry, or null if none. */
export interface UrPendingRetry {
  originalTxHash?: string;
  original_tx_hash?: string;
  originalChainId?: string;
  originalToken?: string;
  chainId: string;
  fromToken: string;
  toToken: string;
  amount: string;
  failedAt?: number;
  [key: string]: unknown;
}

/** UR's pending-retry record has used camelCase and snake_case across envs. */
export function pendingRetryOriginalTxHash(pr: UrPendingRetry): string {
  const h =
    pr.originalTxHash ??
    pr.original_tx_hash ??
    (typeof pr.txHash === 'string' ? pr.txHash : undefined) ??
    (typeof pr.tx_hash === 'string' ? pr.tx_hash : undefined);
  return typeof h === 'string' ? h.trim().toLowerCase() : '';
}

export async function fetchUrLivenessToken(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrLivenessTokenResponse> {
  const res = await api.post<UrLivenessTokenResponse>(
    '/ur/withdraw/liveness/token',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function fetchUrLivenessStatus(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrLivenessStatusResponse> {
  const res = await api.post<UrLivenessStatusResponse>(
    '/ur/withdraw/liveness/status',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function fetchUrPendingRetry(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<{ ur_id: number; result: UrPendingRetry | null }> {
  const res = await api.post<{ ur_id: number; result: UrPendingRetry | null }>(
    '/ur/withdraw/retry/pending',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function cancelUrRetry(
  accessToken: string,
  body: { auth: UrExtAuth; original_tx_hash?: string },
): Promise<{ ur_id: number; ok: boolean }> {
  const res = await api.post<{ ur_id: number; ok: boolean }>(
    '/ur/withdraw/retry/cancel',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrRetryQuoteResponse {
  ur_id: number;
  result: {
    quoteId?: string;
    best?: UrWithdrawQuoteBest;
    minAmountOut?: string;
    [key: string]: unknown;
  };
  /** Ready-to-sign EIP-2612 permit over the stranded USDC, or null if the
   *  spender/domain couldn't be resolved (do NOT sign in that case). */
  permit: UrWithdrawPermit | null;
}

export async function requestUrRetryQuote(
  accessToken: string,
  body: {
    auth: UrExtAuth;
    chain_id: number;
    from_token: string;
    to_token: string;
    amount: string;
    owner_address?: string;
    slippage_bps?: number;
  },
): Promise<UrRetryQuoteResponse> {
  const res = await api.post<UrRetryQuoteResponse>(
    '/ur/withdraw/retry/quote',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function submitUrRetry(
  accessToken: string,
  body: {
    auth: UrExtAuth;
    quote_id: string;
    chain_id: number;
    original_tx_hash?: string;
    usdc_amount: string;
    token_out: string;
    min_amount_out: string;
    aggregator: string;
    swap_calldata: string;
    permit_deadline: number;
    permit_v: number;
    permit_r: string;
    permit_s: string;
  },
): Promise<{ ur_id: number; result: Record<string, unknown>; tx_hash?: string }> {
  const res = await api.post<{ ur_id: number; result: Record<string, unknown>; tx_hash?: string }>(
    '/ur/withdraw/retry/submit',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// Cash pay-out ("Send") — External Wallet Access §6, gasless via permit
//
// Move a fiat balance out to an external bank account. Same gasless permit
// shape as Withdraw (reuses buildFullAuth + signOnrampPermit). Two phases:
//
//   A. Recipient setup
//      - GET  /ur/payout/config           : per-currency fee + min payout
//      - GET  /ur/payout/banks            : countries/banks (+ ibanMetadata)
//      - GET  /ur/payout/banks/iban/:iban : resolve bank from IBAN
//      - GET  /ur/payout/country-cities   : recipient country/city options
//      - GET  /ur/payout/payment-purposes : compliance purpose list
//      - POST /ur/payout/verify-reference : reference -> {purposeId, refId}
//      - POST /ur/payout/verify-contact   : recipient -> {contactId,...}
//   B. Permit & transfer
//      - POST /ur/payout/permit-info      : EIP-2612 permit scaffold
//      - user signs the permit (signOnrampPermit) over the fiat token
//      - POST /ur/payout/execute          : UR validates + clientPayout + gas
//      - poll /ur/jobs/:id until terminal
//
// Amounts are decimal strings ("250.00") into our endpoints; the backend
// floors to 2-dp smallest units. Fees/mins from /config are smallest-unit.
// --------------------------------------------------------------------------- //

export interface UrPayoutCurrencyConfig {
  currency: string;
  token_address: string | null;
  /** 2-dp smallest-unit string ("5000" == 50.00). */
  fee: string;
  /** 2-dp smallest-unit string ("1000" == 10.00). */
  min_payout: string;
  /** 2-dp smallest-unit string; per-currency maximum per transfer. */
  max_payout: string;
}

export interface UrPayoutConfigResponse {
  mantle_chain_id: number;
  currencies: UrPayoutCurrencyConfig[];
}

export async function fetchUrPayoutConfig(
  accessToken: string,
): Promise<UrPayoutConfigResponse> {
  const res = await api.get<UrPayoutConfigResponse>('/ur/payout/config', withAuth(accessToken));
  return res.data;
}

export interface UrBankIbanMetadata {
  placeholder?: string;
  mask?: string;
  bankCode?: { length: number; startDigit: number };
}

export interface UrBankEntry {
  name: string;
  bankCode?: string;
  bic?: string;
  country?: string;
  accountMask?: string;
  accountPlaceholder?: string;
  accountNotice?: string;
}

export interface UrBankCountry {
  key: string;
  name: string;
  countryCode: { iso2: string; iso3: string };
  /** Present for IBAN countries — user types an IBAN we resolve via lookup. */
  ibanMetadata?: UrBankIbanMetadata;
  /** Present for non-IBAN countries — user picks a bank + types account. */
  banks?: UrBankEntry[];
}

export async function fetchUrPayoutBanks(accessToken: string): Promise<UrBankCountry[]> {
  const res = await api.get<{ result: UrBankCountry[] }>('/ur/payout/banks', withAuth(accessToken));
  return res.data?.result ?? [];
}

/** Pick a neutral IBAN placeholder from UR's payout country list (SEPA-first). */
export function pickIbanPlaceholder(
  countries: UrBankCountry[],
  fallback: string,
): string {
  const preferIso2 = ['DE', 'FR', 'GB', 'NL', 'IT', 'ES', 'BE', 'AT', 'PT', 'IE'];
  for (const iso2 of preferIso2) {
    const c = countries.find((x) => x.countryCode?.iso2 === iso2);
    if (c?.ibanMetadata?.placeholder) return c.ibanMetadata.placeholder;
  }
  for (const c of countries) {
    if (c.ibanMetadata?.placeholder) return c.ibanMetadata.placeholder;
  }
  return fallback;
}

export interface UrBankByIban {
  name?: string;
  bankName?: string;
  bankCode?: string;
  bankCodes?: string[];
  bic?: string;
  country?: string;
  accountMask?: string;
  accountPlaceholder?: string;
  accountNotice?: string;
}

export async function fetchUrBankByIban(
  accessToken: string,
  iban: string,
): Promise<UrBankByIban | null> {
  const safe = iban.replace(/\s+/g, '').toUpperCase();
  const res = await api.get<{ result: UrBankByIban | null }>(
    `/ur/payout/banks/iban/${encodeURIComponent(safe)}`,
    withAuth(accessToken),
  );
  return res.data?.result ?? null;
}

export interface UrCountryCity {
  name: string;
  countryCode: { iso2: string; iso3: string };
  cities: string[];
  zipCodeRegEx?: string;
}

export async function fetchUrCountryCities(accessToken: string): Promise<UrCountryCity[]> {
  const res = await api.get<{ result: UrCountryCity[] }>('/ur/payout/country-cities', withAuth(accessToken));
  return res.data?.result ?? [];
}

export function findUrCountryCity(
  countries: UrCountryCity[],
  iso2: string,
): UrCountryCity | undefined {
  const cc = iso2.trim().toUpperCase();
  return countries.find((c) => c.countryCode?.iso2?.toUpperCase() === cc);
}

export function isUrCitySupported(entry: UrCountryCity | undefined, city: string): boolean {
  if (!entry || !city.trim()) return false;
  const norm = city.trim().toLowerCase();
  return entry.cities.some((c) => c.toLowerCase() === norm);
}

export function isUrZipValid(entry: UrCountryCity | undefined, zip: string): boolean {
  if (!zip.trim()) return false;
  if (!entry?.zipCodeRegEx) return true;
  try {
    return new RegExp(entry.zipCodeRegEx).test(zip.trim());
  } catch {
    return true;
  }
}

export function getUrPayoutCountryMeta(
  payoutCountries: UrBankCountry[],
  iso2: string,
): UrBankCountry | undefined {
  const cc = iso2.trim().toUpperCase();
  return payoutCountries.find(
    (c) => c.countryCode?.iso2?.toUpperCase() === cc || c.key?.toUpperCase() === cc,
  );
}

export type UrPayoutAccountMode = 'iban' | 'local';

/** How UR expects the bank account field for this payout country (§6.1.1). */
export function resolveUrPayoutAccountMode(
  meta: UrBankCountry | undefined,
): UrPayoutAccountMode | null {
  if (!meta) return null;
  if (meta.ibanMetadata) return 'iban';
  if (meta.banks?.length) return 'local';
  return null;
}

export interface UrPaymentPurpose {
  value: number;
  name: string;
}

export async function fetchUrPaymentPurposes(accessToken: string): Promise<UrPaymentPurpose[]> {
  const res = await api.get<{ result: { purposes?: UrPaymentPurpose[] } }>(
    '/ur/payout/payment-purposes',
    withAuth(accessToken),
  );
  return res.data?.result?.purposes ?? [];
}

/** The three params UR returns from verify-reference / verify-contact that
 *  are mandatory to submit a payout. Verify endpoints may return purposeId as
 *  a number, but payout-with-permit requires a JSON string. */
export interface UrPayoutRefParams {
  contactId?: string;
  purposeId: string;
  refId: string;
}

/** Pull {contactId, purposeId, refId} from verify-reference / verify-contact payloads. */
export function extractUrPayoutRefParams(
  raw: unknown,
  opts?: { requireContactId?: boolean },
): UrPayoutRefParams | null {
  if (!raw || typeof raw !== 'object') return null;
  const requireContactId = opts?.requireContactId ?? true;
  const obj = raw as Record<string, unknown>;
  const nested = obj.clientPayoutRefParams;
  const src = (nested && typeof nested === 'object' ? nested : obj) as Record<string, unknown>;
  const contactId = String(src.contactId ?? src.id ?? '').trim();
  const purposeRaw = src.purposeId ?? src.purpose;
  const refId = String(src.refId ?? src.ref ?? '').trim();
  if (requireContactId && !contactId) return null;
  if (purposeRaw == null || String(purposeRaw).trim() === '' || !refId) return null;
  return {
    ...(contactId ? { contactId } : {}),
    purposeId: String(purposeRaw).trim(),
    refId,
  };
}

export async function verifyUrPayoutReference(
  accessToken: string,
  body: { auth: UrExtAuth; reference: string },
): Promise<UrPayoutRefParams> {
  const res = await api.post<{ result: { clientPayoutRefParams?: unknown } & Record<string, unknown> }>(
    '/ur/payout/verify-reference',
    body,
    withAuth(accessToken),
  );
  const params = extractUrPayoutRefParams(res.data.result, { requireContactId: false });
  if (!params?.refId || !params.purposeId) {
    throw new Error('verify-reference returned no ref params');
  }
  return params;
}

export interface UrPayoutContactsResponse {
  ur_id: number;
  contacts: UrPayoutContact[];
}

/** Saved payout beneficiaries from UR GET /api/v2/br (Full-Auth). */
export async function fetchUrPayoutContacts(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrPayoutContactsResponse> {
  const res = await api.post<UrPayoutContactsResponse>(
    '/ur/payout/contacts',
    body,
    withAuth(accessToken),
  );
  return {
    ...res.data,
    contacts: normalizeUrPayoutContacts(res.data.contacts),
  };
}

export interface UrPayoutCreditorInput {
  name: string;
  street?: string;
  city?: string;
  zip?: string;
  country: string;
}

export interface UrVerifyContactRequest {
  auth: UrExtAuth;
  account: string;
  bankName: string;
  bic?: string;
  purpose: number;
  reference: string;
  creditor: UrPayoutCreditorInput;
}

export interface UrVerifyContactResult {
  account?: string;
  bankName?: string;
  bic?: string;
  purpose?: number;
  creditor?: UrPayoutCreditorInput;
  clientPayoutRefParams: UrPayoutRefParams;
}

export async function verifyUrPayoutContact(
  accessToken: string,
  body: UrVerifyContactRequest,
): Promise<UrVerifyContactResult> {
  const res = await api.post<{ result: UrVerifyContactResult }>(
    '/ur/payout/verify-contact',
    body,
    withAuth(accessToken),
  );
  return res.data.result;
}

/** EIP-2612 permit scaffold — same shape as the withdraw permit block. */
export interface UrPayoutPermit {
  token: string;
  spender: string;
  /** 2-dp smallest-unit string. */
  value: string;
  chain_id: number;
  name: string | null;
  version: string | null;
  nonce: number | null;
}

export interface UrPayoutPermitInfoResponse {
  ur_id: number;
  permit: UrPayoutPermit;
}

export async function fetchUrPayoutPermitInfo(
  accessToken: string,
  body: { auth: UrExtAuth; currency: string; amount: string; owner_address: string },
): Promise<UrPayoutPermitInfoResponse> {
  const res = await api.post<UrPayoutPermitInfoResponse>(
    '/ur/payout/permit-info',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrPayoutExecuteRequest {
  auth: UrExtAuth;
  idempotency_key: string;
  currency: string;
  amount: string;
  contact_id: string;
  purpose_id: string;
  ref: string;
  permit_amount: string;
  permit_deadline: number;
  permit_v: number;
  permit_r: string;
  permit_s: string;
  metadata?: UrPayoutMetadata;
}

export interface UrPayoutExecuteResponse {
  job: UrJobSummary;
  tx_hash?: string;
  via?: string;
  dispatch_error?: string;
  idempotent?: boolean;
}

export async function executeUrPayout(
  accessToken: string,
  body: UrPayoutExecuteRequest,
): Promise<UrPayoutExecuteResponse> {
  const res = await api.post<UrPayoutExecuteResponse>(
    '/ur/payout/execute',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// URID-to-URID transfer (P2P) — gasless EIP-2612 permit
// --------------------------------------------------------------------------- //

export interface UrTransferPermitInfoResponse {
  ur_id: number;
  /** Server-issued HMAC binding recipient + amount to execute. */
  recipient_binding?: string | null;
  permit: UrPayoutPermit;
}

export async function fetchUrTransferPermitInfo(
  accessToken: string,
  body: {
    auth: UrExtAuth;
    currency: string;
    amount: string;
    owner_address: string;
    to_account_id: string;
  },
): Promise<UrTransferPermitInfoResponse> {
  const res = await api.post<UrTransferPermitInfoResponse>(
    '/ur/transfer/permit-info',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrTransferExecuteRequest {
  auth: UrExtAuth;
  idempotency_key: string;
  currency: string;
  amount: string;
  to_account_id: string;
  recipient_binding?: string | null;
  permit_amount: string;
  permit_deadline: number;
  permit_v: number;
  permit_r: string;
  permit_s: string;
}

export interface UrTransferExecuteResponse {
  job: UrJobSummary;
  tx_hash?: string;
  via?: string;
  dispatch_error?: string;
  idempotent?: boolean;
}

export async function executeUrTransfer(
  accessToken: string,
  body: UrTransferExecuteRequest,
): Promise<UrTransferExecuteResponse> {
  const res = await api.post<UrTransferExecuteResponse>(
    '/ur/transfer/execute',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrP2pRecipient {
  id: string;
  recipient_ur_id: number;
  label: string;
  created_at?: string;
  last_used_at?: string;
}

export async function fetchUrTransferRecipients(
  accessToken: string,
): Promise<UrP2pRecipient[]> {
  const res = await api.get<{ recipients: UrP2pRecipient[] }>(
    '/ur/transfer/recipients',
    withAuth(accessToken),
  );
  return res.data.recipients ?? [];
}

export async function saveUrTransferRecipient(
  accessToken: string,
  body: { recipient_ur_id: string; label: string },
): Promise<UrP2pRecipient> {
  const res = await api.post<{ recipient: UrP2pRecipient }>(
    '/ur/transfer/recipients',
    body,
    withAuth(accessToken),
  );
  return res.data.recipient;
}

export async function deleteUrTransferRecipient(
  accessToken: string,
  recipientId: string,
): Promise<void> {
  await api.delete(`/ur/transfer/recipients/${recipientId}`, withAuth(accessToken));
}

// --------------------------------------------------------------------------- //
// KYC (Sumsub) — self-serve identity verification via wallet Full-Auth
//
// UR's Client-side KYC endpoints accept the same Full-Auth headers we sign for
// withdraw/payout (no partner whitelisting). Flow:
//   1. user signs Full-Auth (buildFullAuth)
//   2. POST /ur/kyc/status      -> current step + Sumsub review answer (gate UI)
//   3. POST /ur/kyc/sumsub-token -> { token "act-…" } for the Sumsub mobile SDK
//   4. launch the Sumsub SDK with the token (NFC scan = mobile only)
//   5. re-read /ur/kyc/status after the SDK closes
// --------------------------------------------------------------------------- //

/** KYC step machine: 0 UNKNOWN, 1 FormA, 2 IDScan, 3 SignFormA, 4 Review, 5 Rejected. */
export interface UrKycStatusResponse {
  ur_id: number;
  /** On-chain URID status (2 Tourist, 5 Live, …). */
  status: number | null;
  status_str: string | null;
  kyc_step: number | null;
  kyc_step_str: string | null;
  /** e.g. ["sumsub"], ["sign"] — what the current step needs. */
  kyc_action_types: string[];
  kyc_fail_reason: string;
  sumsub: {
    user_id?: string | null;
    completed?: boolean | null;
    review_status?: string | null;
    /** "GREEN" (pass) / "RED" (reject). */
    review_answer?: string | null;
    /** "RETRY" (user can resubmit) / "FINAL" (permanent). Empty until rejected. */
    review_reject_type?: string | null;
    /** Granular reject reasons, e.g. ["BAD_PROOF_OF_ADDRESS"]. */
    reject_labels?: string[] | null;
    /** Sumsub level that was reviewed, e.g. "Confirm your address V5.1 Form A". */
    level_name?: string | null;
  };
  crs_info?: { needCrs?: boolean; restrictDate?: number; url?: string } | null;
}

export async function fetchUrKycStatus(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrKycStatusResponse> {
  const res = await api.post<UrKycStatusResponse>('/ur/kyc/status', body, withAuth(accessToken));
  return res.data;
}

export interface UrSumsubTokenResponse {
  ur_id: number;
  /** Sumsub SDK access token, usually "act-…". */
  token: string;
  user_id?: string | null;
}

/**
 * Mint a Sumsub SDK access token. The backend mints it via the partner
 * by-network endpoint and resolves the URID from the authenticated caller, so
 * no wallet Full-Auth is needed here (the Privy session is the gate).
 */
export async function createUrSumsubToken(
  accessToken: string,
  body: { level_name?: string } = {},
): Promise<UrSumsubTokenResponse> {
  const res = await api.post<UrSumsubTokenResponse>('/ur/kyc/sumsub-token', body, withAuth(accessToken));
  return res.data;
}

export interface UrFormAInfoResponse {
  ur_id: number;
  /** The exact Form A declaration text to personal_sign (submit back verbatim). */
  text: string;
}

/**
 * Fetch the Form A declaration text for the final KYC step (SignFormA / step 3).
 * Requires wallet Full-Auth. The returned `text` must be signed and submitted
 * back byte-for-byte via `submitUrFormA`.
 */
export async function fetchUrFormA(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrFormAInfoResponse> {
  const res = await api.post<UrFormAInfoResponse>('/ur/kyc/form-a', body, withAuth(accessToken));
  return res.data;
}

/**
 * Submit the signed Form A (final KYC action, step 3 → Review). `text` must be
 * the exact string from `fetchUrFormA`; `signature` is the wallet's EIP-191
 * personal_sign over it. Tourist→Live still lands later via the kyc_status webhook.
 */
export async function submitUrFormA(
  accessToken: string,
  body: { auth: UrExtAuth; text: string; signature: string },
): Promise<{ ur_id: number; submitted: boolean }> {
  const res = await api.post<{ ur_id: number; submitted: boolean }>(
    '/ur/kyc/form-a/submit',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// Mint (URID) — lazy provisioning at banking/KYC entry.
//
// A URID must exist on-chain before KYC can start. `prepareUrMint` resolves
// idempotency (existing link / on-chain NFT) and, if a mint is needed, returns
// the EIP-191 message the Privy embedded wallet must sign. `submitUrMint` then
// finalizes the partner-signed mint and persists the Privy→URID link.
// --------------------------------------------------------------------------- //

export interface UrMintPrepareResponse {
  already_minted: boolean;
  ur_id?: number;
  /** Present only when a mint is required (already_minted === false). */
  evm_address?: string;
  hash?: string;
  deadline?: number;
  /** The exact EIP-191 message to personal_sign with the Privy embedded EOA. */
  message?: string;
}

export interface UrMintSubmitResponse {
  already_minted: boolean;
  ur_id: number;
  tx_hash?: string;
}

export async function prepareUrMint(
  accessToken: string,
  evmAddress: string,
): Promise<UrMintPrepareResponse> {
  const res = await api.post<UrMintPrepareResponse>(
    '/ur/mint/prepare',
    { evm_address: evmAddress },
    withAuth(accessToken),
  );
  return res.data;
}

export async function submitUrMint(
  accessToken: string,
  body: {
    evm_address: string;
    email: string;
    signature: string;
    hash: string;
    deadline: number;
  },
): Promise<UrMintSubmitResponse> {
  const res = await api.post<UrMintSubmitResponse>('/ur/mint', body, withAuth(accessToken));
  return res.data;
}

// --------------------------------------------------------------------------- //
// Card — eligibility, status (metadata + cardToken), freeze/unfreeze.
//
// All require wallet Full-Auth and a KYC-Live URID with an issued card; until
// then UR returns a Fiat24 404 which the backend maps to a read error. The
// client treats "no card" as a gate (cardAvailable=false) rather than an error.
// --------------------------------------------------------------------------- //

/** One UR limit bucket from `GET /api/v2/card` → `result.limits.*` (CHF). */
export interface UrCardLimit {
  used?: number;
  max?: number;
  available?: number;
  dailyUsed?: number;
  dailyMax?: number;
  dailyAvailable?: number;
  restartDate?: string;
  restartDateMs?: number;
}

/** Card limit buckets — account is rolling 30-day; others are channel sub-limits. */
export interface UrCardLimits {
  account?: UrCardLimit;
  withdrawal?: UrCardLimit;
  internetPurchase?: UrCardLimit;
  contactless?: UrCardLimit;
  [key: string]: UrCardLimit | undefined;
}

/** Device wallet link from UR (`activeTokens` on `GET /api/v2/card`). */
export interface UrCardActiveToken {
  id?: string;
  type?: string;
  createdAt?: string;
}

/** One issued card as UR returns it (fields are best-effort; UR may add more). */
export interface UrCard {
  cardTokenId?: string;
  cardToken?: string;
  /** Fiat24 card tokenId (top-level `tokenId`) — used for freeze/status. */
  tokenId?: string | number;
  /** Stable card management id from GET /api/v2/card — used for currency (§3.1.5). */
  externalId?: string;
  last4?: string;
  panLast4?: string;
  expiry?: string;
  status?: string | number;
  brand?: string;
  currency?: string;
  /** Supported spend currencies for this card (e.g. ["EUR","CHF","USD","RMB"]). */
  currencies?: string[];
  /** Embossed name, e.g. "zhan ai hua". */
  cardHolder?: string;
  /** UR card design code, e.g. "MSTDMNT". */
  cardDesign?: string;
  frozen?: boolean;
  /** Masked PAN/CVV/expiry, e.g. { cardNumber: "•••• 5083" }. */
  masked?: {
    cardNumber?: string;
    cvv2?: string;
    expiry?: string;
    card3DSecurePassword?: string;
  };
  /** Channel toggles from UR (contactless / internet / withdrawal). */
  security?: {
    withdrawalEnabled?: boolean;
    contactlessEnabled?: boolean;
    internetPurchaseEnabled?: boolean;
    overallLimitsEnabled?: boolean;
  };
  /** Server-authoritative limits (`GET /api/v2/card` → result.limits). */
  limits?: UrCardLimits;
  /** Linked mobile wallets (Apple Pay, Google Pay, …). */
  activeTokens?: UrCardActiveToken[];
  [key: string]: unknown;
}

export interface UrCardEligibilityResponse {
  ur_id: number;
  result: {
    /** MSTD = Fiat-Only, MSTC = Crypto-Backed. */
    debitCard?: string;
    isCardEligible?: boolean;
    cards?: UrCard[];
    cardActivation?: unknown;
    limits?: unknown;
    [key: string]: unknown;
  };
  permit_targets: {
    network: number;
    chain_id_caip2: string;
    card_spender: string;
    fiat_tokens: Record<string, string | null>;
  };
}

export interface UrCardStatusResponse {
  ur_id: number;
  result: UrCard & { cards?: UrCard[] };
}

export interface UrCardFreezeResponse {
  ur_id: number;
  frozen: boolean;
  status: number;
  result: Record<string, unknown>;
}

export async function fetchUrCardEligibility(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrCardEligibilityResponse> {
  const res = await api.post<UrCardEligibilityResponse>(
    '/ur/card/eligibility',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function fetchUrCardStatus(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrCardStatusResponse> {
  const res = await api.post<UrCardStatusResponse>(
    '/ur/card/status',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export async function setUrCardFrozen(
  accessToken: string,
  body: { auth: UrExtAuth; card_token_id: string; frozen: boolean },
): Promise<UrCardFreezeResponse> {
  const res = await api.post<UrCardFreezeResponse>(
    '/ur/card/freeze',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrCardCreateResponse {
  ur_id: number;
  result: Record<string, unknown>;
}

export interface UrCardCurrencyResponse {
  ur_id: number;
  currency: string;
  result: Record<string, unknown>;
}

/** Issue a new virtual card (UR §3.1.2). Requires KYC-Live + eligibility + a
 *  balance covering the activation fee. Mainnet-only per UR. */
export async function createUrCard(
  accessToken: string,
  body: { auth: UrExtAuth },
): Promise<UrCardCreateResponse> {
  const res = await api.post<UrCardCreateResponse>(
    '/ur/card/create',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

/** Set the card's default transaction currency (UR §3.1.5).
 *  `card_external_id` is `externalId` from card status, not the URID / cardTokenId. */
export async function setUrCardCurrency(
  accessToken: string,
  body: { auth: UrExtAuth; card_external_id: string; currency: string },
): Promise<UrCardCurrencyResponse> {
  const res = await api.post<UrCardCurrencyResponse>(
    '/ur/card/currency',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrCardPermitPrepareResponse {
  ur_id: number;
  permit: UrPayoutPermit;
}

/** EIP-2612 permit scaffold for card spend (UR `/api/v1/token-permit`). */
export async function prepareUrCardPermit(
  accessToken: string,
  body: { auth: UrExtAuth; currency: string; amount: string; owner_address: string },
): Promise<UrCardPermitPrepareResponse> {
  const res = await api.post<UrCardPermitPrepareResponse>(
    '/ur/card/permit/prepare',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

export interface UrCardPermitSubmitResponse {
  ur_id: number;
  result: Record<string, unknown>;
  tx_hash?: string;
}

export async function submitUrCardPermit(
  accessToken: string,
  body: {
    auth: UrExtAuth;
    currency: string;
    permit: {
      owner: string;
      spender: string;
      value: string;
      deadline: number;
      v: number;
      r: string;
      s: string;
    };
  },
): Promise<UrCardPermitSubmitResponse> {
  const res = await api.post<UrCardPermitSubmitResponse>(
    '/ur/card/permit',
    body,
    withAuth(accessToken),
  );
  return res.data;
}

// --------------------------------------------------------------------------- //
// Notification inbox (the bell feed on the Bank dashboard)
// --------------------------------------------------------------------------- //

/** Inbox tab buckets. KYC/compliance = system; money moves = transaction. */
export type UrNotificationCategory = 'transaction' | 'system';

export interface UrNotification {
  id: string;
  category: UrNotificationCategory;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface UrNotificationFeedResponse {
  notifications: UrNotification[];
  unreadCount: number;
}

/** List banking notifications (most recent first). `category` filters the tab. */
export async function fetchUrNotifications(
  accessToken: string,
  opts?: { category?: UrNotificationCategory; limit?: number },
): Promise<UrNotificationFeedResponse> {
  const params: Record<string, string | number> = {};
  if (opts?.category) params.category = opts.category;
  if (opts?.limit) params.limit = opts.limit;
  const res = await api.get<UrNotificationFeedResponse>('/notifications/feed', {
    ...withAuth(accessToken),
    params,
  });
  return res.data;
}

export async function fetchUrNotificationsUnreadCount(
  accessToken: string,
): Promise<number> {
  const res = await api.get<{ unreadCount: number }>(
    '/notifications/unread-count',
    withAuth(accessToken),
  );
  return res.data?.unreadCount ?? 0;
}

export async function markUrNotificationRead(
  accessToken: string,
  notificationId: string,
): Promise<number> {
  const res = await api.post<{ success: boolean; unreadCount: number }>(
    `/notifications/${notificationId}/read`,
    {},
    withAuth(accessToken),
  );
  return res.data?.unreadCount ?? 0;
}

export async function markAllUrNotificationsRead(
  accessToken: string,
): Promise<void> {
  await api.post('/notifications/read-all', {}, withAuth(accessToken));
}

// --------------------------------------------------------------------------- //
// Job polling
// --------------------------------------------------------------------------- //

export interface UrJobEnvelope {
  job: UrJobSummary;
}

/** Poll a single job by id. Used after submitting a deposit/withdraw. */
export async function fetchUrJob(
  accessToken: string,
  jobId: string,
): Promise<UrJobSummary> {
  const res = await api.get<UrJobEnvelope>(`/ur/jobs/${jobId}`, withAuth(accessToken));
  return res.data.job;
}

/** Job statuses that mean we can stop polling. */
export const UR_JOB_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

export function isUrJobTerminal(status: string | undefined | null): boolean {
  if (!status) return false;
  return UR_JOB_TERMINAL_STATUSES.has(status);
}

/**
 * Add Money sheet can dismiss once the source-chain tx is confirmed — we do
 * NOT wait for LayerZero / balance credit (that is tracked via the incoming
 * pill + Pending tx badge on the dashboard).
 */
export const UR_DEPOSIT_USER_SUCCESS_STATUSES = new Set<string>([
  'source_confirmed',
  'bridged',
  'completed',
]);

export function isUrDepositUserSuccess(status: string | undefined | null): boolean {
  if (!status) return false;
  return UR_DEPOSIT_USER_SUCCESS_STATUSES.has(status);
}

// --------------------------------------------------------------------------- //
// Normalisation helpers
// --------------------------------------------------------------------------- //

/**
 * Coerce UR balance shapes into a flat array. The legacy /v1/balance returns
 * an array directly; the Managed Custody /api/fma/v1/balance wraps it as
 * `{ fiatItems, cryptoItems }`. We accept both.
 */
export function normaliseBalance(raw: UrBalanceEnvelope['data']): UrBalanceItem[] {
  if (Array.isArray(raw)) return raw;
  const items: UrBalanceItem[] = [];
  const fiat = (raw as { fiatItems?: Array<{ currency?: string; amount?: string }> })
    ?.fiatItems;
  if (Array.isArray(fiat)) {
    for (const f of fiat) {
      if (f?.currency && f?.amount != null) {
        items.push({
          symbol: normalizeFiatSymbol(f.currency),
          amount: String(f.amount),
        });
      }
    }
  }
  const crypto = (raw as { cryptoItems?: Array<{ coin?: string; amount?: string }> })
    ?.cryptoItems;
  if (Array.isArray(crypto)) {
    for (const c of crypto) {
      if (c?.coin && c?.amount != null) {
        items.push({ symbol: c.coin, amount: String(c.amount) });
      }
    }
  }
  return items;
}

const FIAT_SYMBOLS = new Set([
  'USD',
  'EUR',
  'CHF',
  'GBP',
  'JPY',
  'CNH',
  'SGD',
  'HKD',
  'AUD',
  'CAD',
]);

/** Cash tab carousel order (USD first, then CHF, EUR, CNH, …). */
const CASH_TAB_CURRENCY_ORDER = [
  'USD',
  'CHF',
  'EUR',
  'CNH',
  'GBP',
  'JPY',
  'SGD',
  'HKD',
  'AUD',
  'CAD',
];

function cashTabCurrencyIndex(code: string): number {
  const idx = CASH_TAB_CURRENCY_ORDER.indexOf(code.toUpperCase());
  return idx === -1 ? CASH_TAB_CURRENCY_ORDER.length : idx;
}

/** UR on-chain tokens use a `24` suffix (USD24). Strip for display/sort keys. */
export function normalizeFiatSymbol(symbol: string): string {
  const c = (symbol || '').toUpperCase();
  return c.endsWith('24') && c.length > 2 ? c.slice(0, -2) : c;
}

export function isFiatSymbol(symbol: string): boolean {
  return FIAT_SYMBOLS.has(normalizeFiatSymbol(symbol));
}

export function parseAmount(amount: string): number {
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Merge balances with bank accounts into the per-currency rows we render in
 * the Cash tab. Each row may have either a balance, an IBAN, or both.
 * Sorted by balance DESC (native amount), then carousel default order, then code.
 */
export interface CashAccountRow {
  currency: string;
  amount: number;
  amountStr: string;
  bankAccounts: UrBankAccount[];
}

export function buildCashAccountRows(
  balance: UrBalanceItem[],
  bankAccounts: Record<string, UrBankAccount[]> = {},
): CashAccountRow[] {
  const byCurrency = new Map<string, CashAccountRow>();

  for (const item of balance) {
    const code = normalizeFiatSymbol(item.symbol);
    if (!isFiatSymbol(code)) continue;
    byCurrency.set(code, {
      currency: code,
      amount: parseAmount(item.amount),
      amountStr: item.amount,
      bankAccounts: [],
    });
  }

  for (const [code, accs] of Object.entries(bankAccounts || {})) {
    const upper = normalizeFiatSymbol(code);
    if (!byCurrency.has(upper)) {
      byCurrency.set(upper, {
        currency: upper,
        amount: 0,
        amountStr: '0.00',
        bankAccounts: [],
      });
    }
    byCurrency.get(upper)!.bankAccounts = Array.isArray(accs) ? accs : [];
  }

  return Array.from(byCurrency.values()).sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    const orderA = cashTabCurrencyIndex(a.currency);
    const orderB = cashTabCurrencyIndex(b.currency);
    if (orderA !== orderB) return orderA - orderB;
    return a.currency.localeCompare(b.currency);
  });
}

/** Default "from" currency for Convert / Withdraw / Send — highest balance first. */
export function defaultFromCurrency(
  rows: Array<{ currency: string; amount: number }>,
): string {
  return (
    rows.find((r) => r.amount > 0)?.currency ??
    rows[0]?.currency ??
    'USD'
  );
}

/** Source-currency options for bank payout (Send). UR §6 only wires EUR/CHF/USD/CNH
 *  (see `/banks/payout/fees` + `/v2/br` `contacts` keys) — not every IBAN balance. */
export function buildPayoutCurrencyOptions(
  cashRows: CashAccountRow[],
  payoutCurrencies: UrPayoutCurrencyConfig[],
): { currency: string; amount: number; amountStr: string }[] {
  const supported = new Set(payoutCurrencies.map((c) => c.currency.toUpperCase()));
  const seen = new Set<string>();
  const opts: { currency: string; amount: number; amountStr: string }[] = [];

  for (const row of cashRows) {
    if (!supported.has(row.currency) || seen.has(row.currency)) continue;
    seen.add(row.currency);
    opts.push({
      currency: row.currency,
      amount: row.amount,
      amountStr: row.amountStr,
    });
  }

  for (const cfg of payoutCurrencies) {
    const code = cfg.currency.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    const row = cashRows.find((r) => r.currency === code);
    opts.push({
      currency: code,
      amount: row?.amount ?? 0,
      amountStr: row?.amountStr ?? '0.00',
    });
  }

  return opts;
}
