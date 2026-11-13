import type { PageTemplate } from './model';

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'select' | 'hand' | 'text' | 'shape' | 'capture';
export type ShapeKind = 'rectangle' | 'ellipse' | 'diamond' | 'line' | 'arrow';
export type SidebarTab = 'pages' | 'bookmarks' | 'search';
export interface ScratchFrame { right: number; top: number; width: number; height: number }

/** Device-independent writing preferences, remembered between documents. */
export interface Preferences {
  tool: ToolId;
  pen: { color: string; width: number; pressure: boolean; scribble: boolean };
  highlighter: { color: string; width: number };
  eraser: { mode: 'partial' | 'stroke'; size: number };
  shape: { kind: ShapeKind; color: string; width: number };
  text: { color: string; size: number };
  capture: { shape: 'rect' | 'lasso'; annotations: boolean };
  fingerDraws: boolean;
  sidebar: { pages: boolean; canvas: boolean; tab: SidebarTab };
  scratch: ScratchFrame;
  scratchPlacement: 'docked' | 'floating';
  newTemplate: PageTemplate;
}

export const PEN_COLORS = ['#1f2329', '#2463c8', '#d23b3b', '#1f8a54', '#e08a1a', '#7c4dcc'] as const;
export const HIGHLIGHTER_COLORS = ['#ffd84d', '#9be38f', '#8cc9ff', '#ff9ec7', '#ffb067'] as const;
export const PEN_WIDTHS = [0.5, 1, 2, 4] as const;
export const HIGHLIGHTER_WIDTHS = [2.5, 4, 6] as const;
export const SHAPE_WIDTHS = [1, 2, 4] as const;
export const TEXT_SIZES = [{ size: 16, label: '小' }, { size: 20, label: '中' }, { size: 28, label: '大' }, { size: 40, label: '特大' }] as const;
export const ERASER_SIZES = [{ size: 6, label: '小' }, { size: 12, label: '中' }, { size: 24, label: '大' }] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  tool: 'pen',
  pen: { color: PEN_COLORS[0], width: 1, pressure: false, scribble: true },
  highlighter: { color: HIGHLIGHTER_COLORS[0], width: 4 },
  eraser: { mode: 'partial', size: 12 },
  shape: { kind: 'rectangle', color: PEN_COLORS[1], width: 2 },
  text: { color: PEN_COLORS[0], size: 20 },
  capture: { shape: 'rect', annotations: false },
  fingerDraws: false,
  sidebar: { pages: false, canvas: false, tab: 'pages' },
  scratch: { right: 24, top: 24, width: 420, height: 340 },
  scratchPlacement: 'docked',
  newTemplate: 'blank',
};

const TOOLS: readonly ToolId[] = ['pen', 'highlighter', 'eraser', 'lasso', 'select', 'hand', 'text', 'shape', 'capture'];
const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const isNumber = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Accepts stored data from any earlier version; unknown or invalid values fall back to defaults. */
export function normalizePreferences(raw: unknown): Preferences {
  const record = (item: unknown): Record<string, unknown> => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const value = record(raw);
  const pen = record(value.pen), highlighter = record(value.highlighter), eraser = record(value.eraser), shape = record(value.shape), text = record(value.text), capture = record(value.capture), sidebar = record(value.sidebar), scratch = record(value.scratch);
  const d = DEFAULT_PREFERENCES;
  const pick = <T>(candidate: unknown, fallback: T, valid: (v: unknown) => boolean): T => valid(candidate) ? candidate as T : fallback;
  return {
    tool: pick(value.tool, d.tool, v => TOOLS.includes(v as ToolId) && v !== 'capture'),
    pen: { color: pick(pen.color, d.pen.color, isColor), width: pick(pen.width, d.pen.width, v => isNumber(v, 0.25, 16)), pressure: pick(pen.pressure, d.pen.pressure, v => typeof v === 'boolean'), scribble: pick(pen.scribble, d.pen.scribble, v => typeof v === 'boolean') },
    highlighter: { color: pick(highlighter.color, d.highlighter.color, isColor), width: pick(highlighter.width, d.highlighter.width, v => isNumber(v, 1, 16)) },
    eraser: { mode: pick(eraser.mode, d.eraser.mode, v => v === 'partial' || v === 'stroke'), size: pick(eraser.size, d.eraser.size, v => isNumber(v, 2, 64)) },
    shape: { kind: pick(shape.kind, d.shape.kind, v => ['rectangle', 'ellipse', 'diamond', 'line', 'arrow'].includes(v as string)), color: pick(shape.color, d.shape.color, isColor), width: pick(shape.width, d.shape.width, v => isNumber(v, 0.5, 16)) },
    text: { color: pick(text.color, d.text.color, isColor), size: pick(text.size, d.text.size, v => isNumber(v, 8, 120)) },
    capture: { shape: pick(capture.shape, d.capture.shape, v => v === 'rect' || v === 'lasso'), annotations: pick(capture.annotations, d.capture.annotations, v => typeof v === 'boolean') },
    fingerDraws: pick(value.fingerDraws, d.fingerDraws, v => typeof v === 'boolean'),
    sidebar: { pages: pick(sidebar.pages, d.sidebar.pages, v => typeof v === 'boolean'), canvas: pick(sidebar.canvas, d.sidebar.canvas, v => typeof v === 'boolean'), tab: pick(sidebar.tab, d.sidebar.tab, v => ['pages', 'bookmarks', 'search'].includes(v as string)) },
    scratch: { right: pick(scratch.right, d.scratch.right, v => isNumber(v, 0, 10000)), top: pick(scratch.top, d.scratch.top, v => isNumber(v, 0, 10000)), width: pick(scratch.width, d.scratch.width, v => isNumber(v, 260, 4000)), height: pick(scratch.height, d.scratch.height, v => isNumber(v, 200, 4000)) },
    scratchPlacement: pick(value.scratchPlacement, d.scratchPlacement, v => v === 'docked' || v === 'floating'),
    newTemplate: pick(value.newTemplate, d.newTemplate, v => ['blank', 'ruled', 'grid', 'dotted'].includes(v as string)),
  };
}

type Patch = { [K in keyof Preferences]?: Preferences[K] extends object ? Partial<Preferences[K]> : Preferences[K] };

/** Observable preferences with debounced persistence supplied by the host. */
export class PreferenceStore {
  private listeners = new Set<() => void>();
  private timer?: number;
  constructor(private value: Preferences, private persist: (value: Preferences) => Promise<void> | void = () => {}) {}
  get = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(patch: Patch) {
    const next = { ...this.value };
    const merge = <K extends keyof Preferences>(key: K) => {
      const part = patch[key];
      if (part === undefined) return;
      next[key] = (part && typeof part === 'object' ? { ...this.value[key] as object, ...part } : part) as Preferences[K];
    };
    for (const key of Object.keys(patch) as (keyof Preferences)[]) merge(key);
    this.value = next;
    for (const listener of this.listeners) listener();
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.persist(this.value), 400);
  }
  flush() { if (this.timer) { window.clearTimeout(this.timer); this.timer = undefined; void this.persist(this.value); } }
}
