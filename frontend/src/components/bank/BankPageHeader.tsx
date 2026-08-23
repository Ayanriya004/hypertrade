import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

/** Fixed width for left/right header slots so the title stays visually centered. */
const HEADER_SIDE_WIDTH = 76;
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { useUrUnreadCount } from '../../hooks/useUrNotifications';

type BankPageHeaderProps = {
  backIcon?: 'arrow-back' | 'chevron-back';
  /** Show the notifications bell (with unread badge) next to the FAQ icon. */
  showNotifications?: boolean;
};

/** Bell + unread badge. Self-contained so the unread poll only runs when shown. */
function NotificationsBell() {
  const router = useRouter();
  const { t } = useTranslation();
  const { count } = useUrUnreadCount();
  const badge = count > 99 ? '99+' : String(count);

  return (
    <TouchableOpacity
      onPress={() => router.push('/bank-notifications')}
      style={styles.sideButton}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      accessibilityRole="button"
      accessibilityLabel={t('notifications.openA11y', 'Notifications')}
    >
      <Ionicons name="notifications-outline" size={22} color={colors.text.primary} />
      {count > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText} numberOfLines={1}>
            {badge}
          </Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

export function BankPageHeader({
  backIcon = 'arrow-back',
  showNotifications = false,
}: BankPageHeaderProps) {
  const router = useRouter();
  const { t } = useTranslation();

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleOpenFaq = useCallback(() => {
    router.push('/bank-faq');
  }, [router]);

  return (
    <View style={styles.header}>
      <View style={styles.sideSlot}>
        <TouchableOpacity
          onPress={handleBack}
          style={styles.sideButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.goBack', 'Go back')}
        >
          <Ionicons
            name={backIcon}
            size={backIcon === 'chevron-back' ? 24 : 22}
            color={colors.text.primary}
          />
        </TouchableOpacity>
      </View>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {t('bottomNav.bank', 'Bank')}
      </Text>
      <View style={[styles.sideSlot, styles.sideSlotRight]}>
        <View style={styles.rightGroup}>
          {showNotifications ? <NotificationsBell /> : null}
          <TouchableOpacity
            onPress={handleOpenFaq}
            style={styles.sideButton}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel={t('bankFaq.helpA11y', 'Bank help')}
          >
            <Ionicons name="help-circle-outline" size={22} color={colors.text.primary} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  sideSlot: {
    width: HEADER_SIDE_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideSlotRight: {
    justifyContent: 'flex-end',
  },
  rightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: colors.status?.error ?? '#FF3B30',
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
  },
});
