import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { getHlInfoClient, getSpotClearinghouseState } from './hyperliquid';
import { getHlWsUrl, onTradingEnvChange } from './hlEnv';
const WS_CONNECTING_TIMEOUT_MS = 15_000;
const REST_FALLBACK_AFTER_MS = 8_000;
const MIN_REST_HYDRATE_INTERVAL_MS = 4_000;
// Stale-message watchdog (account stream). HL silently drops idle sockets;
// when that happens onclose may not fire for minutes and PortfolioTabs PnL
// freezes because the markPx in clearinghouseState stops updating. We keep
// a slightly longer threshold than the price socket because clearinghouse /
// open-orders pushes are inherently lower-frequency than allMids.
const STALE_ACCOUNT_MESSAGE_MS = 20_000;
const STALENESS_CHECK_INTERVAL_MS = 5_000;

// HIP-3 dexes to include in aggregated perp totals. Must stay in sync with HIP3_DEXES in
// `hyperliquid.ts` so WS and REST cover the same universe (otherwise home ↔ profile drift).
const HIP3_DEXES = ['xyz'] as const;

type Hex = `0x${string}`;

type StreamState = {
  isConnected: boolean;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  webData3?: any;
  /** Main dex's clearinghouse state (kept for backward compat with consumers reading
   *  `.marginSummary`, `.assetPositions`, `.withdrawable`, etc.). */
  clearinghouseState?: any;
  /** All perp dexes keyed by dex name (""=main, "xyz"=HIP-3 xyz). Use this for aggregating
   *  account value / withdrawable across main + HIP-3, matching `getHyperliquidTradingState`. */
  clearinghouseStatesByDex?: Record<string, any>;
  openOrders?: any;
  spotState?: any;
};

/**
 * Owns the account WebSocket. Call exactly once from
 * `HyperliquidAccountStreamProvider` — screens must use
 * `useHyperliquidAccountStream` (context) instead.
 */
const EMPTY_STREAM_STATE: StreamState = {
  isConnected: false,
  connectionStatus: 'disconnected',
  webData3: undefined,
  clearinghouseState: undefined,
  clearinghouseStatesByDex: undefined,
  openOrders: undefined,
  spotState: undefined,
};

