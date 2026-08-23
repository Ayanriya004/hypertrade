import { useCallback, useMemo } from 'react';
import type { Hex } from 'viem';
import { useAppStore } from '../store/appStore';
import {
  isDedicatedTradingBook,
  resolveTradingAddress,
  resolveVaultAddress,
  type ActiveTradingBook,
} from '../lib/tradingBook';
import { useActiveEthereumWallet } from './useActiveEthereumWallet';

/**
 * Resolves Main vs Dedicated book for HL reads/writes.
 * - `masterAddress` — Privy embedded / signer identity (builder, reportTrade, JIT signer)
 * - `tradingAddress` — clearinghouse / open-orders / fills queries
 * - `vaultAddress` — ExchangeClient defaultVaultAddress (undefined on Main)
 */
export function useActiveTradingBook() {
  const activeTradingBook = useAppStore((s) => s.activeTradingBook);
  const setActiveTradingBook = useAppStore((s) => s.setActiveTradingBook);
  const clearActiveTradingBook = useAppStore((s) => s.clearActiveTradingBook);
  const { address: activeAddr } = useActiveEthereumWallet();

  const masterAddress = useMemo((): Hex | null => {
    if (activeAddr && activeAddr.startsWith('0x')) return activeAddr as Hex;
    return null;
  }, [activeAddr]);

  const tradingAddress = useMemo(
    () => resolveTradingAddress(activeTradingBook, masterAddress),
    [activeTradingBook, masterAddress],
  );

  const vaultAddress = useMemo(
    () => resolveVaultAddress(activeTradingBook),
    [activeTradingBook],
  );

  const isDedicatedBook = isDedicatedTradingBook(activeTradingBook);

  const selectDedicatedBook = useCallback(
    (args: { agentId: string; subAddress: string; name: string }) => {
      if (!args.subAddress.startsWith('0x')) return;
      setActiveTradingBook({
        agentId: args.agentId,
        subAddress: args.subAddress as Hex,
        name: args.name || null,
      });
    },
    [setActiveTradingBook],
  );

  const selectMainBook = useCallback(() => {
    clearActiveTradingBook();
  }, [clearActiveTradingBook]);

  return {
    activeTradingBook: activeTradingBook as ActiveTradingBook,
    masterAddress,
    tradingAddress,
    vaultAddress,
    isDedicatedBook,
    bookLabel: isDedicatedBook ? activeTradingBook.name : null,
    selectDedicatedBook,
    selectMainBook,
    setActiveTradingBook,
  };
}
