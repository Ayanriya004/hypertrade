/**
 * Guest-only home hero carousel — same card shell as the legacy "Start Trading"
 * CTA, with segmented progress bars, auto-advance, and subtle prev/next controls.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';

const SLIDE_MS = 7000;
const SLIDE_COUNT = 4;

const SLIDE_KEYS = [
  {
    titleKey: 'home.guestCarousel.tradeTitle',
    subtitleKey: 'home.guestCarousel.tradeSubtitle',
    ctaKey: 'home.guestCarousel.tradeCta',
  },
  {
    titleKey: 'home.guestCarousel.aiTitle',
    subtitleKey: 'home.guestCarousel.aiSubtitle',
    ctaKey: 'home.guestCarousel.aiCta',
  },
  {
    titleKey: 'home.guestCarousel.bankTitle',
    subtitleKey: 'home.guestCarousel.bankSubtitle',
    ctaKey: 'home.guestCarousel.bankCta',
  },
  {
    titleKey: 'home.guestCarousel.rewardsTitle',
    subtitleKey: 'home.guestCarousel.rewardsSubtitle',
    ctaKey: 'home.guestCarousel.rewardsCta',
  },
] as const;

type GuestCtaCarouselProps = {
  onCtaPress: () => void;
};

function wrapIndex(index: number) {
  return ((index % SLIDE_COUNT) + SLIDE_COUNT) % SLIDE_COUNT;
}

/**
 * Persisted across remounts. The carousel lives inside the home FlatList
 * `ListHeaderComponent`, whose function identity changes on market-data /
 * refresh updates — which remounts the whole header subtree and would otherwise
 * reset the slide back to 0. Keeping the current slide + when it started here
 * lets a remounted carousel resume exactly where it left off instead of jumping.
 */
const carouselMemory = { index: 0, startedAt: Date.now() };

export const GuestCtaCarousel = React.memo(function GuestCtaCarousel({
  onCtaPress,
}: GuestCtaCarouselProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(() => carouselMemory.index);
  const progress = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(1)).current;

  // Single effect keyed on `activeIndex`. React guarantees the cleanup runs
  // before the next effect, so the prior timer + progress animation are always
  // cancelled before a new slide begins — no stale callback can advance the
  // slide out from under the user.
  //
  // `carouselMemory` distinguishes a genuine slide change from a remount:
  //  - genuine change  -> start a fresh SLIDE_MS window
  //  - remount (index unchanged from memory) -> resume from elapsed time
  useEffect(() => {
    const now = Date.now();
    const isContinuation = carouselMemory.index === activeIndex;
    const startedAt = isContinuation ? carouselMemory.startedAt : now;
    carouselMemory.index = activeIndex;
    carouselMemory.startedAt = startedAt;

    const elapsed = Math.min(SLIDE_MS, Math.max(0, now - startedAt));
    const remaining = SLIDE_MS - elapsed;

    progress.setValue(elapsed / SLIDE_MS);
    const progressAnim = Animated.timing(progress, {
      toValue: 1,
      duration: remaining,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    progressAnim.start();

    // Cosmetic crossfade only on genuine slide changes, not on remount resumes.
    let fade: Animated.CompositeAnimation | undefined;
    if (isContinuation) {
      contentOpacity.setValue(1);
    } else {
      contentOpacity.setValue(0.35);
      fade = Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      });
      fade.start();
    }

    const timer = setTimeout(() => {
      setActiveIndex((prev) => wrapIndex(prev + 1));
    }, remaining);

    return () => {
      progressAnim.stop();
      fade?.stop();
      clearTimeout(timer);
    };
  }, [activeIndex, progress, contentOpacity]);

  const goNext = useCallback(() => {
    setActiveIndex((prev) => wrapIndex(prev + 1));
  }, []);

  const goPrev = useCallback(() => {
    setActiveIndex((prev) => wrapIndex(prev - 1));
  }, []);

  const slide = SLIDE_KEYS[activeIndex];

  return (
    <LinearGradient
      colors={['#1a1a2e', '#16213e', '#0f0f1a']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
    >
      <View style={styles.progressRow}>
        {SLIDE_KEYS.map((_, i) => (
          <View key={i} style={styles.segmentTrack}>
            {i < activeIndex ? (
              <View style={[styles.segmentFill, styles.segmentFillDone]} />
            ) : i === activeIndex ? (
              <Animated.View
                style={[
                  styles.segmentFill,
                  {
                    width: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                ]}
              />
            ) : null}
          </View>
        ))}
      </View>

      <Animated.View style={[styles.content, { opacity: contentOpacity }]}>
        <View style={styles.textSection}>
          <Text style={styles.title}>{t(slide.titleKey)}</Text>
          <Text style={styles.subtitle}>{t(slide.subtitleKey)}</Text>
        </View>

        <TouchableOpacity
          style={styles.ctaButton}
          onPress={onCtaPress}
          activeOpacity={0.85}
          accessibilityRole="button"
        >
          <Text style={styles.ctaButtonText}>{t(slide.ctaKey)}</Text>
        </TouchableOpacity>

        <View style={styles.navRow}>
          <TouchableOpacity
            onPress={goPrev}
            style={styles.navHit}
            hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}
            accessibilityRole="button"
            accessibilityLabel={t('home.guestCarousel.previous')}
          >
            <Ionicons name="chevron-back" size={18} color={colors.text.tertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={goNext}
            style={styles.navHit}
            hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}
            accessibilityRole="button"
            accessibilityLabel={t('home.guestCarousel.next')}
          >
            <Ionicons name="chevron-forward" size={18} color={colors.text.tertiary} />
          </TouchableOpacity>
        </View>
      </Animated.View>
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 16,
  },
  segmentTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    overflow: 'hidden',
  },
  segmentFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.accent.gold,
  },
  segmentFillDone: {
    width: '100%',
  },
  content: {
    alignItems: 'center',
  },
  textSection: {
    alignItems: 'center',
    marginBottom: 16,
    minHeight: 56,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 6,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  ctaButton: {
    backgroundColor: colors.accent.gold,
    paddingVertical: 10,
    paddingHorizontal: 32,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 0.6,
    shadowRadius: 0,
    elevation: 4,
  },
  ctaButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.background.primary,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
    marginTop: 12,
  },
  navHit: {
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.7,
  },
});
