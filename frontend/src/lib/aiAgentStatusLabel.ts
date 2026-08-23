import type { TFunction } from 'i18next';
import { colors } from '../theme/colors';
import type { AiAgentView } from './api';

/** Book pickers only surface runnable Dedicated books — never draft/revoked. */
export function formatBookAgentStatusLabel(
  agent: Pick<AiAgentView, 'status' | 'mode' | 'dryRun'>,
  t: TFunction,
): string | null {
  if (agent.status !== 'active' && agent.status !== 'paused' && agent.status !== 'stopped') {
    return null;
  }
  const base = t(`aiAgents.status.${agent.status}`);
  const withShadow =
    agent.status === 'active' && agent.dryRun
      ? `${base} · ${t('aiAgents.shadowBadge')}`
      : base;
  const mode =
    agent.mode === 'dedicated' ? t('aiAgents.dedicatedShort') : t('aiAgents.sharedShort');
  return `${withShadow} | ${mode}`;
}

export function bookAgentStatusPillStyle(status: AiAgentView['status'] | undefined) {
  if (status === 'active') {
    return { backgroundColor: 'rgba(16,185,129,0.15)' };
  }
  return { backgroundColor: colors.background.tertiary };
}
