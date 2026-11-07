export let inkAssetBase = '';
export function setInkAssetBase(path: string) { inkAssetBase = path; }
const ownedFontFaces = new Set<FontFace>();
export function trackInkFontFace(face: FontFace) { ownedFontFaces.add(face); return face; }
export function clearInkFontFaces() { for (const face of ownedFontFaces) document.fonts.delete(face); ownedFontFaces.clear(); }
