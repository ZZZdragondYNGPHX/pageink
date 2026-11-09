import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { Element } from './model';
import { digest, uid } from './model';
import { ensureDir } from './storage';
import type { Session } from './session';
import type { SourceParagraph } from './mixed-host';
import { revised, TextReference } from './mixed';
import { wrapParagraph } from './text-layout';

/** Immutable UTF-8 source snapshots are ordinary package assets, never kernel image files. */
export async function preserveText(session: Session, source: SourceParagraph): Promise<string> {
  const bytes = new TextEncoder().encode(source.source), hash = await digest(bytes.buffer);
  const id = `markdown-${hash}`;
  if (!session.manifest.assets[id]) {
    const dir = `${session.manifest.resourceDir}/text`; await ensureDir(session.store.io, dir);
    const path = `${dir}/${hash}.md.bin`;
    await session.store.io.writeBinary(path, bytes.buffer);
    session.manifest.assets[id] = { path, mimeType: 'text/markdown', created: Date.now() }; session.metadataChanged();
  }
  return id;
}

/** The same text elements power screen, search, region previews and full vector/PDF export. */
export function projectParagraph(source: SourceParagraph, snapshotAsset: string, width: number, existing?: Element): Element {
  const fontSize = existing?.type === 'text' ? existing.fontSize : 20;
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
  context.font = `${fontSize}px Helvetica, Segoe UI Emoji`;
  const wrapped = wrapParagraph(source.text, width, text => context.measureText(text).width);
  canvas.width = canvas.height = 0;
  const text = convertToExcalidrawElements([{ type: 'text', id: existing?.id ?? uid(), x: existing?.x ?? 0, y: existing?.y ?? 0,
    text: wrapped, originalText: source.text, fontFamily: 2, fontSize, lineHeight: 1.5 as any, width, autoResize: false, strokeColor: existing?.strokeColor ?? '#222222' }], { regenerateIds: false })[0];
  const reference: TextReference = { version: 1, path: source.path, blockId: source.blockId, snapshotAsset, width };
  const patch = { ...text, index: existing?.index ?? text.index, angle: 0, locked: true, customData: { ...existing?.customData, pageinkText: reference } } as Element;
  return existing ? revised(existing, patch) : patch;
}
