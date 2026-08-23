/**
 * App-wide UR account state — survives tab switches (Home ↔ Bank) so
 * `pendingIncoming` pills and background balance polling keep running
 * while a deposit/convert is in flight.
 *
 * Mount inside the auth provider tree (`PrivyAuthProvider` / `MockAuthProvider`).
 * Consume via `useUrAccount()` from any screen (bank, home, etc.).
 */
import React, { createContext, useContext, type ReactNode } from 'react';
import {
  useUrAccountState,
  type UseUrAccountState,
} from '../hooks/useUrAccount';

const UrAccountContext = createContext<UseUrAccountState | null>(null);

export function UrAccountProvider({ children }: { children: ReactNode }) {
  const value = useUrAccountState();
  return (
    <UrAccountContext.Provider value={value}>{children}</UrAccountContext.Provider>
  );
}

export function useUrAccount(): UseUrAccountState {
  const ctx = useContext(UrAccountContext);
  if (!ctx) {
    throw new Error('useUrAccount must be used within UrAccountProvider');
  }
  return ctx;
}
