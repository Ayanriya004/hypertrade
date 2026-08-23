import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data.byteLength > 0 ? data : new ArrayBuffer(0);
  }
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
  }
  throw new Error('Unexpected PDF response format');
}

/** Save PDF bytes and open the native share sheet (or browser download on web). */
export async function shareStatementPdf(
  data: ArrayBuffer,
  filename: string,
): Promise<void> {
  const buffer = toArrayBuffer(data);
  if (!buffer.byteLength) {
    throw new Error('Statement PDF is empty');
  }

  if (Platform.OS === 'web') {
    const doc = (globalThis as typeof globalThis & { document?: Document }).document;
    if (!doc) throw new Error('Download not available');
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    doc.body.appendChild(link);
    link.click();
    doc.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }

  const safeName = filename.replace(/[^\w.-]/g, '_');
  const file = new File(Paths.cache, safeName);
  file.write(new Uint8Array(buffer));

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: safeName,
    });
  } else {
    throw new Error('Sharing is not available on this device');
  }
}
