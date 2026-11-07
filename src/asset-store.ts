import { inflateSync } from 'fflate';

/** [base64 DEFLATE bytes, original length, MIME type]. Generated at build time. */
export type AssetRecord = readonly [string, number, string];
export class AssetStore {
  private urls = new Map<string, string>();
  constructor(private records: Record<string, AssetRecord>) {}
  bytes(path: string): Uint8Array<ArrayBuffer> {
    const record = this.records[path.replace(/^\.\//, '')];
    if (!record) throw Error(`缺少随包资源：${path}`);
    const encoded = atob(record[0]);
    const compressed = Uint8Array.from(encoded, c => c.charCodeAt(0));
    const bytes = new Uint8Array(record[1]);
    const result = inflateSync(compressed, { out: bytes });
    if (result.length !== record[1]) throw Error(`随包资源长度不符：${path}`);
    return bytes;
  }
  url(path: string): string {
    path = path.replace(/^\.\//, '');
    let url = this.urls.get(path);
    if (!url) {
      const bytes = this.bytes(path);
      url = URL.createObjectURL(new Blob([bytes], { type: this.records[path][2] }));
      this.urls.set(path, url);
    }
    return url;
  }
  dispose() { for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear(); }
}
