import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, TouchableOpacity } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { fetchGeminiAnalysis } from '../lib/api';
import { useAuth } from '../providers/AuthContext';

// Module-level cache that survives component mount/unmount cycles and is
// immune to React Query cache invalidation, observer recreation, or
// Modal remounting.  Once an analysis is fetched it stays here until the
// app is restarted or the user explicitly taps "Try Again".
const _analysisCache = new Map<string, { analysis: string; search_grounded?: boolean }>();

type GeminiAnalysisPanelProps = {
  symbol: string;
  category: string;
};

export const GeminiAnalysisPanel = ({ symbol, category }: GeminiAnalysisPanelProps) => {
  const { t, i18n } = useTranslation();
  const { getAccessToken } = useAuth();
  const lang = i18n.language || 'en';
  const cacheKey = `${symbol}:${lang}`;

  const [retryTick, setRetryTick] = useState(0);
  const cached = _analysisCache.get(cacheKey);

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['gemini_analysis', symbol, category, lang, retryTick],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Authentication required');
      }
      const result = await fetchGeminiAnalysis(symbol, token, category, lang);
      if (result?.analysis?.trim()) {
        _analysisCache.set(cacheKey, result);
      }
      return result;
    },
    enabled: !!symbol && !cached,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15000),
  });

  const displayData = cached || data;
  const hasEmptyAnalysis = displayData && (!displayData.analysis || !displayData.analysis.trim());
  const showLoading = !cached && (isLoading || (isFetching && !data));

  const handleRetry = useCallback(() => {
    _analysisCache.delete(cacheKey);
    setRetryTick((n) => n + 1);
  }, [cacheKey]);

  if (showLoading) {
    return (
      <View style={styles.card}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.accent.gold} />
          <Text style={styles.loadingText}>{t('aiAnalysis.loading')}</Text>
        </View>
      </View>
    );
  }

  if (!displayData || isError || hasEmptyAnalysis) {
    return (
      <View style={styles.card}>
        <Text style={styles.errorText}>
          {hasEmptyAnalysis
            ? t('aiAnalysis.emptyError')
            : t('aiAnalysis.unavailableError')}
        </Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={handleRetry}
          disabled={isFetching}
          activeOpacity={0.7}
        >
          {isFetching ? (
            <ActivityIndicator size="small" color={colors.background.primary} />
          ) : (
            <>
              <Ionicons name="refresh" size={14} color={colors.background.primary} />
              <Text style={styles.retryButtonText}>{t('aiAnalysis.tryAgain')}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('aiAnalysis.results')}</Text>
        {displayData.search_grounded && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{t('aiAnalysis.notFinancialAdvice')}</Text>
          </View>
        )}
      </View>
      <View style={styles.scrollWrapper}>
        <ScrollView 
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
        >
          <Text style={styles.analysisText}>{displayData.analysis}</Text>
        </ScrollView>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: `${colors.accent.gold}20`,
    borderWidth: 1,
    borderColor: colors.accent.gold,
  },
  badgeText: {
    color: colors.accent.gold,
    fontSize: 10,
    fontWeight: '700',
  },
  scrollWrapper: {
    height: 320,
    width: '100%',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingRight: 4,
  },
  analysisText: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 20,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
  },
  loadingText: {
    color: colors.text.tertiary,
    fontSize: 12,
  },
  errorText: {
    color: colors.text.tertiary,
    fontSize: 12,
    paddingVertical: 6,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.accent.gold,
  },
  retryButtonText: {
    color: colors.background.primary,
    fontSize: 12,
    fontWeight: '800',
  },
});
