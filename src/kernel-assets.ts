export { assetUrl as inkAssetUrl } from './assets';
const ownedFontFaces = new Map<FontFace, Document>();
export function trackInkFontFace(face: FontFace) { ownedFontFaces.set(face, activeDocument); return face; }
export function clearInkFontFaces() { for (const [face, doc] of ownedFontFaces) doc.fonts.delete(face); ownedFontFaces.clear(); }