function sameHex(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function useHyperliquidAccountStreamController(user?: Hex) {
  const [state, setState] = useState<StreamState>({
    isConnected: false,
    connectionStatus: 'disconnected',
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const retryCount = useRef(0);
  const connectingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRestHydrateAt = useRef(0);
  const lastMessageAt = useRef<number>(0);
  const lastWsAccountUpdateAt = useRef<number>(0);
  const stalenessIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Each dex's openOrders stream is independent; we cache by dex and
  // emit a flat merged list to consumers so existing readers don't have
  // to know about per-dex bookkeeping.
  const openOrdersByDexRef = useRef<Record<string, any[]>>({});
  const userRef = useRef(user);
  userRef.current = user;
  /** Bumped on book switch so in-flight REST hydrates cannot write the old address. */
  const hydrateEpochRef = useRef(0);
  const [trackedUser, setTrackedUser] = useState(user);

  // Clear prior-book snapshots during render (before paint). useEffect alone
  // runs after paint and briefly shows Main rows while Dedicated is selected
  // (and vice versa).
  if (user !== trackedUser) {
    setTrackedUser(user);
    hydrateEpochRef.current += 1;
    openOrdersByDexRef.current = {};
    lastWsAccountUpdateAt.current = 0;
    setState({
      ...EMPTY_STREAM_STATE,
      connectionStatus: user ? 'connecting' : 'disconnected',
    });
  }

  const clearConnectingWatchdog = useCallback(() => {
    if (connectingWatchdogRef.current) {
      clearTimeout(connectingWatchdogRef.current);
      connectingWatchdogRef.current = null;
    }
  }, []);

  const clearRestFallbackTimer = useCallback(() => {
    if (restFallbackTimerRef.current) {
      clearTimeout(restFallbackTimerRef.current);
      restFallbackTimerRef.current = null;
    }
  }, []);

  const stopStalenessWatchdog = useCallback(() => {
    if (stalenessIntervalRef.current) {
      clearInterval(stalenessIntervalRef.current);
      stalenessIntervalRef.current = null;
    }
  }, []);

  /**
   * When WebSocket is flaky (common after long idle sessions), HTTP info still returns account state.
   * Unblocks UI even if WS never delivers clearinghouseState again.
   *
   * Fetches main + all HIP-3 dexes + spot in parallel so aggregated totals match the home
   * screen's `getHyperliquidTradingState`.
   */
  const hydrateFromRest = useCallback(async (force = false) => {
    if (!user) return;
    const now = Date.now();
    if (!force && now - lastRestHydrateAt.current < MIN_REST_HYDRATE_INTERVAL_MS) return;
    lastRestHydrateAt.current = now;
    const requestStartedAt = now;
    const epoch = hydrateEpochRef.current;
    const addr = user;
    try {
      const info = getHlInfoClient();
      const [mainCh, hip3Results, spotCh] = await Promise.all([
        info.clearinghouseState({ user: addr }),
        Promise.all(
          HIP3_DEXES.map(async (dex) => {
            try {
              const ch = await info.clearinghouseState({ user: addr, dex });
              return [dex, ch] as const;
            } catch {
              return null;
            }
          }),
        ),
        getSpotClearinghouseState(addr).catch(() => null),
      ]);
      // Book switched or a newer WS frame landed while HTTP was in flight.
      if (hydrateEpochRef.current !== epoch || !sameHex(userRef.current, addr)) return;
      if (lastWsAccountUpdateAt.current > requestStartedAt) return;
      const byDex: Record<string, any> = {};
      if (mainCh != null) byDex[''] = mainCh;
      hip3Results.forEach((r) => { if (r && r[1] != null) byDex[r[0]] = r[1]; });
      setState((s) => ({
        ...s,
        ...(mainCh != null ? { clearinghouseState: mainCh } : {}),
        ...(Object.keys(byDex).length > 0
          ? { clearinghouseStatesByDex: { ...(s.clearinghouseStatesByDex ?? {}), ...byDex } }
          : {}),
        ...(spotCh != null ? { spotState: spotCh } : {}),
      }));
    } catch {
      // ignore — WS may still recover
    }
  }, [user]);

  const sendSubscribe = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !user) return;

    // Subscribe to:
    // - webData3 (includes agent info + misc)
    // - allDexsClearinghouseState (perp state for main + HIP-3 in one event — see
    //   @nktkas/hyperliquid api/subscription/allDexsClearinghouseState.ts; prevents drift
    //   vs REST home-screen which sums main + HIP-3)
    // - openOrders (live orders list)
    // - spotState (spot balances)
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'webData3', user } }));
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user } }));
    // openOrders is per-dex on HL — without explicit per-HIP3 subs the
    // stream would only carry main perp orders and consumers (margin
    // calculators, slider caps, etc.) would treat HIP-3 resting orders as
    // non-existent. Subscribe to main + every HIP-3 dex; the receive
    // handler tags each batch with its dex (`_dex`) before merging.
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'openOrders', user } }));
    HIP3_DEXES.forEach((dex) => {
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'openOrders', user, dex } }));
    });
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'spotState', user } }));
  }, [user]);

  const disconnect = useCallback(() => {
    clearConnectingWatchdog();
    stopStalenessWatchdog();
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setState((s) => ({ ...s, isConnected: false, connectionStatus: 'disconnected' }));
  }, [clearConnectingWatchdog, stopStalenessWatchdog]);

  const connect = useCallback(() => {
    if (!user) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    clearConnectingWatchdog();
    setState((s) => ({ ...s, connectionStatus: 'connecting' }));
    try {
      const ws = new WebSocket(getHlWsUrl());
      wsRef.current = ws;

      connectingWatchdogRef.current = setTimeout(() => {
        connectingWatchdogRef.current = null;
        if (wsRef.current !== ws) return;
        if (ws.readyState === WebSocket.CONNECTING) {
          // Abandon the stuck CONNECTING state and let `onclose` be the
          // single owner of the reconnect path. Earlier we also did
          // retryCount++ + scheduled a setTimeout(connect, …) here, but
          // `ws.close()` triggers `onclose` async, which does the same
          // thing — so the watchdog and onclose were racing two competing
          // retry timers and inflating retryCount by 2 per timeout.
          try { ws.close(); } catch { /* ignore */ }
        }
      }, WS_CONNECTING_TIMEOUT_MS);

      ws.onopen = () => {
        clearConnectingWatchdog();
        retryCount.current = 0;
        lastMessageAt.current = Date.now();
        setState((s) => ({ ...s, isConnected: true, connectionStatus: 'connected' }));
        setTimeout(sendSubscribe, 50);
        // Keepalive ping every 30s to prevent silent connection drops
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 30000);

        // Staleness watchdog. If no frame arrives for STALE_ACCOUNT_MESSAGE_MS
        // we treat the socket as silently dead, hydrate from REST so PnL /
        // positions don't sit frozen, and force a full reconnect.
        stopStalenessWatchdog();
        stalenessIntervalRef.current = setInterval(() => {
          if (appState.current !== 'active') return;
          if (wsRef.current !== ws) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          const elapsed = Date.now() - lastMessageAt.current;
          if (elapsed > STALE_ACCOUNT_MESSAGE_MS) {
            // Best-effort REST refresh first so consumers get fresh data
            // immediately, then drop the socket so the reconnect path runs.
            void hydrateFromRest(true);
            try { ws.close(); } catch { /* ignore */ }
          }
        }, STALENESS_CHECK_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        lastMessageAt.current = Date.now();
        try {
          const msg = JSON.parse(event.data);
          if (msg?.method === 'pong') return;

          // HL messages look like: { channel: "<type>", data: <payload> }
          const channel = msg?.channel;
          const data = msg?.data;
          if (!channel) return;

          // Drop frames from the prior book while the socket is closing / retargeting.
          const frameUser = typeof data?.user === 'string' ? data.user : null;
          if (frameUser && userRef.current && !sameHex(frameUser, userRef.current)) {
            return;
          }

          if (channel === 'webData3') {
            lastWsAccountUpdateAt.current = Date.now();
            setState((s) => ({ ...s, webData3: data }));
          } else if (channel === 'allDexsClearinghouseState') {
            // payload: { user, clearinghouseStates: [[dex, clearinghouseState], ...] }
            // dex "" = main; HIP-3 dexes have names like "xyz". Schema:
            // @nktkas/hyperliquid/api/subscription/allDexsClearinghouseState.ts
            const entries: Array<[string, any]> = Array.isArray(data?.clearinghouseStates)
              ? data.clearinghouseStates
              : [];
            if (entries.length > 0) {
              lastWsAccountUpdateAt.current = Date.now();
              const byDex: Record<string, any> = {};
              entries.forEach(([dex, chState]) => { byDex[dex ?? ''] = chState; });
              const mainState = byDex[''] ?? byDex['main'];
              setState((s) => ({
                ...s,
                clearinghouseStatesByDex: { ...(s.clearinghouseStatesByDex ?? {}), ...byDex },
                ...(mainState != null ? { clearinghouseState: mainState } : {}),
              }));
            }
          } else if (channel === 'clearinghouseState') {
            // Back-compat for servers still pushing single-dex events (shouldn't happen given
            // our subscription, but handle defensively).
            // Payload: { user, dex, clearinghouseState }
            const dex = (data?.dex ?? '') as string;
            const chState = data?.clearinghouseState ?? data;
            lastWsAccountUpdateAt.current = Date.now();
            setState((s) => ({
              ...s,
              clearinghouseStatesByDex: { ...(s.clearinghouseStatesByDex ?? {}), [dex]: chState },
              ...(dex === '' ? { clearinghouseState: chState } : {}),
            }));
          } else if (channel === 'openOrders') {
            // Per-dex subscriptions deliver `{ user, dex, orders }`; the
            // legacy main-only sub delivers `{ user, orders }` (no dex).
            // Cache by dex, tag every order with `_dex` so downstream
            // bucketing (margin maths, per-asset slider locks) doesn't
            // have to look the dex up from the symbol — HL's order
            // payloads use bare `coin` strings even on HIP-3 dexes.
            const dexKey = typeof data?.dex === 'string' ? data.dex : '';
            const ordersRaw: any[] = Array.isArray(data?.orders)
              ? data.orders
              : Array.isArray(data) ? data : [];
            const tagged = ordersRaw.map((o: any) =>
              o && typeof o === 'object' && o._dex == null
                ? { ...o, _dex: dexKey }
                : o,
            );
            openOrdersByDexRef.current = {
              ...openOrdersByDexRef.current,
              [dexKey]: tagged,
            };
            const merged = Object.values(openOrdersByDexRef.current).flat();
            lastWsAccountUpdateAt.current = Date.now();
            setState((s) => ({ ...s, openOrders: merged }));
          } else if (channel === 'spotState') {
            // payload typically: { user, spotState }
            lastWsAccountUpdateAt.current = Date.now();
            setState((s) => ({ ...s, spotState: data?.spotState ?? data }));
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        setState((s) => ({ ...s, connectionStatus: 'error' }));
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        clearConnectingWatchdog();
        clearRestFallbackTimer();
        stopStalenessWatchdog();
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        setState((s) => ({ ...s, isConnected: false, connectionStatus: 'disconnected' }));
        wsRef.current = null;
        if (appState.current === 'active') {
          retryCount.current += 1;
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s, then cap at 30s
          const delay = Math.min(1000 * Math.pow(2, retryCount.current - 1), 30000);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };
    } catch {
      setState((s) => ({ ...s, connectionStatus: 'error' }));
    }
  }, [clearConnectingWatchdog, clearRestFallbackTimer, sendSubscribe, stopStalenessWatchdog, hydrateFromRest, user]);

  /** Close socket, clear cached snapshots, and connect again (e.g. user refresh after a stale session). */
  const reconnect = useCallback(() => {
    if (!user) return;
    clearConnectingWatchdog();
    clearRestFallbackTimer();
    stopStalenessWatchdog();
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    retryCount.current = 0;
    hydrateEpochRef.current += 1;
    openOrdersByDexRef.current = {};
    setState({
      ...EMPTY_STREAM_STATE,
      connectionStatus: 'connecting',
    });
    void hydrateFromRest(true);
    // Defer so connect() does not hit the OPEN/CONNECTING early-return on a stale socket
    setTimeout(() => connect(), 0);
  }, [user, connect, hydrateFromRest, clearConnectingWatchdog, clearRestFallbackTimer, stopStalenessWatchdog]);

  // Subscribe address follows active trading book (Main or Dedicated sub).
  // Snapshots are cleared synchronously above; this effect only retargets the socket.
  useEffect(() => {
    retryCount.current = 0;
    disconnect();
    if (!user) return undefined;
    const t = setTimeout(() => connect(), 0);
    return () => {
      clearTimeout(t);
      disconnect();
    };
  }, [user, connect, disconnect]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;
      if (prev.match(/inactive|background/) && next === 'active') {
        retryCount.current = 0;
        connect();
      } else if (next.match(/inactive|background/)) {
        disconnect();
      }
    });
    return () => sub.remove();
  }, [connect, disconnect]);

  // When the user flips between mainnet and demo we must close the open WS,
  // drop cached account snapshots (they belong to the OTHER env's account),
  // and reconnect against the new endpoint. The address is the same in both
  // envs but the account state is not.
  useEffect(() => {
    const unsub = onTradingEnvChange(() => {
      reconnect();
    });
    return unsub;
  }, [reconnect]);

  // If WS never delivers clearinghouse (zombie session), still fetch via HTTP after a short wait.
  useEffect(() => {
    clearRestFallbackTimer();
    if (!user || state.clearinghouseState) return undefined;
    restFallbackTimerRef.current = setTimeout(() => {
      restFallbackTimerRef.current = null;
      void hydrateFromRest();
    }, REST_FALLBACK_AFTER_MS);
    return () => clearRestFallbackTimer();
  }, [user, state.clearinghouseState, hydrateFromRest, clearRestFallbackTimer]);

  const agentValidUntil = state.webData3?.userState?.agentValidUntil ?? null;
  const agentAddress = state.webData3?.userState?.agentAddress ?? null;

  return useMemo(
    () => ({
      ...state,
      /** Address the socket is subscribed to (Main or Dedicated sub). */
      subscribedUser: user ?? null,
      agentAddress,
      agentValidUntil,
      reconnect,
      hydrateFromRest,
    }),
    [agentAddress, agentValidUntil, hydrateFromRest, reconnect, state, user],
  );
}

export type HyperliquidAccountStream = ReturnType<typeof useHyperliquidAccountStreamController>;

export const HyperliquidAccountStreamContext = createContext<HyperliquidAccountStream | null>(null);

/**
 * Shared account stream from `HyperliquidAccountStreamProvider`.
 * The optional `user` arg is kept for call-site compatibility but ignored —
 * the provider owns the single WebSocket and retargets it to the active
 * trading book (Main or Dedicated sub).
 */
export function useHyperliquidAccountStream(_user?: Hex): HyperliquidAccountStream {
  const ctx = useContext(HyperliquidAccountStreamContext);
  if (!ctx) {
    throw new Error(
      'useHyperliquidAccountStream must be used within HyperliquidAccountStreamProvider',
    );
  }
  return ctx;
}

