export { assetUrl as inkAssetUrl } from './assets';
const ownedFontFaces = new Set<FontFace>();
export function trackInkFontFace(face: FontFace) { ownedFontFaces.add(face); return face; }
export function clearInkFontFaces() { for (const face of ownedFontFaces) document.fonts.delete(face); ownedFontFaces.clear(); }
