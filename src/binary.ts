import type { BinaryFileData } from '@excalidraw/excalidraw/types';

/** Decode only local data URLs; image acceptance never makes a network request. */
export function dataUrlBytes(value: string): ArrayBuffer {
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0) throw Error('图片资源不是有效的本地数据。');
  const payload = value.slice(comma + 1);
  if (value.slice(0, comma).endsWith(';base64')) return Uint8Array.from(atob(payload), c => c.charCodeAt(0)).buffer;
  const encoded = new TextEncoder().encode(payload), bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const hex = String.fromCharCode(encoded[i + 1], encoded[i + 2]);
    if (encoded[i] === 37 && /^[\da-f]{2}$/i.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(encoded[i]);
  }
  return Uint8Array.from(bytes).buffer;
}

export function imageFile(id: string, dataURL: string, mimeType: string, created = Date.now()): BinaryFileData {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/bmp', 'image/avif'].includes(mimeType)) throw Error('不支持的图片类型。');
  dataUrlBytes(dataURL);
  return { id: id as BinaryFileData['id'], dataURL: dataURL as BinaryFileData['dataURL'], mimeType: mimeType as BinaryFileData['mimeType'], created };
}

export function readDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(Error('图片读取失败。'));
    reader.onerror = () => reject(reader.error ?? Error('图片读取失败。'));
    reader.readAsDataURL(blob);
  });
}
