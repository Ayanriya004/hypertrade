/**
 * Single app-wide Hyperliquid account WebSocket.
 *
 * Screens used to each call `useHyperliquidAccountStream(address)`, which
 * opened a new socket per mount. Navigating home → asset → trade stacked
 * 2–3 identical account connections and made the app progressively slower.
 *
 * Mount once under the auth provider; consumers keep calling
 * `useHyperliquidAccountStream()` and share this connection.
 *
 * The subscribed address follows the global active trading book (Main wallet
 * or Dedicated sub). Book switches retarget the same socket — never a second
 * account WS.
 */
import React, { useMemo, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useAppStore } from '../store/appStore';
import {
  HyperliquidAccountStreamContext,
  useHyperliquidAccountStreamController,
} from '../lib/useHyperliquidAccountStream';
import { resolveTradingAddress } from '../lib/tradingBook';

type Hex = `0x${string}`;

export function HyperliquidAccountStreamProvider({ children }: { children: ReactNode }) {
  const { walletAddress } = useAuth();
  const activeTradingBook = useAppStore((s) => s.activeTradingBook);

  const user = useMemo((): Hex | undefined => {
    const master =
      walletAddress && walletAddress.startsWith('0x') ? (walletAddress as Hex) : null;
    return resolveTradingAddress(activeTradingBook, master) ?? undefined;
  }, [walletAddress, activeTradingBook]);

  const stream = useHyperliquidAccountStreamController(user);

  return (
    <HyperliquidAccountStreamContext.Provider value={stream}>
      {children}
    </HyperliquidAccountStreamContext.Provider>
  );
}
