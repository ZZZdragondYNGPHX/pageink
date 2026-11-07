import records from 'pageink:assets';
import { AssetStore } from './asset-store';

// The installed main.js includes these bytes. No downloads or files are installed
// at runtime; PDF.js receives fresh arrays so worker transfers cannot detach a cache.
const assets = new AssetStore(records);
export const assetBytes = (path: string) => assets.bytes(path);
export const assetUrl = (path: string) => assets.url(path);
export const clearAssetUrls = () => assets.dispose();

export class EmbeddedCMapReader {
  async fetch({ name }: { name: string }) { return { cMapData: assetBytes(`cmaps/${name}.bcmap`), isCompressed: true }; }
}
export class EmbeddedStandardFonts {
  async fetch({ filename }: { filename: string }) { return assetBytes(`standard_fonts/${filename}`); }
}
export class EmbeddedWasm {
  async fetch({ filename }: { filename: string }) { return assetBytes(`wasm/${filename}`); }
}
