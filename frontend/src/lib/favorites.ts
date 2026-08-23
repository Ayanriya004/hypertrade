import AsyncStorage from '@react-native-async-storage/async-storage';

const FAVORITES_PREFIX = 'favorites:';

function getFavoritesKey(ownerId?: string | null) {
  return `${FAVORITES_PREFIX}${ownerId ?? 'guest'}`;
}

export async function loadFavorites(ownerId?: string | null): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(getFavoritesKey(ownerId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === 'string');
  } catch {
    return [];
  }
}

export async function saveFavorites(ownerId: string | null | undefined, favorites: string[]) {
  const next = Array.from(new Set(favorites.filter(Boolean)));
  await AsyncStorage.setItem(getFavoritesKey(ownerId), JSON.stringify(next));
  return next;
}

export async function toggleFavorite(ownerId: string | null | undefined, coin: string) {
  const current = await loadFavorites(ownerId);
  const exists = current.includes(coin);
  const next = exists ? current.filter((c) => c !== coin) : [...current, coin];
  await saveFavorites(ownerId, next);
  return { favorites: next, isFavorite: !exists };
}

export async function reorderFavorites(ownerId: string | null | undefined, fromIndex: number, toIndex: number) {
  const current = await loadFavorites(ownerId);
  if (fromIndex < 0 || fromIndex >= current.length || toIndex < 0 || toIndex >= current.length) {
    return current;
  }
  const next = [...current];
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  await saveFavorites(ownerId, next);
  return next;
}