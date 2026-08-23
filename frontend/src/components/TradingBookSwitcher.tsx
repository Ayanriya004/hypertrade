import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { useAuth } from '../providers/AuthContext';
import { useAppStore } from '../store/appStore';
import { useActiveTradingBook } from '../hooks/useActiveTradingBook';
import { isDedicatedSwitcherAgent } from '../lib/tradingBook';
import {
  formatBookNameWithLiveCount,
  useDedicatedBookLivePositionCounts,
  useMasterBookLivePositionCount,
} from '../hooks/useAiAgentLivePositionCounts';
import { formatBookAgentStatusLabel } from '../lib/aiAgentStatusLabel';
import { TradingBookPickerRow, type TradingBookPickerOption } from './TradingBookPickerRow';
import { listAiAgents, type AiAgentView } from '../lib/api';

type Props = {
  /**
   * `chips` — horizontal scroll row (Portfolio).
   * `compact` — tappable label + chevron → picker (asset / trade headers).
   */
  variant?: 'chips' | 'compact';
  style?: object;
};

/**
 * Main vs Dedicated book switcher. Hidden until the user has at least one
 * Dedicated agent. Writes the global `activeTradingBook` store.
 */
export function TradingBookSwitcher({ variant = 'chips', style }: Props) {
  const { t } = useTranslation();
  const { isAuthenticated, getAccessToken } = useAuth();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const isDemo = tradingEnv === 'demo';
  const {
    activeTradingBook,
    masterAddress,
    isDedicatedBook,
    selectDedicatedBook,
    selectMainBook,
  } = useActiveTradingBook();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: agents = [] } = useQuery({
    queryKey: ['ai_agents', 'books', tradingEnv],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [] as AiAgentView[];
      return (await listAiAgents(token)).agents;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    // Agent status can change server-side (worker auto-pause/stop) — poll so
    // the switcher hides stopped books and fallback-to-Main still triggers.
    refetchInterval: 60_000,
  });

  const dedicatedBooks = useMemo(() => {
    const master = (masterAddress || '').toLowerCase();
    return agents.filter((a) => {
      if (!isDedicatedSwitcherAgent(a)) return false;
      if ((a.tradingEnv === 'demo') !== isDemo) return false;
      if (master && a.hlMasterAddress.toLowerCase() !== master) return false;
      return true;
    });
  }, [agents, masterAddress, isDemo]);
  const showLiveCounts = dedicatedBooks.length > 0;
  const dedicatedTargets = useMemo(
    () =>
      dedicatedBooks.map((a) => ({
        id: a.id,
        subAddress: a.hlSubaccountAddress as string,
      })),
    [dedicatedBooks],
  );
  const liveCounts = useDedicatedBookLivePositionCounts(dedicatedTargets, showLiveCounts);
  const masterLiveCount = useMasterBookLivePositionCount(showLiveCounts);
  const masterLabel = formatBookNameWithLiveCount(t('portfolio.bookMaster'), masterLiveCount);

  if (dedicatedBooks.length === 0) return null;

  const selectedId = activeTradingBook.agentId ?? 'master';
  const selectedLiveCount = isDedicatedBook
    ? liveCounts.get(activeTradingBook.agentId ?? '')
    : masterLiveCount;
  const label = isDedicatedBook
    ? t('portfolio.agentBookBalance', {
        name: formatBookNameWithLiveCount(
          activeTradingBook.name || t('aiAgents.title'),
          selectedLiveCount,
        ),
      })
    : masterLabel;

  const select = (id: 'master' | string) => {
    void Haptics.selectionAsync();
    if (id === 'master') {
      selectMainBook();
      return;
    }
    const agent = dedicatedBooks.find((a) => a.id === id);
    if (agent?.hlSubaccountAddress) {
      selectDedicatedBook({
        agentId: agent.id,
        subAddress: agent.hlSubaccountAddress,
        name: agent.name,
      });
    }
  };

  const options: TradingBookPickerOption[] = [
    { id: 'master', name: t('portfolio.bookMaster'), liveCount: masterLiveCount },
    ...dedicatedBooks.map((a) => ({
      id: a.id,
      name: a.name,
      liveCount: liveCounts.get(a.id),
      statusLabel: formatBookAgentStatusLabel(a, t),
      statusKind: a.status,
    })),
  ];

  if (variant === 'compact') {
    return (
      <View style={style}>
        <TouchableOpacity
          style={styles.compactTrigger}
          onPress={() => {
            void Haptics.selectionAsync();
            setPickerOpen(true);
          }}
          activeOpacity={0.7}
          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel={t('home.switchTradeBook')}
        >
          {isDedicatedBook ? (
            <MaterialCommunityIcons name="robot-outline" size={12} color={colors.accent.gold} />
          ) : (
            <Ionicons name="wallet-outline" size={12} color={colors.text.tertiary} />
          )}
          <Text
            style={[styles.compactLabel, isDedicatedBook && styles.compactLabelActive]}
            numberOfLines={1}
          >
            {label}
          </Text>
          <Ionicons name="chevron-down" size={12} color={colors.text.tertiary} />
        </TouchableOpacity>

        <Modal
          visible={pickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setPickerOpen(false)}
        >
          <View style={styles.modalBackdrop}>
            <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setPickerOpen(false)} />
            <View style={styles.modalSheet}>
              <Text style={styles.modalTitle}>{t('home.switchTradeBook')}</Text>
              <ScrollView
                style={styles.modalList}
                contentContainerStyle={styles.modalListContent}
                showsVerticalScrollIndicator
                bounces
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
              {options.map((opt) => {
                const active = selectedId === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[styles.option, active && styles.optionActive]}
                    onPress={() => {
                      select(opt.id);
                      setPickerOpen(false);
                    }}
                    activeOpacity={0.75}
                  >
                    <TradingBookPickerRow option={opt} active={active} />
                  </TouchableOpacity>
                );
              })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View style={[styles.chipsWrap, style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        bounces={false}
        alwaysBounceHorizontal={false}
        overScrollMode="never"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.chipsRow}
      >
        <TouchableOpacity
          style={[styles.chip, !isDedicatedBook && styles.chipActive]}
          onPress={() => select('master')}
          activeOpacity={0.75}
          delayPressIn={0}
        >
          <Text style={[styles.chipText, !isDedicatedBook && styles.chipTextActive]}>
            {masterLabel}
          </Text>
        </TouchableOpacity>
        {dedicatedBooks.map((agent) => {
          const active = selectedId === agent.id;
          return (
            <TouchableOpacity
              key={agent.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => select(agent.id)}
              activeOpacity={0.75}
              delayPressIn={0}
            >
              <MaterialCommunityIcons
                name="robot-outline"
                size={12}
                color={active ? colors.accent.gold : colors.text.tertiary}
                style={{ marginRight: 4 }}
              />
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {formatBookNameWithLiveCount(agent.name, liveCounts.get(agent.id))}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <LinearGradient
        colors={[`${colors.background.primary}00`, colors.background.primary]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.chipsFade}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chipsWrap: {
    position: 'relative',
    marginHorizontal: 16,
    marginBottom: 8,
  },
  chipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 24,
  },
  chipsFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 28,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    maxWidth: 188,
  },
  chipActive: {
    backgroundColor: `${colors.accent.gold}18`,
    borderColor: colors.accent.gold,
  },
  chipText: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: '700',
  },
  chipTextActive: {
    color: colors.accent.gold,
  },
  compactTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginTop: 2,
    maxWidth: '100%',
  },
  compactLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.tertiary,
    flexShrink: 1,
  },
  compactLabelActive: {
    color: colors.accent.gold,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  modalSheet: {
    backgroundColor: colors.background.secondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingTop: 12,
    paddingBottom: 8,
    paddingHorizontal: 12,
    zIndex: 1,
    maxHeight: '60%',
  },
  modalTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.tertiary,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  modalList: {
    flexGrow: 0,
  },
  modalListContent: {
    gap: 4,
    paddingBottom: 4,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    minWidth: 0,
  },
  optionActive: {
    backgroundColor: `${colors.accent.gold}14`,
  },
});
