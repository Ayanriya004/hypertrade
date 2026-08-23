/**
 * Notifications inbox — the bell feed for the Bank dashboard.
 *
 * Lists banking notifications (KYC outcome, pay-ins, card spend, outgoing)
 * most-recent-first, with All / Transaction / System tabs, pull-to-refresh,
 * tap-to-mark-read, and a "mark all read" header action.
 *
 * Rows are produced server-side from UR webhooks and scoped to the signed-in
 * user; this screen only reads + marks read.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Pressable,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { txExplorerUrl, shortHash } from '../../lib/explorer';
import { openHttpsUrl } from '../../lib/openHttpsUrl';
import {
  useUrNotificationFeed,
  type UrNotificationFilter,
} from '../../hooks/useUrNotifications';
import type { UrNotification } from '../../lib/urApi';
import { useAuth } from '../../providers/AuthContext';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../../lib/notifications';
import { BankConfirmModal } from './BankConfirmModal';

type UrPushPrefs = {
  ur_transaction_alerts_enabled: boolean;
  ur_card_alerts_enabled: boolean;
  ur_kyc_alerts_enabled: boolean;
};

const DEFAULT_PUSH_PREFS: UrPushPrefs = {
  ur_transaction_alerts_enabled: true,
  ur_card_alerts_enabled: true,
  ur_kyc_alerts_enabled: true,
};

/**
 * Compact bottom sheet to mute/unmute UR push categories. Toggles gate the
 * PUSH only — the inbox feed keeps every event regardless. Optimistic: flip
 * locally, then persist; revert on failure.
 */
function PushPrefsSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { getAccessToken } = useAuth();
  const [prefs, setPrefs] = useState<UrPushPrefs>(DEFAULT_PUSH_PREFS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const p = await getNotificationPreferences(token);
        if (!alive) return;
        setPrefs({
          ur_transaction_alerts_enabled: p.ur_transaction_alerts_enabled ?? true,
          ur_card_alerts_enabled: p.ur_card_alerts_enabled ?? true,
          ur_kyc_alerts_enabled: p.ur_kyc_alerts_enabled ?? true,
        });
      } catch {
        /* keep defaults */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible, getAccessToken]);

  const toggle = useCallback(
    async (key: keyof UrPushPrefs) => {
      const next = !prefs[key];
      setPrefs((cur) => ({ ...cur, [key]: next }));
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('no token');
        await updateNotificationPreferences(token, { [key]: next });
      } catch {
        setPrefs((cur) => ({ ...cur, [key]: !next }));
      }
    },
    [prefs, getAccessToken],
  );

  const rows: {
    key: keyof UrPushPrefs;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
  }[] = [
    {
      key: 'ur_transaction_alerts_enabled',
      icon: 'cash',
      label: t('notifications.prefTransactions', 'Cash activity'),
    },
    {
      key: 'ur_card_alerts_enabled',
      icon: 'card',
      label: t('notifications.prefCard', 'Card activity'),
    },
    {
      key: 'ur_kyc_alerts_enabled',
      icon: 'shield-checkmark',
      label: t('notifications.prefVerification', 'KYC updates'),
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetGrabber} />
        <Text style={styles.sheetTitle}>
          {t('notifications.prefTitle', 'Push alerts')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {t('notifications.prefSubtitle', 'Choose what we notify you about.')}
        </Text>
        {rows.map((r) => (
          <View key={r.key} style={styles.prefRow}>
            <View style={styles.prefIconWrap}>
              <Ionicons name={r.icon} size={18} color={colors.text.primary} />
            </View>
            <Text style={styles.prefLabel}>{r.label}</Text>
            <Switch
              value={prefs[r.key]}
              onValueChange={() => toggle(r.key)}
              disabled={loading}
              trackColor={{ false: colors.border.primary, true: colors.accent.gold }}
              thumbColor="#fff"
            />
          </View>
        ))}
      </View>
    </Modal>
  );
}

const FILTERS: UrNotificationFilter[] = ['all', 'transaction', 'card', 'verification'];

type IconSpec = { name: keyof typeof Ionicons.glyphMap; color: string };

