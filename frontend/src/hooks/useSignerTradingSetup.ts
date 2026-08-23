import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { useAppStore } from '../store/appStore';
import {
  getHyperliquidTradingState,
  type HyperliquidAbstractionMode,
} from '../lib/hyperliquid';
import { useActiveEthereumWallet } from './useActiveEthereumWallet';

/**
 * One-tap setup (approveAgent / builder fee / pooled mode) is always the
 * master wallet. Dedicated HL subs have no extraAgents — querying the sub
 * reports isAgentActive=false and re-prompts seamless setup.
 *
 * Positions / balances / HIP-3 abstraction stay on the selected book.
 * This hook only reuses the cached master `hl_trading_state` query
 * (already mounted by SeamlessSetupProvider).
 */
export function useSignerTradingSetup(isDedicatedBook: boolean) {
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const { address } = useActiveEthereumWallet();
  const masterAddress =
    address && address.startsWith('0x') ? (address as Hex) : null;

  const { data, isLoading } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, masterAddress ?? ''],
    queryFn: () => getHyperliquidTradingState(masterAddress!),
    enabled: isDedicatedBook && !!masterAddress && isAuthenticated,
    staleTime: 5_000,
    refetchInterval: 30_000,
  });

  return {
    isAgentActive: !!data?.isAgentActive,
    accountAbstractionMode: (data?.accountAbstractionMode ?? null) as
      | HyperliquidAbstractionMode
      | null,
    ready: !isDedicatedBook || (!isLoading && !!data),
  };
}

/** Overlay master isAgentActive onto book trading state once signer REST is ready. */
export function overlaySignerAgentActive<T extends { isAgentActive?: boolean } | null | undefined>(
  state: T,
  opts: { isDedicatedBook: boolean; ready: boolean; isAgentActive: boolean },
): T {
  if (!state || !opts.isDedicatedBook || !opts.ready) return state;
  if (state.isAgentActive === opts.isAgentActive) return state;
  return { ...state, isAgentActive: opts.isAgentActive };
}
