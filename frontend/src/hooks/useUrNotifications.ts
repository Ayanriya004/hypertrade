/**
 * useUrNotifications — the in-app banking notification inbox (bell feed).
 *
 * Two hooks share one in-memory unread counter so mark-read on the inbox
 * page updates the dashboard bell instantly (no stale badge flash on back).
 *   • useUrUnreadCount() powers the dashboard bell badge. It refreshes on
 *     screen focus and polls while the bank screen is focused.
 *   • useUrNotificationFeed() powers the notifications page: list by tab
 *     (All / Transaction / Card / Verification), pull-to-refresh, mark-read on
 *     tap, and the "mark all read" duster action.
 *
 * Rows are produced server-side from UR webhooks (KYC outcome, pay-ins, card
 * spend) and scoped by Privy user_id — the frontend only reads/marks-read.
 */
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { InteractionManager } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useAuth } from '../providers/AuthContext';
import {
  fetchUrNotifications,
  fetchUrNotificationsUnreadCount,
  markAllUrNotificationsRead,
  markUrNotificationRead,
  type UrNotification,
} from '../lib/urApi';

/**
 * How often the bell badge re-checks the unread count while the screen is
 * focused. Webhook-driven rows (pay-in, card spend, KYC) land asynchronously,
 * so without polling the badge only updated on screen focus — meaning a
 * notification that arrived while the user sat on the dashboard wouldn't show
 * until they navigated away and back. 30s keeps it live without hammering.
 */
const UNREAD_POLL_MS = 30000;

// Bell badge + inbox header share this so mark-all-read on /bank-notifications
// clears the dashboard badge immediately instead of waiting for a refetch.
let badgeUnreadCount = 0;
const badgeUnreadListeners = new Set<() => void>();

function getBadgeUnreadCount(): number {
  return badgeUnreadCount;
}

function subscribeBadgeUnreadCount(onStoreChange: () => void): () => void {
  badgeUnreadListeners.add(onStoreChange);
  return () => badgeUnreadListeners.delete(onStoreChange);
}

function publishBadgeUnreadCount(next: number): void {
  const n = Math.max(0, Math.floor(next));
  if (n === badgeUnreadCount) return;
  badgeUnreadCount = n;
  badgeUnreadListeners.forEach((l) => l());
}

// Inbox list cache + optimistic read IDs — shared across mount/focus cycles so
// a slow in-flight feed fetch cannot overwrite mark-read during the back
// navigation animation (stale server payload briefly restored read:false).
//
// The id set is STICKY for the whole session: once the user marks a row read we
// never let it render unread again, even if a later GET hits a read-replica
// that hasn't yet seen our mark-read PATCH (the exact cause of the "row goes
// bright on back-transition" flash). We only clear it on sign-out. `mergeReadState`
// MUST stay pure — it runs inside a render-phase useMemo, so it can't mutate
// the set (deleting an id there removed the protection and reintroduced the bug).
let feedCache: UrNotification[] | null = null;
const optimisticallyReadIds = new Set<string>();

function mergeReadState(rows: UrNotification[]): UrNotification[] {
  if (optimisticallyReadIds.size === 0) return rows;
  return rows.map((n) =>
    !n.read && optimisticallyReadIds.has(n.id) ? { ...n, read: true } : n,
  );
}

function rememberFeed(rows: UrNotification[]): UrNotification[] {
  const merged = mergeReadState(rows);
  feedCache = merged;
  return merged;
}

/** Lightweight unread-count poller for the bell badge. */
export function useUrUnreadCount(): { count: number; refresh: () => void } {
  const { isAuthenticated, getAccessToken } = useAuth();
  const count = useSyncExternalStore(
    subscribeBadgeUnreadCount,
    getBadgeUnreadCount,
    () => 0,
  );

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      publishBadgeUnreadCount(0);
      return;
    }
    try {
      const token = await getAccessToken();
      if (!token) return;
      const c = await fetchUrNotificationsUnreadCount(token);
      publishBadgeUnreadCount(c);
    } catch {
      // Badge is best-effort; never surface an error here.
    }
  }, [isAuthenticated, getAccessToken]);

  // Fetch on focus AND poll on an interval while focused, so a webhook that
  // lands while the user is looking at the dashboard updates the badge live.
  useFocusEffect(
    useCallback(() => {
      refresh();
      const id = setInterval(refresh, UNREAD_POLL_MS);
      return () => clearInterval(id);
    }, [refresh]),
  );

  return { count, refresh };
}

/**
 * Filter buckets surfaced as page tabs — mapped to the three real UR alert
 * categories (the same ones users toggle in Push alerts) plus "all".
 *   • transaction  → money moves (deposit / pay-in / payout)
 *   • card         → card spend / refund
 *   • verification → KYC / compliance outcomes
 */
export type UrNotificationFilter = 'all' | 'transaction' | 'card' | 'verification';

const CARD_TYPES = new Set(['card_spend', 'card_refund']);
const VERIFICATION_TYPES = new Set(['kyc_status']);

function matchesFilter(n: UrNotification, f: UrNotificationFilter): boolean {
  if (f === 'all') return true;
  if (f === 'verification') return VERIFICATION_TYPES.has(n.type) || n.category === 'system';
  if (f === 'card') return CARD_TYPES.has(n.type);
  // transaction: anything that isn't a card spend or a verification event
  return !CARD_TYPES.has(n.type) && !VERIFICATION_TYPES.has(n.type) && n.category !== 'system';
}

