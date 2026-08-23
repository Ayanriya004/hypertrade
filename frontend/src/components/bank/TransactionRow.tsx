/**
 * Single UR transaction row. Shared between the Cash and Card tabs.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import type { UrTransaction } from '../../lib/urApi';
import {
  formatDisplayAmount,
  formatTxHashShort,
  getTxTypeIcon,
  hasTxProof,
  isSendTxIcon,
  isTxPending,
  resolveTxDirectionColor,
  resolveTxStatus,
  resolveTxStatusTone,
  resolveTxSubtitle,
  resolveTxTitle,
} from '../../lib/urTransactionFormat';
import { SendIcon } from './SendIcon';

function isValidRemoteIcon(uri?: string): boolean {
  if (!uri?.trim()) return false;
  return /^https?:\/\/.+/i.test(uri.trim());
}

function relativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const STATUS_COLORS = {
  success: colors.text.tertiary,
  warning: colors.status.warning,
  danger: colors.status.error,
  neutral: colors.text.muted,
} as const;

export interface TransactionRowProps {
  tx: UrTransaction;
  onPress?: () => void;
}

export function TransactionRow({ tx, onPress }: TransactionRowProps) {
  const { t } = useTranslation();
  const canOpenProof = hasTxProof(tx) && Boolean(onPress);

  const title = useMemo(() => resolveTxTitle(tx, t), [tx, t]);
  const subtitle = useMemo(() => resolveTxSubtitle(tx, t), [tx, t]);
  const statusLabel = useMemo(() => resolveTxStatus(tx, t), [tx, t]);
  const statusTone = useMemo(() => resolveTxStatusTone(tx), [tx]);
  const { signed, currency } = useMemo(() => formatDisplayAmount(tx), [tx]);
  const iconName = useMemo(() => getTxTypeIcon(tx), [tx]);
  const [remoteIconFailed, setRemoteIconFailed] = useState(false);

  useEffect(() => {
    setRemoteIconFailed(false);
  }, [tx.txIdIcon, tx.txHash, tx.timestamp]);

  const showRemoteIcon = isValidRemoteIcon(tx.txIdIcon) && !remoteIconFailed;
  const pending = isTxPending(tx);
  const directionColor = useMemo(() => resolveTxDirectionColor(tx), [tx]);

  return (
    <TouchableOpacity
      activeOpacity={canOpenProof ? 0.7 : 1}
      onPress={canOpenProof ? onPress : undefined}
      style={[styles.row, pending && styles.rowPending]}
      accessibilityRole={canOpenProof ? 'button' : 'text'}
      accessibilityLabel={
        canOpenProof
          ? `${title}, ${signed} ${currency}, ${statusLabel}, ${t('cash.txViewOnChain')}`
          : `${title}, ${signed} ${currency}, ${statusLabel}`
      }
    >
      <View
        style={[
          styles.iconWrap,
          showRemoteIcon
            ? {
                backgroundColor: colors.background.elevated,
                borderColor: `${directionColor}40`,
              }
            : {
                backgroundColor: `${directionColor}20`,
                borderColor: `${directionColor}35`,
              },
        ]}
      >
        {pending ? (
          <ActivityIndicator size="small" color={directionColor} />
        ) : showRemoteIcon ? (
          <Image
            source={{ uri: tx.txIdIcon!.trim() }}
            style={styles.iconImage}
            onError={() => setRemoteIconFailed(true)}
          />
        ) : isSendTxIcon(iconName) ? (
          <SendIcon size={20} color={directionColor} />
        ) : (
          <Ionicons name={iconName} size={20} color={directionColor} />
        )}
      </View>

      <View style={styles.middle}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text style={styles.timestamp}>{relativeTime(tx.timestamp)}</Text>
          {canOpenProof ? (
            <>
              <Text style={styles.metaDot}>·</Text>
              <Ionicons name="open-outline" size={11} color={colors.text.tertiary} />
              <Text style={styles.proofLink} numberOfLines={1}>
                {formatTxHashShort(tx.txHash) || t('cash.txViewOnChain')}
              </Text>
            </>
          ) : null}
        </View>
      </View>

      <View style={styles.right}>
        <Text style={[styles.amount, { color: directionColor }]} numberOfLines={1}>
          {signed}
          {currency ? ` ${currency}` : ''}
        </Text>
        <View
          style={[
            styles.statusPill,
            statusTone === 'warning' || statusTone === 'danger'
              ? { backgroundColor: `${STATUS_COLORS[statusTone]}18` }
              : styles.statusPillNeutral,
          ]}
        >
          <Text style={[styles.status, { color: STATUS_COLORS[statusTone] }]} numberOfLines={1}>
            {statusLabel}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowPending: {
    opacity: 0.72,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
  },
  iconImage: {
    width: 40,
    height: 40,
  },
  middle: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
  },
  subtitle: {
    fontSize: 12,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
    minWidth: 0,
  },
  timestamp: {
    fontSize: 11,
    color: colors.text.muted,
  },
  metaDot: {
    fontSize: 11,
    color: colors.text.muted,
  },
  proofLink: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '500',
    color: colors.text.tertiary,
  },
  right: {
    alignItems: 'flex-end',
    minWidth: 88,
    gap: 6,
  },
  amount: {
    fontSize: 14,
    fontWeight: '800',
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusPillNeutral: {
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
  },
  status: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
});
