import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { Element, MutableElement } from './model';
import { uid } from './model';
import { snapshotElement } from './element-snapshot';

export interface ClipboardPayload {
  token: string;
  sourceSessionId: string;
  elements: Element[];
  files: BinaryFiles;
}

let stored: ClipboardPayload | null = null;

/** Copy selected elements (and any referenced binary image files) into PageInk's cross-document clipboard. */
export function copyInkClipboard(elements: readonly Element[], allFiles: BinaryFiles, sourceSessionId = ''): ClipboardPayload | null {
  const live = elements.filter(e => !e.isDeleted);
  if (!live.length) return null;
  const files: BinaryFiles = {};
  for (const e of live) {
    if (e.type === 'image' && e.fileId && allFiles[e.fileId]) {
      files[e.fileId] = { ...allFiles[e.fileId] };
    }
  }
  stored = {
    token: `pageink:clipboard:${uid()}`,
    sourceSessionId,
    elements: live.map(e => snapshotElement(e)),
    files,
  };
  return stored;
}

/**
 * Return elements safe to insert into `targetSessionId`.
 * Same-session paste keeps all references; cross-session paste strips document-private asset references
 * (paragraph snapshots, ink-card archives, paragraph anchors) so the target document stays self-contained and valid.
 */
export function prepareClipboardForSession(payload: ClipboardPayload, targetSessionId: string): Element[] {
  if (payload.sourceSessionId && payload.sourceSessionId === targetSessionId) return payload.elements;
  return payload.elements.map(e => {
    if (!e.customData || (!e.customData.pageinkText && !e.customData.pageinkCard && !e.customData.pageinkAnchor)) return e;
    const copy = structuredClone(e) as MutableElement;
    if (copy.customData) {
      const nextData = { ...copy.customData };
      delete nextData.pageinkText;
      delete nextData.pageinkCard;
      delete nextData.pageinkAnchor;
      copy.customData = Object.keys(nextData).length ? nextData : undefined;
    }
    return copy;
  });
}

export function readInkClipboard(): ClipboardPayload | null {
  return stored;
}

export function clearInkClipboard(): void {
  stored = null;
}
