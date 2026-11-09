import { Element, Manifest, safePath } from './model';
import { textReference } from './mixed';

export const INK_PACK_MIME = 'application/x-pageink';
export interface InkCardReference {
  version: 1; kind: 'ink'; path: string; document: string; page: string; region: string; title: string; archiveAsset: string;
}
export type CardReference = { version: 1; kind: 'text' } | InkCardReference;
export const cardReference = (element: Element): CardReference | undefined => element.customData?.pageinkCard;
export function cardText(root: Element, elements: readonly Element[]) {
  return elements.find(e => !e.isDeleted && e.type === 'text' && e.containerId === root.id && textReference(e));
}
export const cardTitle = (root: Element, elements: readonly Element[]) => {
  const ref = cardReference(root);
  if (ref?.kind === 'ink') return ref.title;
  const text = cardText(root, elements);
  return text?.type === 'text' ? text.originalText : '文字卡片';
};
export function validateCards(elements: readonly Element[], manifest: Manifest) {
  for (const e of elements) {
    const c = cardReference(e); if (c === undefined) continue;
    if (!c || c.version !== 1 || !['text', 'ink'].includes(c.kind) || c.kind === 'text' && e.type !== 'rectangle') throw Error('卡片数据损坏或版本不受支持；原文件未修改。');
    if (c.kind === 'ink') {
      if (e.type !== 'image' || !['document', 'page', 'region', 'title', 'path', 'archiveAsset'].every(key => typeof c[key as keyof InkCardReference] === 'string' && c[key as keyof InkCardReference]) || !c.path.endsWith('.inknote') || manifest.assets[c.archiveAsset]?.mimeType !== INK_PACK_MIME || !e.fileId || !manifest.assets[e.fileId]?.mimeType.startsWith('image/')) throw Error('手写卡片缺少完整原件或预览；原文件未修改。');
      safePath(c.path);
    }
  }
}
