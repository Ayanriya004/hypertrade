/**
 * In-modal trade success/error banner. Memoized + Reanimated so WS-driven
 * re-renders on the parent trade screen do not re-reconcile this subtree;
 * enter motion runs on the UI thread.
 */
import React, { memo, useEffect } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

export type FloatingTradeAlertVariant = 'success' | 'error';

type FloatingTradeAlertProps = {
  title: string;
  message: string;
  variant: FloatingTradeAlertVariant;
  top: number;
};

const ENTER_MS = 260;
const ICONS: Record<
  FloatingTradeAlertVariant,
  { name: keyof typeof Ionicons.glyphMap; color: string; border: string }
> = {
  success: {
    name: 'checkmark-circle',
    color: colors.accent.gold,
    border: `${colors.accent.gold}30`,
  },
  error: {
    name: 'alert-circle',
    color: colors.status.error,
    border: `${colors.status.error}40`,
  },
};

function FloatingTradeAlertInner({ title, message, variant, top }: FloatingTradeAlertProps) {
  const cfg = ICONS[variant];
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-10);

  useEffect(() => {
    opacity.value = 0;
    translateY.value = -10;
    opacity.value = withTiming(1, {
      duration: ENTER_MS,
      easing: Easing.out(Easing.cubic),
    });
    translateY.value = withTiming(0, {
      duration: ENTER_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [title, message, variant, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View pointerEvents="none" style={[styles.wrap, { top }]}>
      <Animated.View style={[styles.banner, { borderColor: cfg.border }, animatedStyle]}>
        <Ionicons name={cfg.name} size={20} color={cfg.color} />
        <View style={styles.textWrap}>
          <Text style={[styles.title, { color: cfg.color }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.message} numberOfLines={variant === 'error' ? 3 : 2}>
            {message}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

export const FloatingTradeAlert = memo(FloatingTradeAlertInner);

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10000,
    elevation: 10000,
  },
  banner: {
    width: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...(Platform.OS === 'ios'
      ? {
          shadowColor: '#000',
          shadowOpacity: 0.12,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        }
      : { elevation: 3 }),
  },
  textWrap: { flex: 1, marginLeft: 10 },
  title: { fontSize: 13, fontWeight: '800', marginBottom: 2 },
  message: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 16,
  },
});
