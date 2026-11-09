import { safePath, type Element, type Manifest } from './model';

/** The .md remains authoritative. The asset preserves the exact source used for this projection. */
export interface TextReference {
  version: 1;
  path: string;
  blockId: string;
  snapshotAsset: string;
  width: number;
}
export interface InkAnchor { version: 1; elementId: string }
export type LinkedText = Extract<Element, { type: 'text' }>;
export const textReference = (e: Element): TextReference | undefined => e.type === 'text' ? e.customData?.pageinkText : undefined;
export const inkAnchor = (e: Element): InkAnchor | undefined => e.type === 'freedraw' ? e.customData?.pageinkAnchor : undefined;
export function validateMixed(elements: readonly Element[], manifest: Manifest) {
  for (const e of elements) {
    if (e.customData?.pageinkText !== undefined) {
      const ref = textReference(e);
      if (!ref || ref.version !== 1 || typeof ref.path !== 'string' || !ref.path.endsWith('.md') || typeof ref.blockId !== 'string' || !/^[A-Za-z0-9-]+$/.test(ref.blockId) || typeof ref.snapshotAsset !== 'string' || !Number.isFinite(ref.width) || ref.width <= 0 || manifest.assets[ref.snapshotAsset]?.mimeType !== 'text/markdown') throw Error('文字引用损坏或版本不受支持；原文件未修改。');
      safePath(ref.path);
    }
    if (e.customData?.pageinkAnchor !== undefined) {
      const anchor = inkAnchor(e);
      if (!anchor || anchor.version !== 1 || typeof anchor.elementId !== 'string' || !anchor.elementId) throw Error('笔迹锚定数据损坏；原文件未修改。');
    }
  }
}

export interface Paragraph { from: number; to: number; text: string; blockId?: string }
/** A deliberately small source projection: plain paragraphs and ATX headings, with native block IDs.
 * Complex Markdown blocks stay in their native editor; never guess their boundaries. Offsets are UTF-16. */
export function paragraphs(source: string): Paragraph[] {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]);
  const result: Paragraph[] = [];
  let pending: { from: number; to: number; lines: string[] } | undefined;
  let fence = '', yaml = source.startsWith('---\n') || source.startsWith('---\r\n');
  const finish = () => {
    if (!pending) return;
    const raw = pending.lines.join('\n'), id = raw.match(/(?:\s|^)\^([A-Za-z0-9-]+)\s*$/);
    const text = (id ? raw.slice(0, id.index) : raw).trim();
    if (text && !/^(?: {4}|\t|\s*(?:>|[-+*]\s|\d+[.)]\s|\||<|!\[|!\[\[|\$\$|\[\^|(?:---+|___+|\*\*\*+)\s*$))/.test(raw) && !raw.split('\n').some(line => /^\s*\|/.test(line))) {
      result.push({ from: pending.from, to: pending.to, text, blockId: id?.[1] });
    }
    pending = undefined;
  };
  for (const match of lines) {
    const line = match[0].replace(/\r?\n$/, ''), from = match.index!, to = from + line.length;
    if (yaml) { if (from > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false; continue; }
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = ''; continue; }
    if (delimiter) { finish(); fence = delimiter[1]; continue; }
    if (!line.trim()) { finish(); continue; }
    if (/^ {0,3}#{1,6}\s/.test(line)) finish();
    pending ??= { from, to, lines: [] };
    pending.to = to; pending.lines.push(line);
    if (/^ {0,3}#{1,6}\s/.test(line)) finish();
  }
  finish(); return result;
}
export function findParagraph(source: string, blockId: string): Paragraph {
  const matches = paragraphs(source).filter(p => p.blockId === blockId);
  if (matches.length !== 1) throw Error(matches.length ? '段落标识重复，请在原笔记中保留唯一标识后重试。' : '原段落或标识已删除、或已改为复杂 Markdown 块；页面上的文字和笔迹已保留。');
  return matches[0];
}
/** Prepare a single native-editor transaction without changing the stable block ID. */
export function paragraphEdit(source: string, blockId: string, text: string) {
  const paragraph = findParagraph(source, blockId), value = text.trim();
  const raw = source.slice(paragraph.from, paragraph.to), marker = raw.match(/\s+\^[A-Za-z0-9-]+\s*$/);
  const to = marker ? paragraph.from + marker.index! : paragraph.to;
  const next = source.slice(0, paragraph.from) + value + source.slice(to);
  if (!value || /(?:^|\s)\^[A-Za-z0-9-]+\s*$/.test(value) || paragraphs(next).length !== paragraphs(source).length || findParagraph(next, blockId).text !== value) throw Error('请保留一个普通段落或标题。多段落、列表或块标识请在原笔记中编辑。');
  return { from: paragraph.from, to, text: value, next };
}
export const revised = (e: Element, patch: Partial<Element>): Element => ({ ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now() } as Element);

/** Move a paragraph and its explicitly attached strokes by translation only. Raw samples are shared. */
export function moveParagraph(elements: readonly Element[], id: string, dx: number, dy: number): Element[] {
  return elements.map(e => e.id === id || inkAnchor(e)?.elementId === id ? revised(e, { x: e.x + dx, y: e.y + dy }) : e);
}

/** Reflow vertically overlapping columns on a page; anchored ink follows its paragraph's origin.
 * Paragraph-internal reflow never stretches the original handwriting. */
export function reflowParagraphs(elements: readonly Element[], replacements: ReadonlyMap<string, Element>): Element[] {
  const refs = elements.filter(e => !e.isDeleted && textReference(e) && !(e.type === 'text' && e.containerId)).sort((a, b) => a.y - b.y);
  const shifts = new Map<string, number>(), next = new Map<string, Element>();
  for (const old of refs) {
    const replacement = replacements.get(old.id) ?? old;
    let shift = 0, nearest = -Infinity;
    for (const previous of refs) {
      if (previous === old) break;
      const width = textReference(previous)!.width, ownWidth = textReference(old)!.width;
      if (previous.x >= old.x + ownWidth || old.x >= previous.x + width || previous.y + previous.height > old.y + 1) continue;
      const moved = next.get(previous.id)!;
      const bottom = previous.y + previous.height, delta = moved.y + moved.height - bottom;
      if (bottom > nearest) { nearest = bottom; shift = delta; }
      else if (bottom === nearest) shift = Math.max(shift, delta);
    }
    shifts.set(old.id, shift);
    next.set(old.id, shift ? revised(replacement, { y: old.y + shift }) : replacement);
  }
  return elements.map(e => {
    const paragraph = next.get(e.id); if (paragraph) return paragraph;
    const anchor = inkAnchor(e), shift = anchor ? shifts.get(anchor.elementId) : 0;
    return shift ? revised(e, { y: e.y + shift }) : e;
  });
}

export function detachParagraph(elements: readonly Element[], id: string): Element[] {
  return elements.filter(e => e.id !== id).map(e => {
    if (inkAnchor(e)?.elementId !== id) return e;
    const customData: Record<string, any> = { ...e.customData }; delete customData.pageinkAnchor;
    return revised(e, { customData });
  });
}

/** When copying, references within the copied set follow their new identities; lone ink detaches. */
export function retargetAnchors(e: Element, ids: ReadonlyMap<string, string>): Element {
  const anchor = inkAnchor(e); if (!anchor) return e;
  const customData: Record<string, any> = { ...e.customData }, target = ids.get(anchor.elementId);
  if (target) customData.pageinkAnchor = { ...anchor, elementId: target };
  else delete customData.pageinkAnchor;
  return { ...e, customData } as Element;
}