function iconFor(n: UrNotification): IconSpec {
  if (n.type === 'kyc_status') {
    const status = String((n.data as { status?: string })?.status || '');
    if (status === 'Pass') return { name: 'shield-checkmark', color: colors.status.success };
    if (status === 'Rejected') return { name: 'close-circle', color: colors.status.error };
    return { name: 'time-outline', color: colors.accent.gold };
  }
  if (n.type === 'deposit') return { name: 'add-circle', color: colors.status.success };
  if (n.type === 'conversion') return { name: 'swap-horizontal', color: colors.accent.gold };
  if (n.type === 'transfer_in') return { name: 'arrow-down-circle', color: colors.status.success };
  if (n.type === 'transfer_out') return { name: 'send', color: colors.accent.purple };
  if (n.type === 'payin') return { name: 'arrow-down-circle', color: colors.status.success };
  if (n.type === 'card_refund') return { name: 'arrow-undo-circle', color: colors.status.success };
  if (n.type === 'card_spend') return { name: 'card', color: colors.text.primary };
  if (n.type === 'payment_out') return { name: 'arrow-up-circle', color: colors.text.secondary };
  return { name: 'notifications', color: colors.text.secondary };
}

/** "14:36" today, "Jun 1" this year, "Jun 1, 2025" otherwise. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Memoised so badge-store re-renders (e.g. the mark-read server response
// resolving mid back-transition) never repaint already-read rows — that
// repaint, on a freezeOnBlur/animating screen, was the "read rows flash bright
// on back" glitch. Rows only re-render when their own item or handler changes.
const NotificationRow = React.memo(
  function NotificationRow({
    item,
    onPress,
  }: {
    item: UrNotification;
    onPress: (item: UrNotification) => void;
  }) {
    const icon = iconFor(item);
    const txHash = String((item.data as { txHash?: string })?.txHash || '');
    const txUrl = txExplorerUrl(txHash, (item.data as { chainId?: string })?.chainId);
    return (
      <TouchableOpacity
        style={[styles.row, item.read && styles.rowRead]}
        activeOpacity={0.7}
        onPress={() => onPress(item)}
      >
        <View style={styles.rowIconWrap}>
          <Ionicons name={icon.name} size={22} color={icon.color} />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            {!item.read ? <View style={styles.unreadDot} /> : null}
          </View>
          <Text style={styles.rowText} numberOfLines={2}>
            {item.body}
          </Text>
          <View style={styles.rowFooter}>
            <Text style={styles.rowWhen}>{formatWhen(item.createdAt)}</Text>
            {txUrl ? (
              <TouchableOpacity
                style={styles.txLink}
                onPress={() => void openHttpsUrl(txUrl).catch(() => {})}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="link"
                accessibilityLabel={`View transaction ${shortHash(txHash)} on block explorer`}
              >
                <Text style={styles.txLinkText}>{shortHash(txHash)}</Text>
                <Ionicons name="open-outline" size={13} color={colors.text.tertiary} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
    );
  },
  (prev, next) =>
    prev.onPress === next.onPress &&
    prev.item.id === next.item.id &&
    prev.item.read === next.item.read &&
    prev.item.title === next.item.title &&
    prev.item.body === next.item.body,
);

export function NotificationsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const {
    items,
    loading,
    refreshing,
    unreadCount,
    filter,
    setFilter,
    refresh,
    markRead,
    markAllRead,
  } = useUrNotificationFeed();

  // Deep-link support: open a specific tab (e.g. ?tab=card from card settings).
  useEffect(() => {
    if (tab && (FILTERS as string[]).includes(tab)) {
      setFilter(tab as UrNotificationFilter);
    }
  }, [tab, setFilter]);

  const [showPrefs, setShowPrefs] = useState(false);
  const [confirmMarkAllOpen, setConfirmMarkAllOpen] = useState(false);

  const onPressMarkAllRead = useCallback(() => {
    if (unreadCount === 0) return;
    setConfirmMarkAllOpen(true);
  }, [unreadCount]);

  const handleConfirmMarkAllRead = useCallback(() => {
    markAllRead();
    setConfirmMarkAllOpen(false);
  }, [markAllRead]);

  const onPressItem = useCallback(
    (item: UrNotification) => {
      if (!item.read) markRead(item.id);
    },
    [markRead],
  );

  const filterLabel = useCallback(
    (f: UrNotificationFilter) => {
      if (f === 'all') return t('notifications.filterAll', 'All');
      if (f === 'transaction') return t('notifications.filterTransaction', 'Transactions');
      if (f === 'card') return t('notifications.filterCard', 'Card');
      return t('notifications.filterVerification', 'KYC');
    },
    [t],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={[styles.headerSide, styles.headerSideStart]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.headerBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.goBack', 'Go back')}
          >
            <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {t('notifications.title', 'Notifications')}
        </Text>
        <View style={[styles.headerSide, styles.headerActions]}>
          <TouchableOpacity
            onPress={onPressMarkAllRead}
            disabled={unreadCount === 0}
            style={styles.headerBtn}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('notifications.markAllReadA11y', 'Mark all as read')}
          >
            <Ionicons
              name="checkmark-done-outline"
              size={22}
              color={unreadCount === 0 ? colors.text.tertiary : colors.accent.gold}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowPrefs(true)}
            style={styles.headerBtn}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('notifications.prefTitle', 'Push alerts')}
          >
            <Ionicons name="settings-outline" size={20} color={colors.text.primary} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.tabs}>
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <TouchableOpacity
              key={f}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setFilter(f)}
              activeOpacity={0.8}
            >
              <Text
                style={[styles.tabText, active && styles.tabTextActive]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
              >
                {filterLabel(f)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent.gold} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={onPressItem} />
          )}
          contentContainerStyle={items.length === 0 ? styles.emptyScroll : styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.accent.gold}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons
                name="notifications-off-outline"
                size={48}
                color={colors.text.tertiary}
              />
              <Text style={styles.emptyTitle}>
                {t('notifications.emptyTitle', 'No notifications yet')}
              </Text>
              <Text style={styles.emptyText}>
                {t(
                  'notifications.emptyText',
                  "We'll let you know about deposits, card activity and verification updates here.",
                )}
              </Text>
            </View>
          }
        />
      )}

      <PushPrefsSheet visible={showPrefs} onClose={() => setShowPrefs(false)} />

      <BankConfirmModal
        visible={confirmMarkAllOpen}
        title={t('notifications.markAllReadConfirmTitle', 'Mark all as read?')}
        message={t(
          'notifications.markAllReadConfirmMessage',
          'All notifications will be marked as read.',
        )}
        onConfirm={handleConfirmMarkAllRead}
        onCancel={() => setConfirmMarkAllOpen(false)}
      />
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  /** Equal-width slots on both sides keep the title visually centered. */
  headerSide: {
    width: 72,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSideStart: {
    justifyContent: 'flex-start',
  },
  headerActions: {
    justifyContent: 'flex-end',
  },
  headerBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tab: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: colors.background.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: colors.text.primary,
  },
  tabText: {
    color: colors.text.secondary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  tabTextActive: {
    color: colors.background.primary,
  },
  listContent: {
    paddingBottom: 24,
  },
  emptyScroll: {
    flexGrow: 1,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.primary,
    marginLeft: 60,
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  /** Already-read rows dim back so fresh/unread ones stand out. */
  rowRead: {
    opacity: 0.55,
  },
  rowIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background.tertiary,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
  },
  rowBody: {
    flex: 1,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowTitle: {
    flex: 1,
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent.gold,
  },
  rowText: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  rowFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    gap: 12,
  },
  rowWhen: {
    color: colors.text.tertiary,
    fontSize: 12,
  },
  txLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  txLinkText: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyTitle: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 4,
  },
  emptyText: {
    color: colors.text.tertiary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: colors.background.elevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 32,
  },
  sheetGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.primary,
    marginBottom: 14,
  },
  sheetTitle: {
    color: colors.text.primary,
    fontSize: 17,
    fontWeight: '700',
  },
  sheetSubtitle: {
    color: colors.text.tertiary,
    fontSize: 13,
    marginTop: 2,
    marginBottom: 8,
  },
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  prefIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background.tertiary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  prefLabel: {
    flex: 1,
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '600',
  },
});
