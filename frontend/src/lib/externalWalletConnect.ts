/**
 * External EVM wallet sessions via Reown AppKit (React Native).
 *
 * Privy's Expo SDK has no built-in EVM wallet picker — use AppKit + SIWE:
 * @see https://docs.privy.io/authentication/user-authentication/login-methods/wallet
 * @see https://docs.reown.com/appkit/react-native/core/installation
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAddress } from 'viem';
import {
  ConnectionsController,
  EventsController,
} from '@reown/appkit-core-react-native';
import type { Eip1193Provider } from './hyperliquid';
import { getAppKit } from './appKitConfig';

/**
 * AsyncStorage key prefixes owned by WalletConnect / Reown AppKit. Everything
 * matching these is wiped on disconnect so no session, pairing, or crypto
 * keychain can survive a logout and resurrect a stale connection later. These
 * are deliberately scoped to WC/AppKit only — Privy (`privy:*`) and app state
 * use different namespaces and are never touched here.
 */
const WALLETCONNECT_STORAGE_PREFIXES = [
  'wc@2:',
  '@walletconnect',
  '@appkit',
  '@reown',
  'reown',
  '@w3m',
  'walletconnect',
];

/**
 * Remove all persisted WalletConnect / AppKit state from AsyncStorage. Called
 * after `disconnect` so a subsequent login starts from a clean slate — critical
 * when switching between external wallets, or between an external wallet and an
 * embedded (email/social) Privy account.
 */
export async function clearExternalWalletStorage(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const toRemove = keys.filter((key) => {
      const lower = key.toLowerCase();
      return WALLETCONNECT_STORAGE_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()));
    });
    if (toRemove.length) {
      await AsyncStorage.multiRemove(toRemove);
    }
  } catch {
    // Best-effort — a storage hiccup must never block logout.
  }
}

let connectInFlight: Promise<ConnectResult> | null = null;
let connectGeneration = 0;
let abortWaitForConnect: ((reason: Error) => void) | null = null;

/** Cancel an in-flight wallet picker / WC session (e.g. superseded login attempt). */
export function cancelPendingWalletConnect(reason = 'Wallet connect cancelled'): void {
  connectGeneration += 1;
  connectInFlight = null;
  abortWaitForConnect?.(new Error(reason));
  abortWaitForConnect = null;
  void getAppKit().close().catch(() => { /* ignore */ });
}

type WalletConnectOpener = () => Promise<void>;
let walletConnectOpener: WalletConnectOpener | null = null;

/** Called by AppKitHost once the modal layer has mounted. */
export function registerWalletConnectOpener(fn: WalletConnectOpener): void {
  walletConnectOpener = fn;
}

export function unregisterWalletConnectOpener(): void {
  walletConnectOpener = null;
}

async function openWalletConnectModal(): Promise<void> {
  if (!walletConnectOpener) {
    throw new Error('Wallet picker is not ready yet. Reload the app and try again.');
  }
  await walletConnectOpener();
}

export interface ConnectResult {
  address: string;
  provider: Eip1193Provider;
  walletClientType: string;
  connectorType: string;
}

const CONNECT_TIMEOUT_MS = 120_000;

function parseEvmAddressFromCaip(caip?: string): string | null {
  if (!caip) return null;
  const parts = caip.split(':');
  if (parts.length < 3) return null;
  const address = parts.slice(2).join(':');
  if (!address.startsWith('0x')) return null;
  // Normalize to EIP-55 checksum. Wallets differ in how they report the
  // session address (MetaMask: lowercase, Rainbow: checksummed), and SIWE
  // (EIP-4361) requires a checksummed address line — Privy's server-side
  // verification rejects lowercase with "Invalid SIWE message and/or
  // signature". Checksumming here fixes every consumer at once.
  try {
    return getAddress(address);
  } catch {
    return null;
  }
}

function readConnectedSession(): ConnectResult | null {
  const appKit = getAppKit();
  const provider = appKit.getProvider('eip155') as Eip1193Provider | null;
  const address = parseEvmAddressFromCaip(ConnectionsController.state.activeAddress);
  if (!provider || !address || !ConnectionsController.state.isConnected) {
    return null;
  }
  return {
    address,
    provider,
    walletClientType: 'wallet_connect_v2',
    connectorType: 'wallet_connect_v2',
  };
}

