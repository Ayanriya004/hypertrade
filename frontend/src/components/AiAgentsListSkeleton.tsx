/**
 * Shimmer placeholders for the AI Agents list while auth/list loads.
 * Matches agent card silhouette so the empty marketing pitch never flashes.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { ShimmerBone, useShimmerX } from './skeleton/ShimmerBone';

const CARD_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;

function AgentCardSkeleton({ shimmerX }: { shimmerX: ReturnType<typeof useShimmerX> }) {
  return (
    <LinearGradient
      colors={CARD_GRADIENT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
    >
      <View style={styles.headerRow}>
        <ShimmerBone shimmerX={shimmerX} style={styles.logoBone} />
        <View style={styles.headerText}>
          <ShimmerBone shimmerX={shimmerX} style={styles.nameBone} />
          <ShimmerBone shimmerX={shimmerX} style={styles.statusBone} />
        </View>
      </View>
      <View style={styles.metaRow}>
        <ShimmerBone shimmerX={shimmerX} style={styles.metaBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.metaBoneShort} />
      </View>
      <View style={styles.badgeRow}>
        <ShimmerBone shimmerX={shimmerX} style={styles.badgeBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.badgeBone} />
        <ShimmerBone shimmerX={shimmerX} style={styles.badgeBoneWide} />
      </View>
      <View style={styles.statsRow}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.statCell}>
            <ShimmerBone shimmerX={shimmerX} style={styles.statLabelBone} />
            <ShimmerBone shimmerX={shimmerX} style={styles.statValueBone} />
          </View>
        ))}
      </View>
    </LinearGradient>
  );
}

export function AiAgentsListSkeleton({ count = 2 }: { count?: number }) {
  const shimmerX = useShimmerX([-200, 200]);
  return (
    <View style={styles.wrap} accessibilityLabel="Loading">
      {Array.from({ length: count }, (_, i) => (
        <AgentCardSkeleton key={i} shimmerX={shimmerX} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 12,
    paddingTop: 8,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 14,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logoBone: {
    width: 36,
    height: 36,
    borderRadius: 10,
  },
  headerText: {
    flex: 1,
    gap: 6,
  },
  nameBone: {
    width: '55%',
    height: 14,
    borderRadius: 6,
  },
  statusBone: {
    width: 64,
    height: 10,
    borderRadius: 5,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaBone: {
    width: 120,
    height: 12,
    borderRadius: 6,
  },
  metaBoneShort: {
    width: 56,
    height: 22,
    borderRadius: 8,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  badgeBone: {
    width: 52,
    height: 20,
    borderRadius: 8,
  },
  badgeBoneWide: {
    width: 72,
    height: 20,
    borderRadius: 8,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  statCell: {
    flex: 1,
    gap: 6,
  },
  statLabelBone: {
    width: '70%',
    height: 9,
    borderRadius: 4,
  },
  statValueBone: {
    width: '85%',
    height: 14,
    borderRadius: 6,
  },
});
