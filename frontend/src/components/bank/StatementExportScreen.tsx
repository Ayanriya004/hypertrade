/**
 * Account statement export — period filters, currency selection, PDF download.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import Toast from 'react-native-toast-message';
import { colors } from '../../theme/colors';
import { useAuth } from '../../providers/AuthContext';
import { useUrAccount } from '../../providers/UrAccountProvider';
import { formatPaymentReference } from './AccountInfoSheet';
import {
  exportUrStatementPdf,
  previewUrStatement,
  type UrStatementDirection,
  type UrStatementPreviewResponse,
  type UrStatementScope,
} from '../../lib/urApi';
import {
  addMonths,
  formatMonthYearNumeric,
  formatStatementPeriodRange,
  presetRange,
  rangeFromMonths,
  STATEMENT_CURRENCY_OPTIONS,
  sortStatementCurrencies,
  type MonthYear,
  type StatementPreset,
  validateStatementRange,
} from '../../lib/urStatement';
import { shareStatementPdf } from '../../lib/urStatementShare';
import { CircleCurrencyFlag } from './CircleCountryFlag';

const PRESETS: StatementPreset[] = ['1m', '3m', '6m', '1y', 'custom'];

/** Custom month stepper — implemented but hidden from UI until we ship it. */
const STATEMENT_CUSTOM_PERIOD_ENABLED = false;

const VISIBLE_PRESETS = PRESETS.filter(
  (p) => p !== 'custom' || STATEMENT_CUSTOM_PERIOD_ENABLED,
);

const STATEMENT_FIAT_SET = new Set<string>(STATEMENT_CURRENCY_OPTIONS);

/** Same charcoal-blue as homepage account cards (`app/index.tsx`). */
const HOMEPAGE_CARD_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;
const EXPORT_GRADIENT = [colors.accent.gold, colors.accent.purple] as const;
const EXPORT_GRADIENT_DISABLED = [colors.background.tertiary, colors.background.tertiary] as const;

function MonthStepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: MonthYear;
  onChange: (next: MonthYear) => void;
}) {
  return (
    <View style={styles.stepperBlock}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperRow}>
        <TouchableOpacity
          style={styles.stepperBtn}
          onPress={() => onChange(addMonths(value, -1))}
          accessibilityRole="button"
          accessibilityLabel={`Previous month ${label}`}
        >
          <Ionicons name="chevron-back" size={18} color={colors.text.secondary} />
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{formatMonthYearNumeric(value)}</Text>
        <TouchableOpacity
          style={styles.stepperBtn}
          onPress={() => onChange(addMonths(value, 1))}
          accessibilityRole="button"
          accessibilityLabel={`Next month ${label}`}
        >
          <Ionicons name="chevron-forward" size={18} color={colors.text.secondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSummaryAmount(value: number, kind: 'expense' | 'income'): string {
  if (value <= 0) return '—';
  const formatted = formatMoney(value);
  return kind === 'expense' ? `−${formatted}` : `+${formatted}`;
}

type StatementCurrencyRow = { ccy: string; expense: number; income: number };

function StatementSummaryPanel({
  currencyRows,
  t,
}: {
  currencyRows: StatementCurrencyRow[];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const isSingleCurrency = currencyRows.length === 1;
  const single = isSingleCurrency ? currencyRows[0] : null;

  return (
    <View style={styles.summaryBody}>
      {isSingleCurrency && single ? (
        <View style={styles.summarySingleSplit}>
          <View style={styles.summarySingleHalf}>
            <Text style={[styles.summarySingleAmount, styles.summarySingleAmountOut]}>
              {formatSummaryAmount(single.expense, 'expense')}
            </Text>
            <Text style={styles.summarySingleCcy}>{single.ccy}</Text>
          </View>
          <View style={styles.summarySingleDivider} />
          <View style={styles.summarySingleHalf}>
            <Text style={[styles.summarySingleAmount, styles.summarySingleAmountIn]}>
              {formatSummaryAmount(single.income, 'income')}
            </Text>
            <Text style={styles.summarySingleCcy}>{single.ccy}</Text>
          </View>
        </View>
      ) : (
        <View style={styles.summaryTable}>
          <View style={styles.summaryTableHead}>
            <Text style={[styles.summaryTableHeadCell, styles.summaryTableHeadCcy]}>
              {t('cash.statementCurrencies')}
            </Text>
            <Text style={[styles.summaryTableHeadCell, styles.summaryTableHeadExpense]}>
              {t('cash.statementExpense')}
            </Text>
            <Text style={[styles.summaryTableHeadCell, styles.summaryTableHeadIncome]}>
              {t('cash.statementIncome')}
            </Text>
          </View>
          {currencyRows.map((row, index) => (
            <View
              key={row.ccy}
              style={[
                styles.summaryTableRow,
                index === currencyRows.length - 1 && styles.summaryTableRowLast,
              ]}
            >
              <View style={styles.summaryTableCcy}>
                <CircleCurrencyFlag currencyCode={row.ccy} size={18} style={styles.summaryTableFlag} />
                <Text style={styles.summaryTableCode}>{row.ccy}</Text>
              </View>
              <Text
                style={[
                  styles.summaryTableAmount,
                  styles.summaryTableAmountExpense,
                  row.expense <= 0 && styles.summaryTableAmountEmpty,
                ]}
              >
                {formatSummaryAmount(row.expense, 'expense')}
              </Text>
              <Text
                style={[
                  styles.summaryTableAmount,
                  styles.summaryTableAmountIncome,
                  row.income <= 0 && styles.summaryTableAmountEmpty,
                ]}
              >
                {formatSummaryAmount(row.income, 'income')}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function SectionLabelWithInfo({
  label,
  hintTitle,
  hintMessage,
}: {
  label: string;
  hintTitle: string;
  hintMessage: string;
}) {
  const { t } = useTranslation();
  const [hintOpen, setHintOpen] = useState(false);

  return (
    <>
      <View style={styles.sectionLabelRow}>
        <Text style={styles.sectionLabelInRow}>{label}</Text>
        <TouchableOpacity
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          onPress={() => setHintOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={hintTitle}
        >
          <Ionicons name="information-circle-outline" size={17} color={colors.text.muted} />
        </TouchableOpacity>
      </View>
      <Modal visible={hintOpen} transparent animationType="fade" onRequestClose={() => setHintOpen(false)}>
        <TouchableOpacity
          style={styles.hintModalOverlay}
          activeOpacity={1}
          onPress={() => setHintOpen(false)}
        >
          <View style={styles.hintModalCard} onStartShouldSetResponder={() => true}>
            <View style={styles.hintModalHeader}>
              <Text style={styles.hintModalTitle}>{hintTitle}</Text>
              <TouchableOpacity
                onPress={() => setHintOpen(false)}
                style={styles.hintModalCloseBtn}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Ionicons name="close" size={20} color={colors.text.secondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.hintModalBody}>{hintMessage}</Text>
            <TouchableOpacity
              style={styles.hintModalDoneBtn}
              onPress={() => setHintOpen(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.hintModalDoneText}>{t('common.gotIt')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function CurrencyFilterModal({
  visible,
  onClose,
  selected,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  selected: string[];
  onChange: (codes: string[]) => void;
}) {
  const { t } = useTranslation();
  const allSelected = selected.length === 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.modalCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>{t('cash.statementCurrenciesChoose')}</Text>
            <TouchableOpacity
              style={[styles.modalRow, allSelected && styles.modalRowActive]}
              onPress={() => {
                onChange([]);
                onClose();
              }}
            >
              <View style={styles.modalRowBody}>
                <Text style={styles.modalRowCode}>{t('cash.statementAllCurrencies')}</Text>
                <Text style={styles.modalRowSub}>{t('cash.statementAllCurrenciesSub')}</Text>
              </View>
              {allSelected ? (
                <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
              ) : (
                <View style={styles.modalRowSpacer} />
              )}
            </TouchableOpacity>
            {STATEMENT_CURRENCY_OPTIONS.map((code) => {
              const active = selected.includes(code);
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.modalRow, active && styles.modalRowActive]}
                  onPress={() => {
                    if (active) {
                      const next = selected.filter((c) => c !== code);
                      onChange(next);
                    } else {
                      onChange([...selected, code]);
                    }
                  }}
                >
                  <CircleCurrencyFlag currencyCode={code} size={22} style={styles.modalRowFlag} />
                  <View style={styles.modalRowBody}>
                    <Text style={styles.modalRowCode}>{code}</Text>
                  </View>
                  {active ? (
                    <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
                  ) : (
                    <View style={styles.modalRowSpacer} />
                  )}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={styles.modalDoneBtn} onPress={onClose}>
              <Text style={styles.modalDoneText}>{t('common.done', 'Done')}</Text>
            </TouchableOpacity>
          </View>
      </TouchableOpacity>
    </Modal>
  );
}

export function StatementExportScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { getAccessToken } = useAuth();
  const { link, profile, initializing: urAccountInitializing } = useUrAccount();

  const initialRange = useMemo(() => presetRange('1m'), []);
  const [preset, setPreset] = useState<StatementPreset>('1m');
  const [fromMonth, setFromMonth] = useState<MonthYear>(() => initialRange.from);
  const [toMonth, setToMonth] = useState<MonthYear>(() => initialRange.to);
  const [direction, setDirection] = useState<UrStatementDirection>('ALL');
  const [scope, setScope] = useState<UrStatementScope>('ALL');
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);
  const [currencyModalOpen, setCurrencyModalOpen] = useState(false);
  const [preview, setPreview] = useState<UrStatementPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const range = useMemo(() => {
    if (preset === 'custom') {
      return rangeFromMonths(fromMonth, toMonth);
    }
    const r = presetRange(preset);
    return r;
  }, [preset, fromMonth, toMonth]);

  const rangeError = useMemo(
    () => validateStatementRange(range.from_timestamp, range.to_timestamp),
    [range],
  );

  const urId = link?.ur_id ?? profile?.urId ?? null;
  const uridLabel = urId != null ? formatPaymentReference(urId) : null;

  const currencySummary = useMemo(() => {
    if (selectedCurrencies.length === 0) {
      return t('cash.statementAllCurrencies');
    }
    return selectedCurrencies.join(' · ');
  }, [selectedCurrencies, t]);

  const periodHint = useMemo(() => formatStatementPeriodRange(range), [range]);

  const applyPreset = useCallback((next: StatementPreset) => {
    setPreset(next);
    if (next !== 'custom') {
      const r = presetRange(next);
      setFromMonth(r.from);
      setToMonth(r.to);
    }
  }, []);

  const loadPreview = useCallback(async () => {
    if (rangeError) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    if (urAccountInitializing) {
      setPreviewLoading(true);
      setPreviewError(null);
      return;
    }
    if (!link?.ur_id) {
      setPreview(null);
      setPreviewError(t('cash.statementLinkRequired'));
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setPreviewError(t('cash.statementPreviewFailed'));
        return;
      }
      const res = await previewUrStatement(token, {
        from_timestamp: range.from_timestamp,
        to_timestamp: range.to_timestamp,
        currencies: selectedCurrencies.length ? selectedCurrencies : undefined,
        direction,
        scope,
        // TODO: pass user_email when statement email delivery is enabled
      });
      setPreview(res);
    } catch (err: unknown) {
      setPreview(null);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? String((err as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? '')
          : '';
      setPreviewError(msg || t('cash.statementPreviewFailed'));
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[StatementExport] preview failed:', err);
      }
    } finally {
      setPreviewLoading(false);
    }
  }, [
    rangeError,
    urAccountInitializing,
    link?.ur_id,
    getAccessToken,
    range.from_timestamp,
    range.to_timestamp,
    selectedCurrencies,
    direction,
    scope,
    t,
  ]);

  const summaryBusy = urAccountInitializing || previewLoading;

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const handleExport = useCallback(async () => {
    if (rangeError) {
      Toast.show({
        type: 'error',
        text1: t('cash.statementRangeTooLong'),
      });
      return;
    }
    setExporting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const pdf = await exportUrStatementPdf(token, {
        from_timestamp: range.from_timestamp,
        to_timestamp: range.to_timestamp,
        currencies: selectedCurrencies.length ? selectedCurrencies : undefined,
        direction,
        scope,
        // TODO: pass user_email when statement email delivery is enabled
      });
      const stateId = preview?.state_id ?? `statement-${Date.now()}`;
      await shareStatementPdf(pdf, `HyperTrade-Statement-${stateId}.pdf`);
      Toast.show({ type: 'success', text1: t('cash.statementExportReady') });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('cash.statementExportFailed');
      Toast.show({ type: 'error', text1: msg });
    } finally {
      setExporting(false);
    }
  }, [
    rangeError,
    getAccessToken,
    range,
    selectedCurrencies,
    direction,
    scope,
    preview?.state_id,
    t,
  ]);

  const summaryTotals = useMemo(() => {
    const summary = preview?.summary;
    if (!summary) return null;
    const byCurrency = summary.by_currency || {};
    const currencyRows: StatementCurrencyRow[] = sortStatementCurrencies(
      Object.keys(byCurrency).filter((ccy) => STATEMENT_FIAT_SET.has(ccy)),
    ).map((ccy) => ({
        ccy,
        expense: byCurrency[ccy]?.out ?? 0,
        income: byCurrency[ccy]?.in ?? 0,
      }))
      .filter((row) => row.expense > 0 || row.income > 0);
    return { currencyRows };
  }, [preview]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.goBack', 'Go back')}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('cash.statement')}</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionLabel}>{t('cash.statementPeriod')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
          {VISIBLE_PRESETS.map((p) => {
            const label =
              p === '1m'
                ? t('cash.statementPreset1m')
                : p === '3m'
                  ? t('cash.statementPreset3m')
                  : p === '6m'
                    ? t('cash.statementPreset6m')
                    : p === '1y'
                      ? t('cash.statementPreset1y')
                      : t('cash.statementPresetCustom');
            const active = preset === p;
            return (
              <TouchableOpacity
                key={p}
                style={[styles.presetChip, active && styles.presetChipActive]}
                onPress={() => applyPreset(p)}
              >
                <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {STATEMENT_CUSTOM_PERIOD_ENABLED && preset === 'custom' ? (
          <View style={styles.customRange}>
            <MonthStepper
              label={t('cash.statementFrom')}
              value={fromMonth}
              onChange={(v) => {
                setFromMonth(v);
                setPreset('custom');
              }}
            />
            <Text style={styles.rangeTo}>{t('cash.statementToLabel')}</Text>
            <MonthStepper
              label={t('cash.statementTo')}
              value={toMonth}
              onChange={(v) => {
                setToMonth(v);
                setPreset('custom');
              }}
            />
          </View>
        ) : (
          <Text style={styles.rangeHint}>{periodHint}</Text>
        )}

        {rangeError === 'range_too_long' ? (
          <Text style={styles.rangeError}>{t('cash.statementRangeTooLong')}</Text>
        ) : null}

        <LinearGradient
          colors={[...HOMEPAGE_CARD_GRADIENT]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.summaryCard}
        >
          <View style={styles.summaryHeader}>
            <View style={styles.summaryHeaderLeft}>
              <Text style={styles.summaryTitle}>{t('cash.statementSummary')}</Text>
              <Text style={styles.summaryPeriod}>{periodHint}</Text>
              {uridLabel ? <Text style={styles.summaryUrid}>{uridLabel}</Text> : null}
            </View>
          </View>
          {summaryBusy ? (
            <View style={styles.summaryLoadingBody}>
              <ActivityIndicator size="small" color={colors.accent.gold} />
            </View>
          ) : previewError ? (
            <Text style={[styles.summaryEmpty, styles.summaryError]}>{previewError}</Text>
          ) : preview && summaryTotals ? (
            preview.summary.transaction_count === 0 ? (
              <Text style={styles.summaryEmpty}>{t('cash.statementNoTxs')}</Text>
            ) : (
              <StatementSummaryPanel
                currencyRows={summaryTotals.currencyRows}
                t={t}
              />
            )
          ) : (
            <Text style={styles.summaryEmpty}>{t('cash.statementNoTxs')}</Text>
          )}
        </LinearGradient>

        <SectionLabelWithInfo
          label={t('cash.statementActivity')}
          hintTitle={t('cash.statementActivityHintTitle')}
          hintMessage={t('cash.statementActivityHint')}
        />
        <View style={styles.toggleRow}>
          {(['ALL', 'OUT', 'IN'] as UrStatementDirection[]).map((d) => {
            const label =
              d === 'ALL'
                ? t('cash.statementAll')
                : d === 'OUT'
                  ? t('cash.statementExpense')
                  : t('cash.statementIncome');
            const active = direction === d;
            return (
              <TouchableOpacity
                key={d}
                style={[styles.toggleChip, active && styles.toggleChipActive]}
                onPress={() => setDirection(d)}
              >
                <Text style={[styles.toggleChipText, active && styles.toggleChipTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <SectionLabelWithInfo
          label={t('cash.statementScope')}
          hintTitle={t('cash.statementScopeHintTitle')}
          hintMessage={t('cash.statementScopeHint')}
        />
        <View style={styles.toggleRow}>
          {(['ALL', 'CASH', 'CARD'] as UrStatementScope[]).map((s) => {
            const label =
              s === 'ALL'
                ? t('cash.statementScopeAll')
                : s === 'CASH'
                  ? t('cash.statementScopeCash')
                  : t('cash.statementScopeCard');
            const active = scope === s;
            return (
              <TouchableOpacity
                key={s}
                style={[styles.toggleChip, active && styles.toggleChipActive]}
                onPress={() => setScope(s)}
              >
                <Text style={[styles.toggleChipText, active && styles.toggleChipTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>{t('cash.statementCurrencies')}</Text>
        <TouchableOpacity
          style={styles.selectorRow}
          onPress={() => setCurrencyModalOpen(true)}
          activeOpacity={0.75}
          accessibilityRole="button"
        >
          <Text style={styles.selectorValue} numberOfLines={1}>
            {currencySummary}
          </Text>
          <Ionicons name="chevron-forward" size={18} color={colors.text.tertiary} />
        </TouchableOpacity>

        <CurrencyFilterModal
          visible={currencyModalOpen}
          onClose={() => setCurrencyModalOpen(false)}
          selected={selectedCurrencies}
          onChange={setSelectedCurrencies}
        />

        {/* TODO: Email delivery — show masked Privy email + "Receive emails" row when
            backend can send PDF via Resend/SendGrid.
        const maskedEmail = maskEmail(user?.email);
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>{t('cash.statementReceiveEmail')}</Text>
          <Text style={styles.metaValue}>{maskedEmail}</Text>
        </View>
        <Text style={styles.emailNote}>{t('cash.statementEmailLater')}</Text>
        */}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerMetaRow}>
          <Text style={styles.metaLabel}>{t('cash.statementFileFormat')}</Text>
          <Text style={styles.metaValue}>PDF</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => void handleExport()}
          disabled={exporting || !!rangeError}
          accessibilityRole="button"
          style={[styles.exportBtnOuter, (exporting || !!rangeError) && styles.exportBtnOuterDisabled]}
        >
          <LinearGradient
            colors={
              exporting || rangeError ? [...EXPORT_GRADIENT_DISABLED] : [...EXPORT_GRADIENT]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.exportBtn}
          >
            {exporting ? (
              <ActivityIndicator color={colors.text.primary} />
            ) : (
              <Text style={styles.exportBtnText}>{t('cash.statementExport')}</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  headerBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
  },
  scroll: {
    padding: 20,
    paddingBottom: 24,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
    marginTop: 4,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    marginBottom: 2,
  },
  sectionLabelInRow: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  presetRow: {
    gap: 8,
    paddingVertical: 4,
  },
  presetChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.secondary,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  presetChipActive: {
    borderColor: colors.text.primary,
    backgroundColor: colors.text.primary,
  },
  presetChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  presetChipTextActive: {
    color: colors.background.primary,
  },
  customRange: {
    gap: 8,
    marginTop: 4,
  },
  stepperBlock: {
    gap: 6,
  },
  stepperLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '600',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.background.elevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  stepperBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  rangeTo: {
    alignSelf: 'center',
    fontSize: 12,
    color: colors.text.muted,
  },
  rangeHint: {
    fontSize: 13,
    color: colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  rangeError: {
    fontSize: 12,
    color: colors.status.error,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleChip: {
    flex: 1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.secondary,
    paddingVertical: 10,
    alignItems: 'center',
  },
  toggleChipActive: {
    backgroundColor: colors.text.primary,
    borderColor: colors.text.primary,
  },
  toggleChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  toggleChipTextActive: {
    color: colors.background.primary,
  },
  selectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background.elevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 8,
  },
  selectorValue: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
  },
  hintModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  hintModalCard: {
    backgroundColor: colors.background.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    gap: 12,
  },
  hintModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  hintModalTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
  },
  hintModalCloseBtn: {
    padding: 4,
  },
  hintModalBody: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.text.secondary,
  },
  hintModalDoneBtn: {
    marginTop: 4,
    borderRadius: 12,
    backgroundColor: colors.accent.gold,
    paddingVertical: 13,
    alignItems: 'center',
  },
  hintModalDoneText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: colors.background.elevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    gap: 4,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 8,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
    gap: 10,
  },
  modalRowActive: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  modalRowFlag: {
    marginRight: 2,
  },
  modalRowBody: {
    flex: 1,
    gap: 2,
  },
  modalRowCode: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  modalRowSub: {
    fontSize: 12,
    color: colors.text.tertiary,
  },
  modalRowSpacer: {
    width: 20,
  },
  modalDoneBtn: {
    marginTop: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
  },
  modalDoneText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
  },
  summaryCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    gap: 10,
    overflow: 'hidden',
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  summaryHeaderLeft: {
    flex: 1,
    gap: 4,
  },
  summaryTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
  },
  summaryPeriod: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  summaryUrid: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  summaryLoadingBody: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  summaryEmpty: {
    fontSize: 13,
    color: colors.text.tertiary,
  },
  summaryError: {
    color: colors.status.error,
  },
  summaryBody: {
    gap: 12,
    marginTop: 2,
  },
  summarySingleSplit: {
    flexDirection: 'row',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.22)',
    overflow: 'hidden',
  },
  summarySingleHalf: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 10,
    gap: 4,
  },
  summarySingleDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  summarySingleAmount: {
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  summarySingleAmountOut: {
    color: colors.status.error,
  },
  summarySingleAmountIn: {
    color: colors.accent.gold,
  },
  summarySingleCcy: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
    letterSpacing: 0.8,
  },
  summaryTable: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.22)',
    overflow: 'hidden',
  },
  summaryTableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  summaryTableHeadCell: {
    flex: 1,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'right',
  },
  summaryTableHeadCcy: {
    flex: 1.1,
    textAlign: 'left',
    color: colors.text.secondary,
  },
  summaryTableHeadExpense: {
    color: colors.text.secondary,
  },
  summaryTableHeadIncome: {
    color: colors.text.secondary,
  },
  summaryTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  summaryTableRowLast: {
    borderBottomWidth: 0,
  },
  summaryTableCcy: {
    flex: 1.1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryTableFlag: {},
  summaryTableCode: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.primary,
    letterSpacing: 0.3,
  },
  summaryTableAmount: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  summaryTableAmountExpense: {
    color: colors.status.error,
  },
  summaryTableAmountIncome: {
    color: colors.accent.gold,
  },
  summaryTableAmountEmpty: {
    color: colors.text.muted,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  metaLabel: {
    fontSize: 14,
    color: colors.text.secondary,
  },
  metaValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.primary,
  },
  emailNote: {
    fontSize: 11,
    color: colors.text.muted,
    marginTop: -4,
    marginBottom: 8,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 8 : 16,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
    backgroundColor: colors.background.primary,
  },
  footerMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 2,
  },
  exportBtnOuter: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  exportBtnOuterDisabled: {
    opacity: 0.55,
  },
  exportBtn: {
    borderRadius: 999,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  exportBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.background.primary,
  },
});
