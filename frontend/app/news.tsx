import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Image,
  Platform,
  type ImageSourcePropType,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../src/theme/colors';
import { NewsListSkeleton } from '../src/components/skeleton/NewsListSkeleton';
import { fetchMarketNews, type NewsCategory, type NewsItem, type MarketNewsResponse } from '../src/lib/api';
import { openHttpsUrl } from '../src/lib/openHttpsUrl';

const CATEGORIES: { key: NewsCategory; i18nKey: string }[] = [
  { key: 'general', i18nKey: 'news.tabs.general' },
  { key: 'stocks', i18nKey: 'news.tabs.stocks' },
  { key: 'crypto', i18nKey: 'news.tabs.crypto' },
];

const MAX_NEWS_PER_CATEGORY = 10;

/** Render the published timestamp as a compact relative ("3h", "2d"). */
function formatRelativeTime(unixSeconds: number, locale: string, fallback: string): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return fallback;
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - unixSeconds);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d`;
  // Older than a week — show date in user locale (short form)
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return `${Math.floor(diff / 86400)}d`;
  }
}

/** Newest story timestamp in a feed — used to avoid replacing a fresh tab
 *  cache with an older payload from another API replica. */
function maxStoryUnix(data: MarketNewsResponse | undefined): number {
  if (!data?.items?.length) return 0;
  return Math.max(...data.items.map((i) => (Number.isFinite(i.datetime) ? i.datetime : 0)));
}

/** How many of the rendered rows still lack a Gemini headline for *localeBase*.
 *  Mirrors backend `_NEWS_TRANSLATE_TOP_N` (top 10 only). */
function countMissingTranslations(items: NewsItem[], localeBase: string): number {
  if (localeBase === 'en') return 0;
  return items.slice(0, MAX_NEWS_PER_CATEGORY).filter((item) => {
    if (!item.headline?.trim()) return false;
    return !item.translations?.[localeBase]?.trim();
  }).length;
}

const TRANSLATION_POLL_DELAYS_MS = [3000, 6000, 12000] as const;

export default function NewsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [activeCategory, setActiveCategory] = useState<NewsCategory>('general');
  /** Set true right before pull-to-refresh so the next fetch sends `refresh=1` and bypasses the backend in-process TTL. */
  const forceRefreshNextFetch = useRef(false);
  /** Cancels in-flight translation poll loops when tab/locale/feed changes. */
  const translationPollGen = useRef(0);

  const newsLocale = i18n.language.split('-')[0].toLowerCase();

  const query = useQuery({
    queryKey: ['market-news', activeCategory, newsLocale],
    queryFn: () => {
      const refresh = forceRefreshNextFetch.current;
      forceRefreshNextFetch.current = false;
      return fetchMarketNews(activeCategory, MAX_NEWS_PER_CATEGORY, {
        refresh,
        locale: newsLocale,
      });
    },
    // Treat data fresh for 5 min — matches roughly half the backend TTL,
    // so we usually serve from local cache and avoid spinners on tab toggles.
    staleTime: 5 * 60_000,
    // Backend already auto-refreshes every 30 min via stale-while-revalidate.
    // No need to hammer the API while the screen is open; refetch only on
    // pull-to-refresh or explicit user action.
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const items = useMemo<NewsItem[]>(() => query.data?.items ?? [], [query.data]);

  // Non-English feeds can briefly show English headlines when the backend
  // served cache before background Gemini finished (English-fast refresh path,
  // warmup, or stale-while-revalidate). Poll quietly — no refresh=1 — until
  // translations land or we exhaust a short backoff schedule.
  useEffect(() => {
    if (newsLocale === 'en' || !query.isSuccess || !query.data?.items?.length) return;
    if (countMissingTranslations(query.data.items, newsLocale) === 0) return;

    const pollGen = ++translationPollGen.current;
    const queryKey = ['market-news', activeCategory, newsLocale] as const;
    let cancelled = false;

    void (async () => {
      for (const delayMs of TRANSLATION_POLL_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (cancelled || translationPollGen.current !== pollGen) return;

        const cached = queryClient.getQueryData<MarketNewsResponse>(queryKey);
        if (cached && countMissingTranslations(cached.items, newsLocale) === 0) return;

        try {
          const next = await fetchMarketNews(activeCategory, MAX_NEWS_PER_CATEGORY, {
            locale: newsLocale,
          });
          if (cancelled || translationPollGen.current !== pollGen) return;

          const existing = queryClient.getQueryData<MarketNewsResponse>(queryKey);
          const exMax = maxStoryUnix(existing);
          const nxMax = maxStoryUnix(next);
          const exAt = existing?.fetched_at ?? 0;
          const nxAt = next.fetched_at ?? 0;
          if (existing && nxMax < exMax) continue;
          if (existing && nxMax === exMax && nxAt < exAt) continue;
          queryClient.setQueryData(queryKey, next);

          if (countMissingTranslations(next.items, newsLocale) === 0) return;
        } catch {
          // Best-effort; next delay may succeed once background Gemini completes.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeCategory, newsLocale, query.isSuccess, query.data?.fetched_at, queryClient]);

  // Prefetch other tabs for snappy switches — but never overwrite a tab's
  // React Query cache with a *staler* snapshot. Multi-replica backends can
  // return older in-process cached JSON than what the user just got from
  // pull-to-refresh on another replica.
  useEffect(() => {
    if (!query.isSuccess) return;
    let cancelled = false;
    void (async () => {
      for (const c of CATEGORIES) {
        if (cancelled) return;
        if (c.key === activeCategory) continue;
        const key = ['market-news', c.key, newsLocale] as const;
        const existing = queryClient.getQueryData<MarketNewsResponse>(key);
        try {
          const next = await fetchMarketNews(c.key, MAX_NEWS_PER_CATEGORY, {
            locale: newsLocale,
          });
          if (cancelled) return;
          const exMax = maxStoryUnix(existing);
          const nxMax = maxStoryUnix(next);
          const exAt = existing?.fetched_at ?? 0;
          const nxAt = next.fetched_at ?? 0;
          if (existing && nxMax < exMax) continue;
          if (existing && nxMax === exMax && nxAt < exAt) continue;
          queryClient.setQueryData(key, next);
        } catch {
          // Prefetch is best-effort; leave prior cache (or empty) as-is.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query.isSuccess, activeCategory, newsLocale, queryClient]);

  const handleOpen = useCallback((url: string) => {
    if (!url) return;
    void openHttpsUrl(url).catch(() => {
      // Non-blocking: just swallow so we don't crash if the URL fails to open.
    });
  }, []);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const onRefresh = useCallback(() => {
    forceRefreshNextFetch.current = true;
    void query.refetch();
  }, [query]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleBack}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel={t('common.goBack')}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('news.title')}</Text>
        <View style={styles.headerRightSpacer} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsRow}
        style={styles.tabsScroller}
      >
        {CATEGORIES.map((c) => {
          const isActive = activeCategory === c.key;
          return (
            <TouchableOpacity
              key={c.key}
              onPress={() => setActiveCategory(c.key)}
              activeOpacity={0.7}
              style={styles.tabItem}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]} numberOfLines={1}>
                {t(c.i18nKey)}
              </Text>
              {isActive ? <View style={styles.tabUnderline} /> : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: 80 + Math.max(0, insets.bottom) },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={query.isFetching && !query.isLoading}
            onRefresh={onRefresh}
            tintColor={colors.accent.gold}
          />
        }
      >
        {query.isLoading ? (
          <NewsListSkeleton rowCount={MAX_NEWS_PER_CATEGORY} />
        ) : query.isError ? (
          <View style={styles.stateWrap}>
            <Ionicons name="cloud-offline-outline" size={28} color={colors.text.tertiary} />
            <Text style={styles.stateText}>{t('news.errorLoading')}</Text>
            <TouchableOpacity onPress={onRefresh} style={styles.retryButton}>
              <Text style={styles.retryButtonText}>{t('common.tryAgain')}</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.stateWrap}>
            <Ionicons name="newspaper-outline" size={28} color={colors.text.tertiary} />
            <Text style={styles.stateText}>{t('news.empty')}</Text>
          </View>
        ) : (
          items.map((item, idx) => (
            <NewsRow
              key={`${item.id ?? idx}-${item.url}`}
              item={item}
              locale={i18n.language}
              onOpen={handleOpen}
              fallbackTime={t('news.justNow')}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Extract the first plausible ticker symbol from Finnhub's `related` field.
 *  The field is sometimes a comma-separated list; we only show it if the
 *  first token looks like a ticker (uppercase letters/digits, ≤ 6 chars). */
function pickTicker(related: string): string | null {
  if (!related) return null;
  const first = related.split(',')[0]?.trim();
  if (!first || first.length > 6) return null;
  return /^[A-Z0-9.\-]+$/.test(first) ? first : null;
}

/** URL substrings that mark a generic source-branding image rather than a
 *  real article thumbnail. Finnhub frequently returns one of these as a
 *  fallback for Yahoo Finance / Reuters / etc., which look ugly when
 *  cropped to a 72px square ("YAHO", "REUT", ...). When we hit one of
 *  these, we render a clean letter tile in the thumbnail slot instead. */
const PLACEHOLDER_IMAGE_PATTERNS: readonly string[] = [
  'yahoo_finance',           // s.yimg.com/.../yahoo_finance_en-US_h_p_finance_2.png
  'yimg.com/rz/stage',       // other Yahoo brand stage assets
  'reuters.com/pf/resources',// Reuters page-framework branding
  'reutersmedia.net',        // legacy Reuters static branding host
  '/logo.',                  // generic "/logo.png", "/logo.svg"
  '/branding/',              // generic branding folder
  'default-image',           // common CMS default
  'placeholder',
];

/** True when the URL looks like a generic source-logo placeholder rather
 *  than a real article photo. Case-insensitive substring match. */
function isPlaceholderImage(url: string | null | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return PLACEHOLDER_IMAGE_PATTERNS.some((p) => lower.includes(p));
}

/** Brand assets shipped in `frontend/assets/images/`. Sources listed here
 *  always render with their official logo in the thumbnail slot, ignoring
 *  whatever (usually placeholder) image Finnhub sent. Add new entries as
 *  more sources need brand-consistent rendering. */
const BRAND_ICONS: Record<string, ImageSourcePropType> = {
  yahoo: require('../assets/images/yahoofinance.webp') as ImageSourcePropType,
  reuters: require('../assets/images/reuters.webp') as ImageSourcePropType,
};

/** Map a Finnhub source name to a brand asset, if we have one.
 *  Normalizes whitespace/case so "Yahoo", "Yahoo Finance", "yahoo finance"
 *  all resolve to the same icon. */
function brandIconFor(source: string): ImageSourcePropType | null {
  if (!source) return null;
  const key = source.toLowerCase().replace(/[^a-z]/g, '');
  if (key.includes('reuters')) return BRAND_ICONS.reuters;
  if (key.includes('yahoo')) return BRAND_ICONS.yahoo;
  return null;
}

/** 72×72 tile that displays an official brand logo (Reuters, Yahoo, …)
 *  on a clean light background so the artwork stays crisp and uncropped. */
function BrandTile({ icon }: { icon: ImageSourcePropType }) {
  return (
    <View style={[styles.thumbnail, styles.brandTile]}>
      <Image source={icon} style={styles.brandIcon} resizeMode="contain" />
    </View>
  );
}

/** Deterministic per-source color so Reuters is always the same hue,
 *  Yahoo is always the same hue, etc. Uses a tiny djb2 hash into a
 *  hand-picked dark-theme palette. */
const TILE_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#3B2A2D', fg: '#FFB3BA' }, // rose
  { bg: '#2D3A2B', fg: '#B3FFC0' }, // green
  { bg: '#2B3142', fg: '#B3D9FF' }, // blue
  { bg: '#3A2E2B', fg: '#FFD7B3' }, // amber
  { bg: '#322B3A', fg: '#D7B3FF' }, // purple
  { bg: '#2B3A3A', fg: '#B3FFFF' }, // teal
  { bg: '#3A2B36', fg: '#FFB3E1' }, // pink
  { bg: '#2E331F', fg: '#E1FFB3' }, // lime
];

function colorForSource(source: string): { bg: string; fg: string } {
  const key = (source || '?').toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return TILE_PALETTE[Math.abs(h) % TILE_PALETTE.length];
}

/** 72×72 letter tile shown in the thumbnail slot whenever the upstream
 *  image is missing, broken, or a generic source-logo placeholder. */
function SourceTile({ source }: { source: string }) {
  const letter = (source || '?').trim().charAt(0).toUpperCase() || '?';
  const { bg, fg } = colorForSource(source);
  return (
    <View style={[styles.thumbnail, styles.sourceTile, { backgroundColor: bg }]}>
      <Text style={[styles.sourceTileLetter, { color: fg }]} numberOfLines={1} allowFontScaling={false}>
        {letter}
      </Text>
    </View>
  );
}

function NewsRow({
  item,
  locale,
  onOpen,
  fallbackTime,
}: {
  item: NewsItem;
  locale: string;
  onOpen: (url: string) => void;
  fallbackTime: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const hasImageUrl = Boolean(item.image);
  const isPlaceholder = isPlaceholderImage(item.image);
  // Thumbnail precedence:
  //   1. Brand icon — for sources we have a local asset for (Reuters,
  //      Yahoo, …). Always wins so the brand stays consistent and we
  //      avoid cropped logos like "REUT"/"YAHO".
  //   2. Real upstream image — when it's not a known placeholder and
  //      hasn't failed to load.
  //   3. Letter tile — styled fallback when we attempted an image but
  //      it was a placeholder or failed.
  //   4. Nothing — when there was never an image to begin with.
  const brandIcon = brandIconFor(item.source);
  const showBrandIcon = brandIcon !== null;
  const showRealImage = !showBrandIcon && hasImageUrl && !isPlaceholder && !imgFailed;
  const showLetterTile = !showBrandIcon && hasImageUrl && (isPlaceholder || imgFailed);
  const initial = (item.source || '?').trim().charAt(0).toUpperCase();
  const timeLabel = formatRelativeTime(item.datetime, locale, fallbackTime);
  const ticker = pickTicker(item.related);

  // Localized headline: backend translates only the top-N items into our
  // target locales. Fall back to the English original when the translation
  // is missing for any reason (slot beyond top-N, Gemini soft-fail, etc.).
  // i18n.language can carry a region tag ("zh-CN") so we strip to the base.
  const baseLocale = (locale || 'en').toLowerCase().split('-')[0];
  const isEnglish = baseLocale === 'en';
  const displayHeadline = isEnglish
    ? item.headline
    : item.translations?.[baseLocale] || item.headline;
  // Summary stays in English upstream and we deliberately don't translate
  // it (cost reduction). To avoid showing a mixed-language card, hide
  // the summary entirely for non-English users.
  const showSummary = isEnglish && Boolean(item.summary);

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() => onOpen(item.url)}
      style={styles.row}
      accessibilityRole="link"
      accessibilityLabel={displayHeadline}
    >
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          {ticker ? (
            <View style={styles.tickerChip}>
              <Text style={styles.tickerChipText} numberOfLines={1}>
                {ticker}
              </Text>
            </View>
          ) : (
            <View style={styles.sourceDot}>
              <Text style={styles.sourceDotText} numberOfLines={1}>
                {initial}
              </Text>
            </View>
          )}
          <Text style={styles.sourceName} numberOfLines={1}>
            {item.source || '—'}
          </Text>
          <Text style={styles.sourceSeparator}>·</Text>
          <Text style={styles.timeText} numberOfLines={1}>
            {timeLabel}
          </Text>
        </View>

        <View style={styles.headlineRow}>
          <View style={styles.headlineCol}>
            <Text style={styles.headline} numberOfLines={3}>
              {displayHeadline}
            </Text>
            {showSummary ? (
              <Text style={styles.summary} numberOfLines={2}>
                {item.summary}
              </Text>
            ) : null}
          </View>
          {showBrandIcon && brandIcon ? (
            <BrandTile icon={brandIcon} />
          ) : showRealImage ? (
            <Image
              source={{ uri: item.image }}
              style={styles.thumbnail}
              onError={() => setImgFailed(true)}
              resizeMode="cover"
            />
          ) : showLetterTile ? (
            <SourceTile source={item.source} />
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
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
  backButton: {
    padding: 6,
  },
  headerTitle: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
  },
  headerRightSpacer: {
    width: 32,
  },
  tabsScroller: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  tabsRow: {
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  tabItem: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  tabLabelActive: {
    color: colors.text.primary,
    fontWeight: '700',
  },
  tabUnderline: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 0,
    height: 2,
    borderRadius: 2,
    backgroundColor: colors.accent.gold,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 4,
  },
  stateWrap: {
    paddingVertical: 48,
    alignItems: 'center',
    gap: 10,
  },
  stateText: {
    color: colors.text.tertiary,
    fontSize: 14,
    marginTop: 6,
  },
  retryButton: {
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.secondary,
    backgroundColor: colors.background.tertiary,
  },
  retryButtonText: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  rowContent: {
    gap: 8,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sourceDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.background.tertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  sourceDotText: {
    color: colors.accent.gold,
    fontSize: 10,
    fontWeight: '700',
    ...Platform.select({
      android: { includeFontPadding: false as const },
      default: {},
    }),
  },
  tickerChip: {
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 4,
    backgroundColor: 'rgba(92, 225, 230, 0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(92, 225, 230, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  tickerChipText: {
    color: colors.accent.gold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    ...Platform.select({
      android: { includeFontPadding: false as const },
      default: {},
    }),
  },
  sourceName: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '600',
    maxWidth: '55%',
  },
  sourceSeparator: {
    color: colors.text.tertiary,
    fontSize: 12,
    marginHorizontal: 6,
  },
  timeText: {
    color: colors.text.tertiary,
    fontSize: 12,
  },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headlineCol: {
    flex: 1,
  },
  headline: {
    color: colors.text.primary,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  summary: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  thumbnail: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: colors.background.tertiary,
  },
  sourceTile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sourceTileLetter: {
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -1,
    ...Platform.select({
      android: { includeFontPadding: false as const },
      default: {},
    }),
  },
  brandTile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
  },
  brandIcon: {
    width: '100%',
    height: '100%',
  },
});