export interface UseUrNotificationFeed {
  items: UrNotification[];
  loading: boolean;
  refreshing: boolean;
  unreadCount: number;
  filter: UrNotificationFilter;
  setFilter: (f: UrNotificationFilter) => void;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export function useUrNotificationFeed(): UseUrNotificationFeed {
  const { isAuthenticated, getAccessToken } = useAuth();
  const inboxFocusedRef = useRef(false);
  /** Bumps on blur to drop in-flight feed fetches started on the prior focus. */
  const loadEpochRef = useRef(0);
  const unreadCount = useSyncExternalStore(
    subscribeBadgeUnreadCount,
    getBadgeUnreadCount,
    () => 0,
  );
  // Master list (all categories); the active tab filters it client-side so tab
  // switches are instant and the type→bucket mapping lives in one place.
  const [allItems, setAllItems] = useState<UrNotification[]>(() =>
    mergeReadState(feedCache ?? []),
  );
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;
  /** Forces list re-derive after optimistic mark-read (module-level ID set). */
  const [readEpoch, setReadEpoch] = useState(0);
  const [filter, setFilter] = useState<UrNotificationFilter>('all');
  const [loading, setLoading] = useState(() => feedCache == null);
  const [refreshing, setRefreshing] = useState(false);

  const items = useMemo(
    () =>
      mergeReadState(allItems).filter((n) => matchesFilter(n, filter)),
    [allItems, filter, readEpoch],
  );

  const applyFeed = useCallback(
    (rows: UrNotification[], unread: number, epoch: number) => {
      if (!inboxFocusedRef.current || epoch !== loadEpochRef.current) {
        return;
      }
      const merged = rememberFeed(rows);
      setAllItems(merged);
      const mergedUnread = merged.filter((n) => !n.read).length;
      publishBadgeUnreadCount(
        optimisticallyReadIds.size > 0 ? mergedUnread : unread,
      );
    },
    [],
  );

  const load = useCallback(
    async (mode: 'initial' | 'refresh', epoch: number) => {
      if (!isAuthenticated) {
        feedCache = null;
        optimisticallyReadIds.clear();
        setAllItems([]);
        publishBadgeUnreadCount(0);
        setLoading(false);
        return;
      }
      if (mode === 'refresh') setRefreshing(true);
      else if (!feedCache?.length) setLoading(true);
      try {
        const token = await getAccessToken();
        if (!token || epoch !== loadEpochRef.current) return;
        const res = await fetchUrNotifications(token, { limit: 100 });
        applyFeed(res.notifications, res.unreadCount, epoch);
      } catch {
        // Keep whatever we had; the page shows an empty state otherwise.
      } finally {
        if (epoch === loadEpochRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [isAuthenticated, getAccessToken, applyFeed],
  );

  // Reload whenever the screen regains focus (tab changes filter locally).
  // The refetch is deferred until the navigation transition finishes
  // (InteractionManager) so no setState churns the list while the screen is
  // animating in/out — mid-transition re-renders on a freezeOnBlur stack are a
  // known source of visual flicker (React Navigation: "delaying effect until
  // transition finishes").
  useFocusEffect(
    useCallback(() => {
      const epoch = ++loadEpochRef.current;
      inboxFocusedRef.current = true;
      // Show the last-known list immediately (already read-merged), no fetch yet.
      if (feedCache) {
        setAllItems(mergeReadState(feedCache));
        setLoading(false);
      }
      const task = InteractionManager.runAfterInteractions(() => {
        if (epoch === loadEpochRef.current) void load('initial', epoch);
      });
      return () => {
        task.cancel();
        inboxFocusedRef.current = false;
        loadEpochRef.current += 1;
        // Pin what the user last saw — never let a late fetch clobber this on
        // the next focus effect re-run during the back animation.
        feedCache = mergeReadState(allItemsRef.current);
      };
    }, [load]),
  );

  const refresh = useCallback(async () => {
    await load('refresh', loadEpochRef.current);
  }, [load]);

  const markRead = useCallback(
    async (id: string) => {
      optimisticallyReadIds.add(id);
      setReadEpoch((e) => e + 1);
      setAllItems((prev) => {
        const next = prev.map((n) =>
          n.id === id && !n.read ? { ...n, read: true } : n,
        );
        feedCache = mergeReadState(next);
        return next;
      });
      publishBadgeUnreadCount(Math.max(0, getBadgeUnreadCount() - 1));
      try {
        const token = await getAccessToken();
        if (!token) return;
        const remaining = await markUrNotificationRead(token, id);
        publishBadgeUnreadCount(remaining);
      } catch {
        // best-effort
      }
    },
    [getAccessToken],
  );

  const markAllRead = useCallback(async () => {
    setAllItems((prev) => {
      const next = prev.map((n) => {
        if (!n.read) optimisticallyReadIds.add(n.id);
        return n.read ? n : { ...n, read: true };
      });
      feedCache = mergeReadState(next);
      return next;
    });
    setReadEpoch((e) => e + 1);
    publishBadgeUnreadCount(0);
    try {
      const token = await getAccessToken();
      if (!token) return;
      await markAllUrNotificationsRead(token);
    } catch {
      // best-effort
    }
  }, [getAccessToken]);

  return {
    items,
    loading,
    refreshing,
    unreadCount,
    filter,
    setFilter,
    refresh,
    markRead,
    markAllRead,
  };
}
