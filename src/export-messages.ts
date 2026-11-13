import type { Page, Rect } from './model';
import type { VectorLayer } from './vector-export';

export type ExportRequest =
  | { id: number; kind: 'init'; data: { font: ArrayBuffer; source?: ArrayBuffer } }
  | { id: number; kind: 'page'; data: { page: Page; box: Rect; paper?: string; paginated: boolean; layer?: VectorLayer } }
  | { id: number; kind: 'finish'; data?: undefined };
export interface ExportResponse { id: number; result?: ArrayBuffer; error?: string }
