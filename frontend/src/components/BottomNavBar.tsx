import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { pushRouteOnce, navigateRouteOnce } from '../lib/pushRouteOnce';
import { useAppStore } from '../store/appStore';
import { getBankNavBadgeKind } from '../lib/bankKycPause';
import { BANKING_ENABLED } from '../lib/bankingEnabled';

const VISIBLE_ROUTES = ['/', '/news', '/bank', '/bank-guest', '/rewards', '/ai-agents'];
const VISIBLE_PREFIXES = ['/asset/'];

// Match the native stack push/pop so the bar blends into the screen slide
// instead of popping. Enter is longer than exit because the back-pop is a
// heavier motion than the drill-down push on iOS/Android.
const NAV_ENTER_DURATION_MS = 340;
const NAV_EXIT_DURATION_MS = 200;
const NAV_EXIT_TRANSLATE_Y = 14;

export function BottomNavBar() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);

  // When banking is off, the Wallet tab opens /profile — keep the bar there.
  const shouldShow =
    VISIBLE_ROUTES.includes(pathname) ||
    VISIBLE_PREFIXES.some((p) => pathname.startsWith(p)) ||
    (!BANKING_ENABLED && pathname === '/profile');

  // Stay mounted through the exit animation so hiding isn't a hard pop.
  const [isMounted, setIsMounted] = useState(shouldShow);
  // Freeze the highlighted tab while fading out so icons don't flicker from
  // active → inactive as the new non-nav route takes over `pathname`.
  const [lastVisiblePathname, setLastVisiblePathname] = useState(pathname);

  const opacity = useSharedValue(shouldShow ? 1 : 0);
  const translateY = useSharedValue(shouldShow ? 0 : NAV_EXIT_TRANSLATE_Y);

  useEffect(() => {
    if (shouldShow) {
      setLastVisiblePathname(pathname);
      setIsMounted(true);
      // inOut for opacity avoids the "flash to near-opaque" you get with
      // ease-out on short fade-ins; out for translate still feels settled.
      opacity.value = withTiming(1, {
        duration: NAV_ENTER_DURATION_MS,
        easing: Easing.inOut(Easing.cubic),
      });
      translateY.value = withTiming(0, {
        duration: NAV_ENTER_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      opacity.value = withTiming(0, {
        duration: NAV_EXIT_DURATION_MS,
        easing: Easing.in(Easing.cubic),
      });
      translateY.value = withTiming(
        NAV_EXIT_TRANSLATE_Y,
        { duration: NAV_EXIT_DURATION_MS, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) scheduleOnRN(setIsMounted, false);
        },
      );
    }
  }, [shouldShow, pathname, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (!isMounted) return null;

  /** Home/Markets is only the index route — not e.g. /asset/... */
  const activePathname = shouldShow ? pathname : lastVisiblePathname;
  const isHomeActive = activePathname === '/';
  const isAiAgentsActive = activePathname === '/ai-agents';
  const isNewsActive = activePathname === '/news';
  const isBankActive =
    BANKING_ENABLED &&
    (activePathname === '/bank' || activePathname === '/bank-guest');
  const isWalletActive = !BANKING_ENABLED && activePathname === '/profile';
  const isRewardsActive = activePathname === '/rewards';
  const bankBadgeKind = getBankNavBadgeKind();

  return (
    <Animated.View
      pointerEvents={shouldShow ? 'auto' : 'none'}
      style={[
        styles.outerWrap,
        { paddingBottom: Math.max(insets.bottom, 8) },
        animatedStyle,
      ]}
    >
      <View style={styles.bar}>
        <NavItem
          icon="stats-chart-outline"
          iconActive="stats-chart"
          label={t('bottomNav.home')}
          isActive={isHomeActive}
          onPress={() => {
            if (pathname !== '/') navigateRouteOnce(router, '/');
          }}
        />
        <NavItem
          icon="hardware-chip-outline"
          iconActive="hardware-chip"
          label={t('bottomNav.ai', 'AI')}
          isActive={isAiAgentsActive}
          onPress={() => {
            // Guests can browse the empty-state pitch; create/activate stays auth-gated.
            if (pathname === '/ai-agents') return;
            navigateRouteOnce(router, '/ai-agents' as any);
          }}
        />
        {BANKING_ENABLED ? (
          <NavItem
            faIcon="bank"
            label={t('bottomNav.bank', 'Bank')}
            isActive={isBankActive}
            badge={
              bankBadgeKind === 'paused'
                ? t('header.cardPaused')
                : bankBadgeKind === 'soon'
                  ? t('header.cardSoon')
                  : undefined
            }
            onPress={() => {
              if (pathname === '/bank') return;
              navigateRouteOnce(router, '/bank' as any);
            }}
          />
        ) : (
          <NavItem
            icon="wallet-outline"
            iconActive="wallet"
            label={t('bottomNav.wallet', 'Wallet')}
            isActive={isWalletActive}
            onPress={() => {
              if (!isAuthenticated) {
                pushRouteOnce(router, '/login');
                return;
              }
              if (pathname === '/profile') return;
              navigateRouteOnce(router, '/profile' as any);
            }}
          />
        )}
        <NavItem
          icon="newspaper-outline"
          iconActive="newspaper"
          label={t('bottomNav.news')}
          isActive={isNewsActive}
          onPress={() => {
            if (pathname === '/news') return;
            navigateRouteOnce(router, '/news' as any);
          }}
        />
        <NavItem
          icon="trophy-outline"
          iconActive="trophy"
          label={t('bottomNav.rewards')}
          isActive={isRewardsActive}
          onPress={() => {
            if (!isAuthenticated) {
              pushRouteOnce(router, '/login');
              return;
            }
            if (pathname === '/rewards') return;
            navigateRouteOnce(router, '/rewards' as any);
          }}
        />
      </View>
    </Animated.View>
  );
}

function NavItem({
  icon,
  iconActive,
  faIcon,
  label,
  isActive,
  badge,
  onPress,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  iconActive?: keyof typeof Ionicons.glyphMap;
  faIcon?: keyof typeof FontAwesome.glyphMap;
  label: string;
  isActive: boolean;
  badge?: string;
  onPress: () => void;
}) {
  const iconColor = isActive ? colors.accent.gold : colors.text.tertiary;
  const iconEl = faIcon ? (
    <FontAwesome name={faIcon} size={20} color={iconColor} />
  ) : (
    <Ionicons
      name={isActive ? (iconActive ?? icon!) : icon!}
      size={22}
      color={iconColor}
    />
  );

  return (
    <TouchableOpacity
      style={styles.navItem}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={label}
    >
      <View style={styles.navIconSlot}>
        {badge ? (
          <View style={styles.iconBadgeStack}>
            <View style={styles.badgeAnchor} pointerEvents="none">
              <View style={styles.badge}>
                <Text style={styles.badgeText} allowFontScaling={false} numberOfLines={1}>
                  {badge}
                </Text>
              </View>
            </View>
            {iconEl}
          </View>
        ) : (
          iconEl
        )}
      </View>
      <Text
        style={[styles.navLabel, isActive && styles.navLabelActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  outerWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    elevation: Platform.OS === 'android' ? 10 : 0,
    backgroundColor: colors.background.primary,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderTopColor: colors.border.primary,
    paddingTop: 8,
    paddingHorizontal: 8,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingVertical: 2,
    minWidth: 0,
    position: 'relative',
  },
  /** Same height for every tab so labels sit on one row regardless of icon / badge / WhatsApp circle */
  navIconSlot: {
    height: 28,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeStack: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
  },
  badgeAnchor: {
    position: 'absolute',
    top: -8,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.background.tertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  badgeText: {
    fontSize: 7,
    fontWeight: '700',
    color: colors.text.tertiary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  navLabel: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '600',
    color: colors.text.tertiary,
    marginTop: 2,
    width: '100%',
    textAlign: 'center',
    ...Platform.select({
      android: { includeFontPadding: false as const },
      default: {},
    }),
  },
  navLabelActive: {
    color: colors.accent.gold,
    fontWeight: '700',
    lineHeight: 12,
  },
});
