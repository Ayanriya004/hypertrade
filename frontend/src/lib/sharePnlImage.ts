import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/**
 * Hand the captured PnL PNG to the OS share sheet as a real image.
 * mimeType/UTI matter for the picker thumbnail; a .png cache name helps Android sniffing.
 */
export async function sharePnlPng(capturedUri: string): Promise<void> {
  if (Platform.OS === 'web') {
    const nav = (globalThis as { navigator?: { share?: (opts: { title: string; url: string }) => Promise<void> } }).navigator;
    if (!nav?.share) {
      throw new Error('share-unavailable');
    }
    await nav.share({ title: 'HyperTrade PnL', url: capturedUri });
    return;
  }

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error('share-unavailable');
  }

  const uri = await copyToPngCache(capturedUri);
  await Sharing.shareAsync(uri, {
    mimeType: 'image/png',
    UTI: 'public.png',
    dialogTitle: 'HyperTrade PnL',
  });
}

async function copyToPngCache(capturedUri: string): Promise<string> {
  try {
    const dest = `${FileSystem.cacheDirectory}hypertrade-pnl.png`;
    const from = capturedUri.startsWith('file://') ? capturedUri : `file://${capturedUri}`;
    await FileSystem.copyAsync({ from, to: dest });
    return dest;
  } catch {
    return capturedUri;
  }
}
