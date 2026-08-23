import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { useAuth } from '../providers/AuthContext';
import { useAppStore } from '../store/appStore';
import { fetchAiAgentPositions, type AiAgentPosition } from '../lib/api';
import { pushRouteOnce } from '../lib/pushRouteOnce';
import {
  findSharedAiConflict,
  isSharedAiTradeWarnDismissed,
  setSharedAiTradeWarnDismissed,
} from '../lib/aiSharedTradeGuard';

type GuardOpts = {
  /** Coin / symbol about to be traded (e.g. BTC). */
  symbol: string | null | undefined;
  /** Spot never conflicts with V1 AI agents (perp-only). */
  marketType?: 'perp' | 'spot';
  enabled?: boolean;
};

/**
 * One-time confirm before a manual trade touches a Shared-mode AI position
 * on the same wallet. Call `guard(proceed)` or `guard(proceed, symbolOverride)`
 * around submit / close.
 */
export function useSharedAiTradeGuard(opts: GuardOpts) {
  const { symbol, marketType = 'perp', enabled = true } = opts;
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated, getAccessToken } = useAuth();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const env: 'mainnet' | 'demo' = tradingEnv === 'demo' ? 'demo' : 'mainnet';

  const { data: positions = [] } = useQuery({
    queryKey: ['ai_agent_positions', env],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [] as AiAgentPosition[];
      return fetchAiAgentPositions(token);
    },
    enabled: Boolean(enabled && isAuthenticated && marketType !== 'spot'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const conflictForProp = useMemo(() => {
    if (!enabled || marketType === 'spot' || !symbol) return null;
    return findSharedAiConflict(positions, symbol, env);
  }, [enabled, marketType, symbol, positions, env]);

  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let alive = true;
    void isSharedAiTradeWarnDismissed().then((v) => {
      if (alive) setDismissed(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [visible, setVisible] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [activeConflict, setActiveConflict] = useState<AiAgentPosition | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);

  const guard = useCallback(
    (proceed: () => void, symbolOverride?: string) => {
      if (marketType === 'spot' || !enabled) {
        proceed();
        return;
      }
      const hit =
        symbolOverride != null && symbolOverride !== ''
          ? findSharedAiConflict(positions, symbolOverride, env)
          : conflictForProp;
      if (!hit || dismissed) {
        proceed();
        return;
      }
      pendingRef.current = proceed;
      setActiveConflict(hit);
      setDontShowAgain(false);
      setVisible(true);
    },
    [marketType, enabled, positions, env, conflictForProp, dismissed],
  );

  const close = useCallback(() => {
    setVisible(false);
    pendingRef.current = null;
    setActiveConflict(null);
  }, []);

  const confirm = useCallback(async () => {
    if (dontShowAgain) {
      await setSharedAiTradeWarnDismissed();
      setDismissed(true);
    }
    const fn = pendingRef.current;
    pendingRef.current = null;
    setVisible(false);
    setActiveConflict(null);
    fn?.();
  }, [dontShowAgain]);

  const openAiAgents = useCallback(() => {
    close();
    pushRouteOnce(router, '/ai-agents');
  }, [close, router]);

  const display = activeConflict ?? conflictForProp;

  const modal = (
    <SharedAiTradeConfirmModal
      visible={visible}
      symbol={display?.symbol ?? symbol ?? ''}
      agentName={display?.agentName ?? ''}
      dontShowAgain={dontShowAgain}
      onToggleDontShow={() => setDontShowAgain((v) => !v)}
      onCancel={close}
      onConfirm={() => void confirm()}
      onOpenAiAgents={openAiAgents}
      t={t}
    />
  );

  return { guard, modal, conflict: conflictForProp };
}

function SharedAiTradeConfirmModal({
  visible,
  symbol,
  agentName,
  dontShowAgain,
  onToggleDontShow,
  onCancel,
  onConfirm,
  onOpenAiAgents,
  t,
}: {
  visible: boolean;
  symbol: string;
  agentName: string;
  dontShowAgain: boolean;
  onToggleDontShow: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenAiAgents: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity style={styles.card} activeOpacity={1} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{t('aiAgents.sharedTradeWarnTitle')}</Text>
          <Text style={styles.body}>
            {t('aiAgents.sharedTradeWarnDesc', {
              symbol: symbol || '—',
              name: agentName || t('aiAgents.title', 'AI Agents'),
            })}
          </Text>

          <TouchableOpacity style={styles.checkboxRow} onPress={onToggleDontShow} activeOpacity={0.8}>
            <View style={[styles.checkbox, dontShowAgain && styles.checkboxChecked]}>
              {dontShowAgain ? (
                <Ionicons name="checkmark" size={14} color={colors.background.primary} />
              ) : null}
            </View>
            <Text style={styles.checkboxText}>{t('trading.doNotAskAgain')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkBtn} onPress={onOpenAiAgents} activeOpacity={0.8}>
            <Text style={styles.linkText}>{t('aiAgents.sharedTradeWarnOpenAgents')}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.accent.gold} />
          </TouchableOpacity>

          <View style={styles.buttons}>
            <TouchableOpacity style={styles.secondary} onPress={onCancel}>
              <Text style={styles.secondaryText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primary} onPress={onConfirm}>
              <Text style={styles.primaryText}>{t('aiAgents.sharedTradeWarnContinue')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: colors.background.secondary,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  title: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 8,
  },
  body: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.tertiary,
  },
  checkboxChecked: {
    backgroundColor: colors.accent.gold,
    borderColor: colors.accent.gold,
  },
  checkboxText: {
    color: colors.text.secondary,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  linkText: {
    color: colors.accent.gold,
    fontSize: 13,
    fontWeight: '700',
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  secondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  secondaryText: {
    color: colors.text.secondary,
    fontSize: 13,
    fontWeight: '700',
  },
  primary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.accent.gold,
  },
  primaryText: {
    color: colors.background.primary,
    fontSize: 13,
    fontWeight: '800',
  },
});
