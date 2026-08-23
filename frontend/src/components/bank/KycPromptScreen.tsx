/**
 * KycPromptScreen — pre-KYC sales/marketing layout for the Cash + Card tabs.
 *
 * Until a user is `Live` on UR (chainStatus === 5 — see
 * docs/concepts/kyc-and-compliance) they cannot use IBANs, cards, FX, or
 * off-ramp. Rather than showing an empty "coming soon" placeholder, we sell
 * the service: highlight the benefits they unlock by completing KYC and
 * surface a single "Start KYC" CTA.
 *
 * Used from `app/bank.tsx` (Cash tab) when the user is linked but not Live.
 *   - Cash tab → free multi-currency IBAN + card combo
 *   - Card tab → free Mastercard + Apple/Google Pay
 *
 * The "Start KYC" CTA (`onStartKyc`) launches the self-serve Sumsub mobile
 * flow via `useUrKyc` (wallet Full-Auth → UR `create-access-token`). The NFC
 * scan only runs in a dev/production build; Expo Go surfaces a clear toast.
 */
import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
  Image,
  type ImageSourcePropType,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { BouncingDots } from '../BouncingDots';

export interface KycFeature {
  icon?: keyof typeof Ionicons.glyphMap;
  /** Optional logo inline beside feature text (e.g. FINMA badge on f1). */
  textLogo?: ImageSourcePropType;
  text: string;
}

export interface KycPromptScreenProps {
  /** Custom hero visual (rendered above the badge). */
  hero: React.ReactNode;
  /** Pill text under the hero. e.g. "Unlock with KYC". */
  badgeLabel: string;
  /** Big headline. */
  title: string;
  /** Sub-headline body copy under the title. */
  subtitle: string;
  /** Vertical feature list — keep to 4-6 entries for visual balance. */
  features: KycFeature[];
  /** CTA button label. */
  ctaLabel: string;
  /** Fires on CTA tap. */
  onStartKyc: () => void;
  /** Disable + dim the CTA (e.g. while KYC is launching). */
  ctaDisabled?: boolean;
  /** In-flight (launching Sumsub / signing Form A): swap the leading icon for
   *  bouncing dots so the button reads as actively working, not stuck. */
  ctaLoading?: boolean;
  /** Optional muted footnote under the CTA. */
  footnote?: string;
  /** Terms acceptance line with link — used on Cash KYC instead of `footnote`. */
  showTermsFootnote?: boolean;
  /** Opens in-app Terms of Service (required when `showTermsFootnote`). */
  onTermsPress?: () => void;
  /** Optional secondary action (e.g. "Learn more"). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Optional region picker control shown to the left of the CTA. */
  regionSelector?: React.ReactNode;
  /** When set, replaces the default KYC gradient button (e.g. waitlist notify). */
  ctaSlot?: React.ReactNode;
  /** Hide the apply row (maintenance pause — banner explains instead). */
  hideCta?: boolean;
}

