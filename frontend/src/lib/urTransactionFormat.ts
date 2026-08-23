/**
 * Normalise raw UR /v1/transactions payloads into display-friendly strings.
 *
 * QA payloads often ship technical titles (e.g. "usd", "eip155:421614") until
 * UR backfills listingTitle — we infer readable copy from type, token, and chain.
 */
import type { TFunction } from 'i18next';
import type { UrNotification, UrTransaction } from './urApi';
import { colors } from '../theme/colors';

const CHAIN_LABELS: Record<number, string> = {
  1: 'Ethereum',
  42161: 'Arbitrum',
  421614: 'Arbitrum Sepolia',
  5000: 'Mantle',
  5003: 'Mantle Sepolia',
};

const TYPE_I18N_KEY: Record<string, string> = {
  CTU: 'cash.txTypeCtu',
  CTF: 'cash.txTypeCtf',
  FRX: 'cash.txTypeFrx',
  PAY: 'cash.txTypePay',
  PIN: 'cash.txTypePin',
  POU: 'cash.txTypePou',
  CSH: 'cash.txTypeCsh',
  /** CTF OUT — fiat → USDC withdraw (UR "cash to crypto"). */
  CTF_OUT: 'cash.txTypeCtfOut',
};

export function parseChainId(chainId?: string): number | null {
  if (!chainId?.trim()) return null;
  const match = chainId.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function getChainLabel(chainId?: string): string | null {
  const id = parseChainId(chainId);
  if (id == null) return null;
  return CHAIN_LABELS[id] ?? null;
}

export function normalizeCurrency(raw?: string): string {
  if (!raw?.trim()) return '';
  let value = raw.trim();
  if (value.includes('/')) {
    value = value.split('/').pop() ?? value;
  }
  value = value.replace(/24$/i, '').toUpperCase();
  return value;
}

export function getTokenSymbol(tx: UrTransaction): string {
  if (isFrxTransaction(tx)) {
    if (tx.direction === 'IN') {
      return (
        normalizeCurrency(tx.currency) ||
        normalizeCurrency(tx.token) ||
        normalizeCurrency(tx.outputToken)
      );
    }
    // Debit leg: `token` / `outputToken` hold the received currency, not the debited one.
    return resolveFrxDebitCurrency(tx);
  }
  const type = (tx.type ?? '').trim().toUpperCase();
  if (type === 'CTU' && (tx.direction ?? '').toUpperCase() === 'IN') {
    // Add Money credits fiat; `token` / `inputToken` are the source crypto.
    return (
      normalizeCurrency(tx.currency) ||
      normalizeCurrency(tx.outputToken) ||
      normalizeCurrency(tx.token)
    );
  }
  return (
    normalizeCurrency(tx.token) ||
    normalizeCurrency(tx.inputToken) ||
    normalizeCurrency(tx.currency)
  );
}

function resolveFrxCounterCurrency(tx: UrTransaction): string {
  const debitCurrency = resolveFrxDebitCurrency(tx);
  const candidates = [
    normalizeCurrency(tx.outputToken),
    normalizeCurrency(tx.token),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== debitCurrency) return candidate;
  }
  return '';
}

function isRawTechnicalText(value?: string): boolean {
  if (!value?.trim()) return true;
  const v = value.trim();
  if (/^eip155:\d+/i.test(v)) return true;
  if (/^0x[a-f0-9]{8,}$/i.test(v)) return true;
  if (/^[a-z]{2,4}$/i.test(v)) {
    const lower = v.toLowerCase();
    if (['usd', 'eur', 'chf', 'gbp', 'cnh', 'sgd', 'hkd', 'jpy', 'usdc', 'usdt'].includes(lower)) {
      return true;
    }
    if (['ctu', 'ctf', 'frx', 'pay', 'pin', 'pou', 'csh'].includes(lower)) {
      return true;
    }
  }
  return false;
}

export function hasTxProof(tx: UrTransaction): boolean {
  return Boolean(tx.txHash?.trim() || tx.txHashUrl?.trim());
}

