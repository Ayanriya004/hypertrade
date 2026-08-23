import AsyncStorage from '@react-native-async-storage/async-storage';

const DRAWINGS_KEY = 'chartDrawings';

export type SavedDrawing = {
  start: { time: number; price: number };
  end: { time: number; price: number };
  tool: string;
  color?: string;
};

function getKey(symbol: string) {
  return `${DRAWINGS_KEY}:${symbol}`;
}

export async function loadDrawings(symbol: string): Promise<SavedDrawing[]> {
  try {
    const raw = await AsyncStorage.getItem(getKey(symbol));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveDrawings(symbol: string, drawings: SavedDrawing[]) {
  try {
    if (drawings.length === 0) {
      await AsyncStorage.removeItem(getKey(symbol));
    } else {
      await AsyncStorage.setItem(getKey(symbol), JSON.stringify(drawings));
    }
  } catch {
    // ignore storage errors
  }
}