export function KycPromptScreen({
  hero,
  badgeLabel,
  title,
  subtitle,
  features,
  ctaLabel,
  onStartKyc,
  ctaDisabled,
  ctaLoading,
  footnote,
  showTermsFootnote,
  onTermsPress,
  secondaryLabel,
  onSecondary,
  regionSelector,
  ctaSlot,
  hideCta,
}: KycPromptScreenProps) {
  const { t } = useTranslation();
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(16)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const intro = Animated.parallel([
      Animated.timing(fadeIn, {
        toValue: 1,
        duration: 520,
        useNativeDriver: true,
      }),
      Animated.timing(slideUp, {
        toValue: 0,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    intro.start();

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.start();

    return () => {
      intro.stop();
      pulseLoop.stop();
    };
  }, [fadeIn, slideUp, pulse]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.03],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        { opacity: fadeIn, transform: [{ translateY: slideUp }] },
      ]}
    >
      <View style={styles.heroWrap}>{hero}</View>

      <Animated.View style={[styles.badgeWrap, { transform: [{ scale: pulseScale }] }]}>
        <LinearGradient
          colors={[`${colors.accent.gold}25`, `${colors.accent.purple}25`]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.badge}
        >
          <Ionicons name="shield-checkmark-outline" size={14} color={colors.accent.gold} />
          <Text style={styles.badgeText}>{badgeLabel}</Text>
        </LinearGradient>
      </Animated.View>

      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>

      <View style={styles.features}>
        {features.map((f, idx) => (
          <View key={`${f.icon ?? 'feat'}-${idx}`} style={styles.featureRow}>
            <LinearGradient
              colors={
                idx % 2 === 0
                  ? [`${colors.accent.gold}26`, `${colors.accent.gold}08`]
                  : [`${colors.accent.purple}26`, `${colors.accent.purple}08`]
              }
              style={styles.featureIcon}
            >
              <Ionicons
                name={f.icon ?? 'ellipse-outline'}
                size={18}
                color={idx % 2 === 0 ? colors.accent.gold : colors.accent.purple}
              />
            </LinearGradient>
            <View style={styles.featureTextWrap}>
              {f.textLogo ? (
                <Image source={f.textLogo} style={styles.featureTextLogo} resizeMode="contain" />
              ) : null}
              <Text style={styles.featureText}>{f.text}</Text>
            </View>
          </View>
        ))}
      </View>

      {hideCta ? null : (
      <View style={styles.ctaSection}>
        <View style={styles.ctaRow}>
          {regionSelector}
          {ctaSlot ? (
            <View style={[styles.ctaWrap, !!regionSelector && styles.ctaWrapFlex]}>
              {ctaSlot}
            </View>
          ) : (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={onStartKyc}
              disabled={ctaDisabled}
              style={[
                styles.ctaWrap,
                ctaDisabled && styles.ctaDisabled,
                !!regionSelector && styles.ctaWrapFlex,
              ]}
            >
              <LinearGradient
                colors={[colors.accent.gold, colors.accent.purple]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.cta}
              >
                {ctaLoading ? (
                  <BouncingDots
                    color={colors.background.primary}
                    dotSize={5}
                    style={styles.ctaDots}
                  />
                ) : (
                  <Ionicons name="finger-print-outline" size={18} color={colors.background.primary} />
                )}
                <Text style={styles.ctaText}>
                  {ctaLoading ? ctaLabel.replace(/[.\u2026]+$/, '') : ctaLabel}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          )}
        </View>
        {showTermsFootnote ? (
          <Text style={styles.footnote}>
            {t('login.termsText')}{' '}
            <Text style={styles.footnoteLink} onPress={onTermsPress}>
              {t('login.termsOfService')}
            </Text>
            .
          </Text>
        ) : footnote ? (
          <Text style={styles.footnote}>{footnote}</Text>
        ) : null}
      </View>
      )}
      {!!secondaryLabel && !!onSecondary && (
          <TouchableOpacity
            onPress={onSecondary}
            hitSlop={8}
            style={styles.secondaryWrap}
            accessibilityRole="button"
          >
            <Text style={styles.secondary}>{secondaryLabel}</Text>
          </TouchableOpacity>
        )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 24,
  },
  heroWrap: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 18,
  },
  badgeWrap: {
    alignSelf: 'center',
    marginBottom: 14,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}40`,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent.gold,
    letterSpacing: 0.3,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
    lineHeight: 28,
    letterSpacing: -0.4,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 12,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 22,
    paddingHorizontal: 4,
  },
  features: {
    gap: 12,
    marginBottom: 22,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 4,
  },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  featureTextLogo: {
    width: 22,
    height: 22,
    flexShrink: 0,
  },
  featureText: {
    flex: 1,
    fontSize: 13.5,
    color: colors.text.primary,
    fontWeight: '500',
    lineHeight: 19,
  },
  ctaSection: {
    alignItems: 'stretch',
    gap: 12,
  },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ctaWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    alignSelf: 'stretch',
    flex: 1,
  },
  ctaWrapFlex: {
    flex: 1,
    alignSelf: 'auto',
  },
  ctaDisabled: {
    opacity: 0.6,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
    letterSpacing: 0.2,
  },
  // Keeps the dots optically centered next to the label (they bounce up from a
  // flex-end baseline, so nudge down slightly to sit level with the text).
  ctaDots: {
    marginBottom: -2,
  },
  footnote: {
    fontSize: 11.5,
    color: colors.text.muted,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  footnoteLink: {
    color: colors.accent.gold,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  secondaryWrap: {
    alignSelf: 'center',
  },
  secondary: {
    fontSize: 13,
    color: colors.accent.gold,
    fontWeight: '600',
    textDecorationLine: 'underline',
    textAlign: 'center',
  },
});