export function formatTxHashShort(hash?: string): string {
  if (!hash?.trim()) return '';
  const h = hash.trim();
  if (h.length <= 14) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function pickAmountRaw(tx: UrTransaction): string {
  const amount = (tx.amount ?? '').trim();
  const input = (tx.inputAmount ?? '').trim();
  if (!input) return amount;

  const amtN = Number.parseFloat(amount.replace(/[^0-9.-]/g, ''));
  const inN = Number.parseFloat(input.replace(/[^0-9.-]/g, ''));
  // UR sometimes indexes a $100 cash-out as amount "-100" while inputAmount
  // carries the human decimal. If amount looks like a bad /100 misread of
  // inputAmount, prefer inputAmount for display.
  if (
    Number.isFinite(amtN) &&
    Number.isFinite(inN) &&
    Math.abs(inN) >= 1 &&
    Math.abs(amtN) > 0 &&
    Math.abs(amtN) < Math.abs(inN) * 0.05
  ) {
    return input;
  }
  return amount;
}

function parseDisplayAmountMagnitude(raw: string, numeric: number): number {
  const abs = Math.abs(numeric);
  if (!Number.isFinite(numeric) || Number.isNaN(numeric)) {
    return 0;
  }
  // UR major-unit strings include a decimal (e.g. "100.00"). Bare integers
  // below 10_000 are treated as dollars — avoids mapping withdraw "-100"
  // to $1.00. Values >= 10_000 without a dot are treated as cents.
  if (!raw.includes('.') && Number.isInteger(numeric) && abs >= 10_000) {
    return abs / 100;
  }
  return abs;
}

export function formatDisplayAmount(tx: UrTransaction): { signed: string; currency: string } {
  const currency = getTokenSymbol(tx);
  const raw = pickAmountRaw(tx);
  const numeric = Number.parseFloat(raw.replace(/[^0-9.-]/g, ''));

  let display: string;
  if (!Number.isNaN(numeric)) {
    const value = parseDisplayAmountMagnitude(raw, numeric);
    display = value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else {
    display = raw.replace(/^[+-]/, '') || '0.00';
  }

  if (/^[+-]/.test(raw)) {
    return { signed: `${raw[0]}${display}`, currency };
  }
  const sign = tx.direction === 'IN' ? '+' : '-';
  return { signed: `${sign}${display}`, currency };
}

export function isTxPending(tx: UrTransaction): boolean {
  const status = (tx.status ?? '').trim().toLowerCase();
  return status === 'pending' || status === 'processing';
}

/** Teal inflows, purple outflows — matches deposit-withdraw-history. */
export function resolveTxDirectionColor(tx: UrTransaction): string {
  if (isTxPending(tx)) return colors.text.tertiary;
  return tx.direction === 'IN' ? colors.accent.gold : colors.accent.purple;
}

/**
 * Display name for a P2P (HyperTrade user transfer) counterparty: the saved
 * label when present, else "Account 12345" parsed from the backend-resolved
 * URID or any leftover free-text, else a generic fallback.
 */
function p2pCounterpartyName(tx: UrTransaction, t: TFunction): string {
  const label = tx.counterpartyName?.trim();
  if (label) return label;
  const id = (tx.counterpartyUrId ?? '').toString().trim();
  if (id) return t('cash.p2pAccount', { id });
  for (const s of [tx.subtitle, tx.title, tx.listingTitle]) {
    const m = String(s ?? '').match(/(\d{5,})/);
    if (m) return t('cash.p2pAccount', { id: m[1] });
  }
  return t('cash.p2pUser');
}

export function resolveTxTitle(tx: UrTransaction, t: TFunction): string {
  // P2P wins over UR's raw title so it always reads "Sent to / Received from".
  if ((tx.type ?? '').trim().toUpperCase() === 'P2P') {
    const name = p2pCounterpartyName(tx, t);
    return tx.direction === 'IN'
      ? t('cash.txTypeP2pIn', { name })
      : t('cash.txTypeP2pOut', { name });
  }
  if (tx.listingTitle?.trim() && !isRawTechnicalText(tx.listingTitle)) {
    return tx.listingTitle.trim();
  }
  if (tx.title?.trim() && !isRawTechnicalText(tx.title)) {
    return tx.title.trim();
  }
  const type = (tx.type ?? '').trim().toUpperCase();
  if (type === 'CTF' && tx.direction === 'OUT') {
    return t(TYPE_I18N_KEY.CTF_OUT);
  }
  const key = TYPE_I18N_KEY[tx.type];
  if (key) {
    return t(key);
  }
  return t('cash.txTypeDefault', { type: tx.type || '—' });
}

export function resolveTxSubtitle(tx: UrTransaction, t: TFunction): string {
  if ((tx.type ?? '').trim().toUpperCase() === 'P2P') {
    return t('cash.txSubtitleP2p');
  }
  if (tx.subtitle?.trim() && !isRawTechnicalText(tx.subtitle)) {
    return tx.subtitle.trim();
  }

  const chain = getChainLabel(tx.chainId);
  const token = getTokenSymbol(tx);

  switch (tx.type) {
    case 'CTU': {
      const sourceToken =
        normalizeCurrency(tx.inputToken) || normalizeCurrency(tx.token);
      if (sourceToken && chain) {
        return t('cash.txSubtitleCtu', { token: sourceToken, chain });
      }
      break;
    }
    case 'CTF':
      if (token && chain) return t('cash.txSubtitleCtf', { token, chain });
      break;
    case 'PIN':
      return t('cash.txSubtitleBankDeposit');
    case 'POU':
      return t('cash.txSubtitleBankPayout');
    case 'FRX': {
      const counter = resolveFrxCounterCurrency(tx);
      if (tx.direction === 'IN') {
        const fromCurrency = normalizeCurrency(tx.inputToken);
        const received = token || counter;
        if (fromCurrency && received) {
          return t('cash.txSubtitleFxReceived', { currency: received, fromCurrency });
        }
      } else if (counter) {
        return t('cash.txSubtitleFxSent', { currency: counter });
      }
      return t('cash.txSubtitleFx');
    }
    case 'PAY':
      return t('cash.txSubtitleCardPayment');
    default:
      break;
  }

  if (tx.fromAddress) {
    return t('cash.txSubtitleFrom', {
      address: `${tx.fromAddress.slice(0, 6)}…${tx.fromAddress.slice(-4)}`,
    });
  }
  if (chain) return chain;
  if (hasTxProof(tx)) {
    return t('cash.txViewOnChain');
  }
  return '';
}

export function resolveTxStatus(tx: UrTransaction, t: TFunction): string {
  const status = (tx.status ?? '').trim().toLowerCase();
  if (status === 'completed' || status === 'success') return t('cash.txStatusCompleted');
  if (status === 'pending' || status === 'processing') return t('cash.txStatusPending');
  if (status === 'failed' || status === 'error') return t('cash.txStatusFailed');
  return tx.status;
}

export function resolveTxStatusTone(
  tx: UrTransaction,
): 'success' | 'warning' | 'danger' | 'neutral' {
  const status = (tx.status ?? '').trim().toLowerCase();
  if (status === 'completed' || status === 'success') return 'success';
  if (status === 'pending' || status === 'processing') return 'warning';
  if (status === 'failed' || status === 'error') return 'danger';
  return 'neutral';
}

export function getTxTypeIcon(
  tx: UrTransaction,
): 'cash-outline' | 'wallet-outline' | 'swap-horizontal-outline' | 'card-outline' | 'business-outline' | 'arrow-up-circle-outline' | 'arrow-down-outline' | 'arrow-up-outline' | 'arrow-down-circle' | 'arrow-up-circle' | 'download' | 'send-outline' {
  const map = {
    CTU: 'cash-outline',
    CTF: 'wallet-outline',
    FRX: 'swap-horizontal-outline',
    PAY: 'card-outline',
    CRD: 'card-outline',
    PIN: 'business-outline',
    POU: 'arrow-up-circle-outline',
    CSH: 'cash-outline',
  } as const;
  const type = (tx.type ?? '').trim().toUpperCase();
  if (type === 'P2P') return tx.direction === 'IN' ? 'arrow-down-circle' : 'send-outline';
  return map[type as keyof typeof map] ?? (tx.direction === 'IN' ? 'arrow-down-outline' : 'arrow-up-outline');
}

/** True for outgoing P2P / send icons that use the rotated paper-plane affordance. */
export function isSendTxIcon(icon: ReturnType<typeof getTxTypeIcon>): boolean {
  return icon === 'send-outline';
}

function isFrxTransaction(tx: UrTransaction): boolean {
  return (tx.type ?? '').trim().toUpperCase() === 'FRX';
}

function parseHumanAmount(raw?: string): number | null {
  if (!raw?.trim()) return null;
  const numeric = Number.parseFloat(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function formatHumanAmount(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function resolveFrxDebitCurrency(tx: UrTransaction): string {
  const input = normalizeCurrency(tx.inputToken);
  const currency = normalizeCurrency(tx.currency);
  const creditCandidate =
    normalizeCurrency(tx.outputToken) || normalizeCurrency(tx.token);
  // UR / enrichment sometimes labels the debit row with the received currency.
  if (input && creditCandidate && currency === creditCandidate && input !== creditCandidate) {
    return input;
  }
  return currency || input;
}

/** Keep output side on `outputToken` so debit display stays on source currency. */
function normalizeFrxDebitLeg(tx: UrTransaction): UrTransaction {
  const debitCurrency = resolveFrxDebitCurrency(tx);
  const creditCurrency = resolveFrxCounterCurrency(tx);
  if (!debitCurrency && !creditCurrency) return tx;

  const normalized: UrTransaction = { ...tx };
  if (creditCurrency) {
    normalized.outputToken = creditCurrency;
    if (normalizeCurrency(tx.token) === creditCurrency) {
      delete normalized.token;
    }
  }
  if (debitCurrency && !normalizeCurrency(normalized.currency)) {
    normalized.currency = debitCurrency;
  }
  if (debitCurrency && !normalizeCurrency(normalized.inputToken)) {
    normalized.inputToken = debitCurrency;
  }
  return normalized;
}

function resolveFrxCreditCurrency(tx: UrTransaction): string {
  return resolveFrxCounterCurrency(tx);
}

function buildFrxCreditLeg(debit: UrTransaction): UrTransaction | null {
  const debitCurrency = resolveFrxDebitCurrency(debit);
  const creditCurrency = resolveFrxCreditCurrency(debit);
  const creditAmount = parseHumanAmount(debit.outputAmount);
  if (!debitCurrency || !creditCurrency || creditAmount == null || creditAmount <= 0) {
    return null;
  }

  const txHash = debit.txHash?.trim() || `frx-${debit.timestamp}`;
  return {
    ...debit,
    displayId: `${txHash}:frx-credit`,
    direction: 'IN',
    currency: creditCurrency,
    token: creditCurrency,
    amount: `+${formatHumanAmount(creditAmount)}`,
    inputToken: debitCurrency,
    inputAmount: debit.inputAmount ?? debit.amount.replace(/^[+-]/, ''),
    outputAmount: undefined,
    outputToken: undefined,
    timestamp: debit.timestamp + 1,
  };
}

function compareTransactionsForDisplay(a: UrTransaction, b: UrTransaction): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  if (isFrxTransaction(a) && isFrxTransaction(b) && a.txHash && a.txHash === b.txHash) {
    if (a.direction === 'IN' && b.direction === 'OUT') return -1;
    if (a.direction === 'OUT' && b.direction === 'IN') return 1;
  }
  const aKey = a.displayId ?? `${a.txHash}:${a.direction}:${a.currency}`;
  const bKey = b.displayId ?? `${b.txHash}:${b.direction}:${b.currency}`;
  return aKey.localeCompare(bKey);
}

/**
 * UR often returns a single FRX row (the debited currency). Expand each convert
 * into debit + credit legs so history shows both sides, with the credit first.
 */
/**
 * In-flight fiat credits surfaced on currency cards (+X incoming pill).
 * Maps to UR transaction types — only `deposit` uses the CTU synthetic-row pipeline.
 */
export type IncomingCreditKind =
  | 'deposit' // CTU IN — digital Add Money (USDC → fiat24)
  | 'convert' // FRX — in-app FX swap
  | 'transfer' // P2P IN — HyperTrade URID → URID received
  | 'payin' // PIN IN — bank wire to IBAN
  | 'card_refund'; // CRD/PAY IN — card refund / reversal

export type PendingIncomingDepositHint = {
  currency: string;
  amount: number;
  startedAt: number;
  sourceTxHash?: string;
  legTxHashes?: string[];
  kind?: IncomingCreditKind;
};

/** @deprecated Alias — prefer PendingIncomingDepositHint until call sites rename. */
export type PendingIncomingHint = PendingIncomingDepositHint;

/** UR `/v1/transactions` type for each incoming credit kind (reference). */
export const INCOMING_CREDIT_TX_TYPE: Record<IncomingCreditKind, string> = {
  deposit: 'CTU',
  convert: 'FRX',
  transfer: 'P2P',
  payin: 'PIN',
  card_refund: 'CRD',
};

/** Only digital Add Money uses synthetic CTU rows + CTU status overlay. */
export function incomingKindUsesCtuPipeline(
  kind: IncomingCreditKind | undefined,
): boolean {
  return (kind ?? 'deposit') === 'deposit';
}

/** Map banking inbox notification types → incoming credit kind (passive inflows). */
export function incomingKindFromNotificationType(
  type: string,
): IncomingCreditKind | null {
  switch ((type || '').trim().toLowerCase()) {
    case 'payin':
      return 'payin';
    case 'transfer_in':
      return 'transfer';
    case 'card_refund':
      return 'card_refund';
    default:
      return null;
  }
}

function parseNotificationAmount(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.abs(n) : null;
}

/** Parse amount/currency from UR webhook-driven inbox rows (pay-in, P2P in, card refund). */
export function parsePassiveIncomingNotification(
  n: UrNotification,
): { currency: string; amount: number; kind: IncomingCreditKind; sourceTxHash?: string } | null {
  const kind = incomingKindFromNotificationType(n.type);
  if (!kind) return null;
  const data = n.data ?? {};
  const currency = String(data.currency ?? '')
    .trim()
    .toUpperCase()
    .replace(/24$/i, '');
  const amount = parseNotificationAmount(data.amount);
  if (!currency || amount == null) return null;
  const txHash =
    typeof data.txHash === 'string' && data.txHash.trim()
      ? data.txHash.trim()
      : undefined;
  return { currency, amount, kind, sourceTxHash: txHash };
}

/** Stable key for per-deposit watch / dedupe (not per-currency). */
export function depositIncomingWatchKey(hint: {
  currency: string;
  startedAt: number;
  sourceTxHash?: string;
}): string {
  const hash = (hint.sourceTxHash ?? '').trim().toLowerCase();
  if (hash) return hash;
  return `${hint.currency.toUpperCase()}:${hint.startedAt}`;
}

function parseTxCreditAmount(tx: UrTransaction): number | null {
  const type = (tx.type ?? '').trim().toUpperCase();
  const dir = (tx.direction ?? '').trim().toUpperCase();
  // CTU IN credits fiat — `inputAmount` is gross source crypto (e.g. USDC).
  const raw =
    type === 'CTU' && dir === 'IN'
      ? tx.outputAmount ?? tx.amount ?? tx.inputAmount ?? '0'
      : tx.inputAmount ?? tx.amount ?? '0';
  const n = Number.parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/** Backend synth rows carry source crypto; bare UR destination rows often do not. */
function depositRowHasSourceMetadata(tx: UrTransaction): boolean {
  const src = normalizeCurrency(tx.inputToken);
  if (!src) return false;
  return src === 'USDC' || src === 'USDT' || src === 'ETH';
}

export function depositTxMatchesPendingIncoming(
  tx: UrTransaction,
  pending: PendingIncomingDepositHint,
): boolean {
  const txType = (tx.type ?? '').trim().toUpperCase();
  const txDir = (tx.direction ?? '').trim().toUpperCase();
  if (txType !== 'CTU' || txDir !== 'IN') return false;

  const txCcy = (tx.currency ?? '').toUpperCase().replace(/24$/i, '');
  const pendCcy = pending.currency.toUpperCase();
  if (txCcy && pendCcy && txCcy !== pendCcy) return false;

  const txHash = (tx.txHash ?? '').trim().toLowerCase();
  const srcHash = (pending.sourceTxHash ?? '').trim().toLowerCase();
  const legHashes = (pending.legTxHashes ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (txHash) {
    if (srcHash && txHash === srcHash) return true;
    if (legHashes.includes(txHash)) return true;
    // Cross-chain: UR indexes the Mantle mint hash while we store the Arbitrum
    // source hash — fall through to amount + time (mirrors backend
    // `_ur_tx_matches_job`).
  }

  const txTs = tx.timestamp ?? 0;
  const startedSec = Math.floor(pending.startedAt / 1000);
  if (txTs < startedSec - 60) return false;
  if (txTs > startedSec + 15 * 60) return false;

  const txAmt = parseTxCreditAmount(tx);
  if (txAmt == null) return false;
  const tol = Math.max(0.02, pending.amount * 0.02);
  if (Math.abs(txAmt - pending.amount) > tol) return false;

  return true;
}

const DEPOSIT_DEDUPE_WINDOW_SEC = 15 * 60;

/** True when two CTU IN rows are the same Add Money credit (source vs dest chain hash). */
export function depositCtuRowsRepresentSameCredit(
  a: UrTransaction,
  b: UrTransaction,
): boolean {
  const aType = (a.type ?? '').trim().toUpperCase();
  const bType = (b.type ?? '').trim().toUpperCase();
  if (aType !== 'CTU' || bType !== 'CTU') return false;
  if ((a.direction ?? '').toUpperCase() !== 'IN') return false;
  if ((b.direction ?? '').toUpperCase() !== 'IN') return false;

  const aHash = (a.txHash ?? '').trim().toLowerCase();
  const bHash = (b.txHash ?? '').trim().toLowerCase();
  if (aHash && bHash && aHash === bHash) return true;

  // Two different on-chain txs with source-side metadata are distinct user
  // deposits (e.g. two +14.95 USD back-to-back) — never collapse on amount alone.
  if (aHash && bHash && aHash !== bHash) {
    const aSrc = depositRowHasSourceMetadata(a);
    const bSrc = depositRowHasSourceMetadata(b);
    if (aSrc && bSrc) return false;

    // Cross-chain duplicate: our job synth (source hash + USDC fields) plus UR's
    // destination-chain row for the same hop.
    if (aSrc === bSrc) return false;

    const aCcy = (a.currency ?? '').toUpperCase().replace(/24$/i, '');
    const bCcy = (b.currency ?? '').toUpperCase().replace(/24$/i, '');
    if (!aCcy || !bCcy || aCcy !== bCcy) return false;

    const aAmt = parseTxCreditAmount(a);
    const bAmt = parseTxCreditAmount(b);
    if (aAmt == null || bAmt == null) return false;
    const tol = Math.max(0.02, Math.max(aAmt, bAmt) * 0.02);
    if (Math.abs(aAmt - bAmt) > tol) return false;

    const aTs = a.timestamp ?? 0;
    const bTs = b.timestamp ?? 0;
    if (Math.abs(aTs - bTs) > DEPOSIT_DEDUPE_WINDOW_SEC) return false;

    return true;
  }

  return false;
}

function depositCtuRowRank(tx: UrTransaction): number {
  const status = (tx.status ?? '').trim().toLowerCase();
  let rank = 0;
  if (status === 'completed' || status === 'complete') rank += 100;
  else if (status === 'pending' || status === 'processing') rank += 50;
  if (normalizeCurrency(tx.inputToken)) rank += 10;
  if (tx.outputAmount?.trim()) rank += 5;
  if (tx.displayId?.startsWith('local-deposit-')) rank -= 20;
  return rank;
}

function pickPreferredDepositCtuRow(
  a: UrTransaction,
  b: UrTransaction,
): UrTransaction {
  const ra = depositCtuRowRank(a);
  const rb = depositCtuRowRank(b);
  if (ra !== rb) return ra > rb ? a : b;
  return (a.timestamp ?? 0) >= (b.timestamp ?? 0) ? a : b;
}

/**
 * Collapse duplicate CTU IN rows for the same Add Money credit. The backend
 * synthesises source-chain rows while UR's indexer may also surface the Mantle
 * destination row — both can appear in one fetch.
 */
export function dedupeDepositCtuTransactions(txs: UrTransaction[]): UrTransaction[] {
  if (txs.length < 2) return txs;

  const keep = txs.map(() => true);
  for (let i = 0; i < txs.length; i++) {
    if (!keep[i]) continue;
    const a = txs[i];
    if ((a.type ?? '').trim().toUpperCase() !== 'CTU') continue;
    if ((a.direction ?? '').trim().toUpperCase() !== 'IN') continue;

    for (let j = i + 1; j < txs.length; j++) {
      if (!keep[j]) continue;
      const b = txs[j];
      if (!depositCtuRowsRepresentSameCredit(a, b)) continue;
      const preferred = pickPreferredDepositCtuRow(a, b);
      if (preferred === a) keep[j] = false;
      else keep[i] = false;
    }
  }

  if (keep.every(Boolean)) return txs;
  return txs.filter((_, idx) => keep[idx]);
}

/**
 * While an Add Money credit is still in-flight (incoming pill visible), keep
 * the matching CTU row at pending even if UR / our job reconciler already
 * marked the source-chain tx complete.
 */
export function overlayPendingIncomingDepositStatus(
  txs: UrTransaction[],
  pendingIncoming: Record<string, PendingIncomingDepositHint>,
): UrTransaction[] {
  if (!txs.length || !Object.keys(pendingIncoming).length) return txs;

  return txs.map((tx) => {
    if ((tx.type ?? '').trim().toUpperCase() !== 'CTU') return tx;
    if ((tx.direction ?? '').trim().toUpperCase() !== 'IN') return tx;

    const ccy = (tx.currency ?? '').toUpperCase().replace(/24$/i, '');
    const pending = pendingIncoming[ccy];
    if (!pending || !incomingKindUsesCtuPipeline(pending.kind)) return tx;
    if (!depositTxMatchesPendingIncoming(tx, pending)) return tx;

    const status = (tx.status ?? '').trim().toLowerCase();
    if (status === 'failed' || status === 'error') return tx;
    // Never regress a settled row — a new same-amount deposit must not re-pend the old one.
    if (status === 'completed' || status === 'complete') return tx;

    return { ...tx, status: 'pending' };
  });
}

/** After the incoming pill clears, keep matching CTU rows at pending until UR
 *  / reconcile marks them completed (prevents a flash of "completed" then
 *  disappearance when the indexer lags). */
export function overlayClearedDepositWatchStatus(
  txs: UrTransaction[],
  watch: Record<string, PendingIncomingDepositHint>,
): UrTransaction[] {
  if (!txs.length || !Object.keys(watch).length) return txs;

  const entries = Object.values(watch).filter((e) =>
    incomingKindUsesCtuPipeline(e.kind),
  );
  if (!entries.length) return txs;

  return txs.map((tx) => {
    if ((tx.type ?? '').trim().toUpperCase() !== 'CTU') return tx;
    if ((tx.direction ?? '').trim().toUpperCase() !== 'IN') return tx;

    const ccy = (tx.currency ?? '').toUpperCase().replace(/24$/i, '');
    const entry = entries.find(
      (e) =>
        e.currency.toUpperCase() === ccy &&
        depositTxMatchesPendingIncoming(tx, e),
    );
    if (!entry) return tx;

    const status = (tx.status ?? '').trim().toLowerCase();
    if (status === 'failed' || status === 'error') return tx;
    if (status === 'completed' || status === 'complete') return tx;

    return { ...tx, status: 'pending' };
  });
}

export function expandUrTransactionsForDisplay(txs: UrTransaction[]): UrTransaction[] {
  if (!txs.length) return txs;

  const creditLegKeys = new Set<string>();
  for (const tx of txs) {
    if (isFrxTransaction(tx) && tx.direction === 'IN' && tx.txHash) {
      creditLegKeys.add(tx.txHash);
    }
  }

  const expanded: UrTransaction[] = [];
  for (const tx of txs) {
    if (!isFrxTransaction(tx)) {
      expanded.push(tx);
      continue;
    }

    if (tx.direction === 'IN') {
      expanded.push(tx);
      continue;
    }

    const debit = normalizeFrxDebitLeg(tx);
    expanded.push(debit);
    if (debit.txHash && creditLegKeys.has(debit.txHash)) continue;

    const credit = buildFrxCreditLeg(debit);
    if (credit) {
      expanded.push(credit);
      if (credit.txHash) creditLegKeys.add(credit.txHash);
    }
  }

  return [...expanded].sort(compareTransactionsForDisplay);
}

export function getUrTransactionRowKey(tx: UrTransaction, index: number): string {
  return tx.displayId ?? `${tx.txHash || 'tx'}-${tx.direction}-${tx.currency}-${index}`;
}
