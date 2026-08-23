/**
 * Marketing empty state for AI Agents when the user has none yet.
 * Sells opening + monitoring capabilities.
 */
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { WalletHubCardArt } from './WalletHubCardArt';

/** Public showcase (Vercel) — house agents live demo. */
const SHOWCASE_URL = 'https://ai.hypertrade.exchange';

const MODEL_LOGOS: { src: ImageSourcePropType; id: string }[] = [
  { src: require('../../assets/images/chatgpt.webp'), id: 'gpt' },
  { src: require('../../assets/images/gemini.webp'), id: 'gemini' },
  { src: require('../../assets/images/claude.webp'), id: 'claude' },
  { src: require('../../assets/images/deepseek.webp'), id: 'deepseek' },
  { src: require('../../assets/images/xai-black.webp'), id: 'grok' },
];

/** Same charcoal gradient as profile wallet / funds cards. */
const HERO_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;
const BRAND_CTA_GRADIENT = [colors.accent.gold, colors.accent.purple] as const;

type Capability = {
  icon: keyof typeof Ionicons.glyphMap;
  titleKey: string;
  bodyKey: string;
};

const CAPABILITIES: Capability[] = [
  {
    icon: 'analytics-outline',
    titleKey: 'aiAgents.emptyAnalyzeTitle',
    bodyKey: 'aiAgents.emptyAnalyzeBody',
  },
  {
    icon: 'pulse-outline',
    titleKey: 'aiAgents.emptyMonitorTitle',
    bodyKey: 'aiAgents.emptyMonitorBody',
  },
  {
    icon: 'shield-checkmark-outline',
    titleKey: 'aiAgents.emptyProtectTitle',
    bodyKey: 'aiAgents.emptyProtectBody',
  },
  {
    icon: 'hand-left-outline',
    titleKey: 'aiAgents.emptyControlTitle',
    bodyKey: 'aiAgents.emptyControlBody',
  },
];

type Props = {
  onCreate: () => void;
};

export function AiAgentsEmptyState({ onCreate }: Props) {
  const { t } = useTranslation();
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(18)).current;
  const logoPulse = useRef(new Animated.Value(0)).current;

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
        Animated.timing(logoPulse, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(logoPulse, {
          toValue: 0,
          duration: 1600,
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
  }, [fadeIn, slideUp, logoPulse]);

  const logoScale = logoPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.03],
  });

  return (
    <Animated.View
      style={[
        styles.root,
        { opacity: fadeIn, transform: [{ translateY: slideUp }] },
      ]}
    >
      <LinearGradient
        colors={HERO_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <WalletHubCardArt />
        <View style={styles.heroBody}>
          <Text style={styles.heroKicker}>{t('aiAgents.emptyHeroKicker')}</Text>

          <Animated.View style={[styles.logoRow, { transform: [{ scale: logoScale }] }]}>
            {MODEL_LOGOS.map((m) => (
              <View key={m.id} style={styles.logoChip}>
                <Image source={m.src} style={styles.logo} resizeMode="contain" />
              </View>
            ))}
          </Animated.View>

          <View style={styles.cycleRow}>
            {[
              t('aiAgents.emptyHeroStepOpen'),
              t('aiAgents.emptyHeroStepManage'),
              t('aiAgents.emptyHeroStepProtect'),
            ].map((label, i) => (
              <React.Fragment key={label}>
                {i > 0 ? (
                  <Ionicons name="chevron-forward" size={12} color={colors.text.secondary} />
                ) : null}
                <View style={styles.cycleChip}>
                  <Text style={styles.cycleChipText}>{label}</Text>
                </View>
              </React.Fragment>
            ))}
          </View>

          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              void Linking.openURL(SHOWCASE_URL).catch(() => {});
            }}
            style={styles.liveDemoWrap}
            accessibilityRole="link"
            accessibilityLabel={t('aiAgents.liveDemoBadge')}
          >
            <LinearGradient
              colors={[`${colors.accent.gold}25`, `${colors.accent.purple}25`]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.liveDemoBadge}
            >
              <Ionicons name="pulse-outline" size={14} color={colors.accent.gold} />
              <Text style={styles.liveDemoText}>{t('aiAgents.liveDemoBadge')}</Text>
              <Ionicons name="open-outline" size={12} color={colors.accent.gold} />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <Text style={styles.title}>{t('aiAgents.emptyTitle')}</Text>
      <Text style={styles.subtitle}>{t('aiAgents.emptySubtitle')}</Text>

      <View style={styles.capabilities}>
        {CAPABILITIES.map((cap, idx) => (
          <View key={cap.titleKey} style={styles.capRow}>
            <LinearGradient
              colors={
                idx % 2 === 0
                  ? [`${colors.accent.gold}28`, `${colors.accent.gold}0A`]
                  : [`${colors.accent.purple}28`, `${colors.accent.purple}0A`]
              }
              style={styles.capIcon}
            >
              <Ionicons
                name={cap.icon}
                size={18}
                color={idx % 2 === 0 ? colors.accent.gold : colors.accent.purple}
              />
            </LinearGradient>
            <View style={styles.capText}>
              <Text style={styles.capTitle}>{t(cap.titleKey)}</Text>
              <Text style={styles.capBody}>{t(cap.bodyKey)}</Text>
            </View>
          </View>
        ))}
      </View>

      <TouchableOpacity activeOpacity={0.85} onPress={onCreate} style={styles.ctaWrap}>
        <LinearGradient
          colors={BRAND_CTA_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.cta}
        >
          <Ionicons name="add-circle-outline" size={18} color={colors.background.primary} />
          <Text style={styles.ctaText}>{t('aiAgents.emptyCta')}</Text>
        </LinearGradient>
      </TouchableOpacity>

      <Text style={styles.footnote}>{t('aiAgents.emptyFootnote')}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 28,
  },
  /** Matches DepositPanel profile wallet hub (gradient + WalletHubCardArt). */
  hero: {
    borderRadius: 16,
    paddingTop: 16,
    paddingBottom: 16,
    paddingHorizontal: 16,
    marginBottom: 20,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${colors.accent.gold}22`,
  },
  heroBody: {
    position: 'relative',
    zIndex: 1,
    alignItems: 'center',
    width: '100%',
  },
  heroKicker: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 14,
    width: '100%',
  },
  logoChip: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 30,
    height: 30,
  },
  cycleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  cycleChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  cycleChipText: {
    color: colors.text.primary,
    fontSize: 11,
    fontWeight: '700',
  },
  /** Same pill language as bank KYC “Unlock with KYC” badge. */
  liveDemoWrap: {
    alignSelf: 'center',
    marginTop: 14,
  },
  liveDemoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}40`,
  },
  liveDemoText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent.gold,
    letterSpacing: 0.3,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
    lineHeight: 28,
    letterSpacing: -0.4,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 13,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 22,
    paddingHorizontal: 6,
  },
  capabilities: {
    gap: 14,
    marginBottom: 24,
  },
  capRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  capIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  capText: {
    flex: 1,
    gap: 2,
  },
  capTitle: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  capBody: {
    color: colors.text.tertiary,
    fontSize: 12,
    lineHeight: 17,
  },
  ctaWrap: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    paddingHorizontal: 18,
  },
  ctaText: {
    color: colors.background.primary,
    fontSize: 15,
    fontWeight: '800',
  },
  footnote: {
    marginTop: 12,
    textAlign: 'center',
    color: colors.text.muted,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 8,
  },
});
