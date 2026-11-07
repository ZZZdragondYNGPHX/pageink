import { exportToSvg, getCommonBounds } from '@excalidraw/excalidraw';
import { Element } from './model';
import { Session } from './session';
export interface VectorLayer { svg: string; x: number; y: number; width: number; height: number; text: boolean }
export async function vectorLayer(session: Session, elements: readonly Element[]): Promise<VectorLayer> {
  const [x, y, right, bottom] = getCommonBounds(elements);
  const padding = elements.reduce((max, e) => Math.max(max, e.strokeWidth * 4), 8);
  const width = right - x + padding * 2, height = bottom - y + padding * 2;
  const svg = await exportToSvg({ elements, files: { ...session.files }, appState: { exportBackground: false }, exportPadding: padding, skipInliningFonts: true });
  return { svg: svg.outerHTML, x: x - padding, y: y - padding, width, height, text: elements.some(e => e.type === 'text') };
}
