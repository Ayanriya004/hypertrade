import type { AgentConfig, AgentMode, AgentRow } from './types.js';

/**
 * Notional budget the agent may hold across open positions.
 *
 * `max_capital_usd` is always a notional ceiling (shared and dedicated).
 * Dedicated sub funding is a separate USDC transfer at create / Transfer UI —
 * live free margin on the sub still clamps opens.
 */
export function agentNotionalBudgetUsd(args: {
  mode: AgentMode;
  config: AgentConfig;
}): number {
  void args.mode; // mode no longer changes the notional formula
  const cap = Number(args.config.max_capital_usd);
  if (!(cap > 0)) return 0;
  return cap;
}

export function agentRowNotionalBudgetUsd(agent: AgentRow): number {
  return agentNotionalBudgetUsd({ mode: agent.mode, config: agent.config });
}
