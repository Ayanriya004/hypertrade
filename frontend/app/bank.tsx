/**
 * /bank route — auth-aware shell for the Bank hub.
 *
 *   • Auth still hydrating → dashboard skeleton (never guest flash)
 *   • Signed out → guest banking marketing / apply screen (`bank-guest.tsx`)
 *   • Signed in  → UR bank dashboard (Cash + Card tabs)
 *
 * `/bank-guest` remains available as a direct route for previewing the
 * guest marketing layout while logged in.
 */
import React from 'react';
import { useAuth } from '../src/providers/AuthContext';
import { BankDashboardSkeleton } from '../src/components/skeleton/BankDashboardSkeleton';
import { BankDashboardScreen } from '../src/components/bank/BankDashboardScreen';
import BankGuestScreen from './bank-guest';

export default function BankRoute() {
  const { isReady, isAuthenticated } = useAuth();

  // Wait for Privy before deciding guest vs dashboard. Store starts
  // `isAuthenticated: false`, so gating only on that flashes guest on cold
  // start / deep link even for returning logged-in users.
  if (!isReady) {
    return <BankDashboardSkeleton />;
  }

  if (!isAuthenticated) {
    return <BankGuestScreen />;
  }

  return <BankDashboardScreen />;
}
