import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Element, Rect } from './model';

/** Methods added by the pinned, checked kernel patches; see docs/kernel-patches.md. */
export type InkApi = ExcalidrawImperativeAPI & {
  inkQuery(rect: Rect): Element[];
  inkErase(patches: ReadonlyMap<string, readonly Element[]>): void;
  inkRebind(elements: readonly Element[], resizedIds: readonly string[]): Element[];
};
