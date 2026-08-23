import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';

export type AlphaStockInfo = {
  symbol: string;
  overview: Record<string, any>;
  latestBalanceSheet: Record<string, any> | null;
  latestCashFlow: Record<string, any> | null;
  nextEarningsDate: string | null;
};

export type AlphaMacroSnapshot = {
  gdp: Record<string, any> | null;
  cpi: Record<string, any> | null;
  inflation: Record<string, any> | null;
  unemployment: Record<string, any> | null;
};

const CACHE_PREFIX = 'alpha-vantage';

const getTodayKey = () => new Date().toISOString().slice(0, 10);

async function getCached<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function setCached<T>(key: string, value: T) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore cache write errors.
  }
}

export async function fetchAlphaStockInfo(symbol: string): Promise<AlphaStockInfo> {
  const normalized = symbol.toUpperCase();
  const cacheKey = `${CACHE_PREFIX}:stock:${normalized}:${getTodayKey()}`;
  const cached = await getCached<AlphaStockInfo>(cacheKey);
  if (cached) return cached;
  const response = await api.get(`/alpha/stock-info/${encodeURIComponent(normalized)}`);
  const data = response.data as AlphaStockInfo;
  await setCached(cacheKey, data);
  return data;
}

export async function fetchAlphaMacroSnapshot(): Promise<AlphaMacroSnapshot> {
  const cacheKey = `${CACHE_PREFIX}:macro:${getTodayKey()}`;
  const cached = await getCached<AlphaMacroSnapshot>(cacheKey);
  if (cached) return cached;
  const response = await api.get('/alpha/macro');
  const data = response.data as AlphaMacroSnapshot;
  await setCached(cacheKey, data);
  return data;
}
