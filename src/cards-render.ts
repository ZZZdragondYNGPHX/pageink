import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { Element, uid, digest, toArrayBuffer } from './model';
import { cardReference, cardText, INK_PACK_MIME } from './cards';
import { projectParagraph } from './mixed-render';
import { revised } from './mixed';
import type { SourceParagraph } from './mixed-host';
import type { InkCardSource } from './cards-host';
import type { Session } from './session';
import { ensureDir } from './storage';

export function textCard(source: SourceParagraph, asset: string, root?: Element, prior?: Element): Element[] {
  const width = root?.width ?? 400, text = projectParagraph(source, asset, Math.max(100, width - 32), prior);
  const rectangle = root ?? convertToExcalidrawElements([{ type: 'rectangle', x: 0, y: 0, width, height: 120,
    strokeColor: '#9aa8b2', backgroundColor: '#ffffff', fillStyle: 'solid', roughness: 0, strokeWidth: 1, roundness: { type: 3 },
    customData: { pageinkCard: { version: 1, kind: 'text' } } }])[0];
  const height = Math.max(120, text.height + 32);
  const nextRoot = revised(rectangle, { height, boundElements: [...(rectangle.boundElements ?? []).filter(b => b.type !== 'text'), { type: 'text', id: text.id }] });
  const dx = 16 + text.width / 2 - width / 2, dy = 16 + text.height / 2 - height / 2, c = Math.cos(nextRoot.angle), s = Math.sin(nextRoot.angle);
  const nextText = { ...text, x: nextRoot.x + width / 2 + dx * c - dy * s - text.width / 2,
    y: nextRoot.y + height / 2 + dx * s + dy * c - text.height / 2, angle: nextRoot.angle, containerId: nextRoot.id, verticalAlign: 'top',
    groupIds: nextRoot.groupIds, locked: true } as Element;
  return [nextRoot, nextText];
}

export function refreshTextCards(elements: readonly Element[], updates: ReadonlyMap<string, { source: SourceParagraph; asset: string }>) {
  const replacements = new Map<string, Element>();
  for (const root of elements) {
    if (root.isDeleted || cardReference(root)?.kind !== 'text') continue;
    const text = cardText(root, elements), update = text && updates.get(text.id);
    if (update) for (const e of textCard(update.source, update.asset, root, text)) replacements.set(e.id, e);
  }
  return elements.map(e => replacements.get(e.id) ?? e);
}

export async function inkCard(session: Session, source: InkCardSource, root?: Element) {
  const hash = await digest(toArrayBuffer(source.archive)), archiveAsset = `inkpack-${hash}`;
  if (!session.manifest.assets[archiveAsset]) {
    const dir = `${session.manifest.resourceDir}/cards`; await ensureDir(session.store.io, dir);
    const path = `${dir}/${hash}.inkpack.bin`; await session.store.io.writeBinary(path, toArrayBuffer(source.archive));
    session.manifest.assets[archiveAsset] = { path, mimeType: INK_PACK_MIME, created: Date.now() }; session.metadataChanged();
  }
  const imageId = uid();
  await session.acceptFiles({ [imageId]: { id: imageId as any, dataURL: source.preview as any, mimeType: 'image/png', created: Date.now() } });
  const width = root?.width ?? Math.min(480, source.width);
  const image = convertToExcalidrawElements([{ type: 'image', x: root?.x ?? 0, y: root?.y ?? 0, width,
    height: width * source.height / source.width, fileId: imageId as any }])[0];
  const customData = { ...root?.customData, pageinkCard: { ...source.reference, archiveAsset } };
  return root ? revised(root, { fileId: imageId, height: image.height, customData } as Partial<Element>) : { ...image, customData } as Element;
}

/** Native arrow bindings remain responsible for movement, resizing and copy/delete. */
export function connectCards(elements: readonly Element[], start: Element, end: Element): Element[] {
  if (start.id === end.id) return [...elements];
  const a = [start.x + start.width + 8, start.y + start.height / 2], b = [end.x - 8, end.y + end.height / 2];
  const skeleton = convertToExcalidrawElements([{ type: 'arrow', x: a[0], y: a[1], points: [[0, 0], [b[0] - a[0], b[1] - a[1]]],
    width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), roughness: 0, strokeColor: '#587b92', strokeWidth: 2,
    endArrowhead: 'arrow' }])[0];
  // The skeleton converter resets bindings; attach to the existing scene only after conversion.
  const arrow = { ...skeleton, startBinding: { elementId: start.id, focus: 0, gap: 8 }, endBinding: { elementId: end.id, focus: 0, gap: 8 } } as Element;
  return [...elements.map(e => e.id === start.id || e.id === end.id ? revised(e, { boundElements: [...(e.boundElements ?? []), { id: arrow.id, type: 'arrow' }] }) : e), arrow];
}