function waitForWalletConnect(): Promise<ConnectResult> {
  const appKit = getAppKit();
  const generation = connectGeneration;

  return new Promise((resolve, reject) => {
    let settled = false;

    abortWaitForConnect = (reason: Error) => {
      if (settled || generation !== connectGeneration) return;
      settled = true;
      cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
      reject(reason);
    };

    const cleanup = (
      unsubConnect: () => void,
      unsubClose: () => void,
      unsubReject: () => void,
      unsubError: () => void,
      timer: ReturnType<typeof setTimeout>,
    ) => {
      unsubConnect();
      unsubClose();
      unsubReject();
      unsubError();
      clearTimeout(timer);
    };

    const finishSuccess = (
      unsubConnect: () => void,
      unsubClose: () => void,
      unsubReject: () => void,
      unsubError: () => void,
      timer: ReturnType<typeof setTimeout>,
    ) => {
      if (generation !== connectGeneration) return;
      const session = readConnectedSession();
      if (!session) {
        settled = true;
        cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
        reject(new Error('Wallet connected but session is not ready. Try again.'));
        return;
      }
      settled = true;
      cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
      abortWaitForConnect = null;
      void appKit.close().catch(() => { /* ignore */ });
      resolve(session);
    };

    const unsubConnect = EventsController.subscribeEvent('CONNECT_SUCCESS', () => {
      if (settled || generation !== connectGeneration) return;
      finishSuccess(unsubConnect, unsubClose, unsubReject, unsubError, timer);
    });

    const unsubReject = EventsController.subscribeEvent('USER_REJECTED', (event) => {
      if (settled || generation !== connectGeneration) return;
      settled = true;
      cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
      abortWaitForConnect = null;
      void appKit.close().catch(() => { /* ignore */ });
      const message =
        event.data.event === 'USER_REJECTED'
          ? event.data.properties?.message
          : undefined;
      reject(new Error(message || 'Wallet connection rejected'));
    });

    const unsubClose = EventsController.subscribeEvent('MODAL_CLOSE', (event) => {
      if (settled || generation !== connectGeneration) return;
      if (ConnectionsController.state.isConnected) {
        finishSuccess(unsubConnect, unsubClose, unsubReject, unsubError, timer);
        return;
      }
      settled = true;
      cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
      abortWaitForConnect = null;
      const wasConnected =
        event.data.event === 'MODAL_CLOSE' ? event.data.properties?.connected : false;
      reject(
        new Error(
          wasConnected
            ? 'Wallet connection incomplete'
            : 'Wallet connection cancelled',
        ),
      );
    });

    const unsubError = EventsController.subscribeEvent('CONNECT_ERROR', (event) => {
      if (settled || generation !== connectGeneration) return;
      settled = true;
      cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
      abortWaitForConnect = null;
      void appKit.close().catch(() => { /* ignore */ });
      const message =
        event.data.event === 'CONNECT_ERROR'
          ? event.data.properties?.message
          : undefined;
      reject(new Error(message || 'Wallet connection failed'));
    });

    const timer = setTimeout(() => {
      if (settled || generation !== connectGeneration) return;
      settled = true;
      cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
      abortWaitForConnect = null;
      void appKit.close().catch(() => { /* ignore */ });
      reject(new Error('Wallet connection timed out'));
    }, CONNECT_TIMEOUT_MS);

    void (async () => {
      try {
        if (__DEV__) {
          console.log('[wallet] Opening AppKit connect modal…');
        }
        await openWalletConnectModal();
        if (__DEV__) {
          console.log('[wallet] AppKit modal opened');
        }
      } catch (err: unknown) {
        if (settled || generation !== connectGeneration) return;
        settled = true;
        cleanup(unsubConnect, unsubClose, unsubReject, unsubError, timer);
        abortWaitForConnect = null;
        const message = err instanceof Error ? err.message : 'Failed to open wallet picker';
        reject(new Error(message));
      }
    })();
  });
}

/** Open AppKit and return an EIP-1193 provider + address for Privy SIWE login. */
export async function connectExternalWallet(): Promise<ConnectResult> {
  cancelPendingWalletConnect('Wallet connect superseded');
  const generation = connectGeneration;

  connectInFlight = (async () => {
    const appKit = getAppKit();
    await appKit.disconnect('eip155').catch(() => { /* ignore */ });
    if (generation !== connectGeneration) {
      throw new Error('Wallet connect cancelled');
    }

    // Purge any persisted WC/AppKit state from previous logins BEFORE pairing.
    // A fresh login must never inherit stale pairings/sessions — even ones left
    // behind by an app version that didn't wipe storage on logout. Without this
    // a lingering session (e.g. Rainbow) collides with the new one (MetaMask):
    // WalletConnect throws "No matching key" and the SIWE signature can end up
    // routed on the stale topic, which Privy rejects.
    await clearExternalWalletStorage();

    // Let the relay finish tearing down the previous session before opening a
    // new one.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (generation !== connectGeneration) {
      throw new Error('Wallet connect cancelled');
    }

    return waitForWalletConnect();
  })();

  try {
    return await connectInFlight;
  } finally {
    connectInFlight = null;
  }
}

/** Reuse an existing AppKit WalletConnect session for signing. */
export async function getExternalWalletProvider(): Promise<Eip1193Provider | null> {
  return readConnectedSession()?.provider ?? null;
}

export function getExternalWalletConnectAddress(): string | null {
  return readConnectedSession()?.address ?? null;
}

/**
 * The address the active WalletConnect session is actually authorized to sign
 * with, read straight from the provider (`eth_accounts`) rather than the cached
 * connection state. Used to detect a stale/mismatched session before we ask a
 * wallet to sign — a mismatch means the SIWE signature would recover to the
 * wrong address and Privy would reject it ("Invalid SIWE message and/or
 * signature"). Returns null when it can't be determined (caller decides).
 */
export async function getExternalWalletSignerAddress(): Promise<string | null> {
  const session = readConnectedSession();
  if (!session) return null;
  try {
    const accounts = (await session.provider.request({ method: 'eth_accounts' })) as
      | string[]
      | undefined;
    const first = accounts?.[0];
    return typeof first === 'string' && first.startsWith('0x') ? first : null;
  } catch {
    return null;
  }
}

export function isExternalWalletConnected(): boolean {
  return readConnectedSession() != null;
}

/**
 * Fully disconnect and CLEAR the external wallet. Logout calls this for every
 * user (embedded or external) so a hanging WalletConnect session can never leak
 * across accounts. Steps: cancel any in-flight connect → close the modal →
 * disconnect the live session → wipe persisted WC/AppKit storage.
 */
export async function disconnectExternalWallet(): Promise<void> {
  // Invalidate any in-flight connect/wait and close the picker.
  cancelPendingWalletConnect('Wallet disconnected');
  try {
    await getAppKit().disconnect('eip155');
  } catch {
    // May already be disconnected (e.g. embedded-only user) — ignore.
  } finally {
    connectInFlight = null;
  }
  // Remove persisted session/pairing/keychain so nothing restores next launch.
  await clearExternalWalletStorage();
}
