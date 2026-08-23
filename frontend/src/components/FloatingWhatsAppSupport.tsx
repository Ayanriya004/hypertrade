import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform,
  I18nManager,
  AccessibilityActionEvent,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { buildWhatsAppSupportUrl } from '../lib/support';

const STORAGE_KEY = '@hypertrade/whatsapp_support_fab_dismissed';

/**
 * Temporary: when `false`, dismissing the FAB hides it fully (no corner peek / gesture zone).
 * Set to `true` to restore collapsed wedge + slide-to-reopen. Storage still records dismissed state.
 */
const WHATSAPP_COLLAPSED_PEEK_ENABLED = false;

/** Visible quarter-circle size (keeps UI minimal). */
const CORNER_R = 22;
/**
 * Invisible drag/tap capture — anchored to physical bottom-right so you can start a slide
 * from beside/under the home indicator where taps are often ignored.
 */
const GESTURE_ZONE = 50;

/**
 * Sticky WhatsApp support FAB (bottom-right). Close collapses to a tiny corner wedge.
 * Slide toward screen center or tap to restore. Persists per device.
 */
export function FloatingWhatsAppSupport() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { t } = useTranslation();
  const [hydrated, setHydrated] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => setExpanded(v !== '1'))
      .finally(() => setHydrated(true));
  }, []);

  const openWhatsApp = useCallback(() => {
    const url = buildWhatsAppSupportUrl(
      t('profile.whatsappPrefill', { defaultValue: 'Hello — HyperTrade' }),
    );
    void Linking.openURL(url);
  }, [t]);

  const collapse = useCallback(() => {
    setExpanded(false);
    void AsyncStorage.setItem(STORAGE_KEY, '1');
  }, []);

  const expand = useCallback(() => {
    setExpanded(true);
    void AsyncStorage.removeItem(STORAGE_KEY);
  }, []);

  const isRTL = I18nManager.isRTL;

  const onSlideEnd = useCallback(
    (translationX: number, translationY: number, velocityX: number, velocityY: number) => {
      const tMin = 14;
      const vSnap = 380;
      const towardCenterX = isRTL ? translationX > tMin : translationX < -tMin;
      const towardCenterY = translationY < -tMin;
      const flickX = isRTL ? velocityX > vSnap : velocityX < -vSnap;
      const flickY = velocityY < -vSnap * 0.7;
      if (towardCenterX || towardCenterY || flickX || flickY) {
        expand();
      }
    },
    [expand, isRTL],
  );

  const collapsedGesture = useMemo(() => {
    const tap = Gesture.Tap().onEnd(() => {
      runOnJS(expand)();
    });
    const pan = Gesture.Pan()
      .onEnd((e) => {
        runOnJS(onSlideEnd)(e.translationX, e.translationY, e.velocityX, e.velocityY);
      });
    return Gesture.Simultaneous(tap, pan);
  }, [expand, onSlideEnd]);

  if (!hydrated || pathname === '/login') {
    return null;
  }

  const bottom = 16 + insets.bottom;
  const edgeInset = 16 + (isRTL ? insets.left : insets.right);

  if (!expanded) {
    if (!WHATSAPP_COLLAPSED_PEEK_ENABLED) {
      return null;
    }

    const collapsedA11y = t('support.whatsappFabCollapsedA11y', {
      defaultValue: 'WhatsApp support — swipe toward the center or tap to show the button',
    });
    const zoneH = GESTURE_ZONE + insets.bottom;

    return (
      <View
        style={[
          styles.peekRoot,
          {
            bottom: 0,
            height: zoneH,
            width: GESTURE_ZONE,
            ...(isRTL ? { left: 0 } : { right: 0 }),
          },
        ]}
        pointerEvents="box-none"
      >
        <GestureDetector gesture={collapsedGesture}>
          <View
            style={styles.gestureFill}
            accessibilityRole="button"
            accessibilityLabel={collapsedA11y}
            accessible
            onAccessibilityAction={(e: AccessibilityActionEvent) => {
              if (e.nativeEvent.actionName === 'activate') {
                expand();
              }
            }}
          >
            {/*
              Wedge sits in the safe corner (above home bar) so it stays visible & tappable.
              The larger transparent gesture area extends to bottom:0 so slides can start lower.
            */}
            <View
              style={[
                styles.cornerWedge,
                isRTL ? styles.cornerWedgeRtl : styles.cornerWedgeLtr,
                {
                  position: 'absolute',
                  bottom: insets.bottom,
                  ...(isRTL ? { left: insets.left } : { right: insets.right }),
                },
              ]}
              pointerEvents="none"
            >
              <Ionicons
                name="arrow-up"
                size={11}
                color="#fff"
                style={isRTL ? styles.wedgeIconRtl : styles.wedgeIconLtr}
              />
            </View>
          </View>
        </GestureDetector>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.root,
        {
          bottom,
          ...(isRTL ? { left: edgeInset } : { right: edgeInset }),
        },
      ]}
      pointerEvents="box-none"
    >
      <View style={styles.fabCluster}>
        <TouchableOpacity
          style={styles.dismissBadge}
          onPress={collapse}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Ionicons name="close" size={14} color={colors.text.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.fab}
          onPress={openWhatsApp}
          activeOpacity={0.88}
          accessibilityRole="link"
          accessibilityLabel={t('profile.contactUs')}
        >
          <Ionicons name="logo-whatsapp" size={28} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    zIndex: 9999,
    elevation: Platform.OS === 'android' ? 12 : 0,
  },
  fabCluster: {
    width: 56,
    height: 56,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#25D366',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  dismissBadge: {
    position: 'absolute',
    top: -8,
    right: -8,
    zIndex: 2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  peekRoot: {
    position: 'absolute',
    zIndex: 9999,
    elevation: Platform.OS === 'android' ? 12 : 0,
  },
  gestureFill: {
    flex: 1,
  },
  cornerWedge: {
    width: CORNER_R,
    height: CORNER_R,
    backgroundColor: '#25D366',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: -1, height: -1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  cornerWedgeLtr: {
    borderTopLeftRadius: CORNER_R,
  },
  cornerWedgeRtl: {
    borderTopRightRadius: CORNER_R,
  },
  wedgeIconLtr: {
    marginTop: 4,
    marginLeft: 4,
    transform: [{ rotate: '-42deg' }],
  },
  wedgeIconRtl: {
    marginTop: 4,
    marginRight: 4,
    transform: [{ rotate: '42deg' }],
  },
});
