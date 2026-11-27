import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InkIcon } from './InkIcon';

/** Floating layers render into the workspace root so they share its theme tokens and bounds. */
export const LayerContext = createContext<HTMLElement | null>(null);

const imeRegistered = new WeakSet<Window>();
const imeEndedAt = new WeakMap<Window, number>();

function ensureImeListener(win: Window | null | undefined): Window | null {
  if (!win) return null;
  if (!imeRegistered.has(win)) {
    imeRegistered.add(win);
    win.addEventListener('compositionend', () => {
      imeEndedAt.set(win, performance.now());
    }, true);
  }
  return win;
}

export function isImeComposing(event: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  const win = ensureImeListener(native.view ?? (typeof window !== 'undefined' ? window : null));
  const legacyKeyCode = (native as { readonly keyCode?: number }).keyCode;
  if (native.isComposing || legacyKeyCode === 229) return true;
  const lastEnd = win ? imeEndedAt.get(win) : undefined;
  return (native.key === 'Enter' || native.key === 'Escape') && lastEnd !== undefined && performance.now() - lastEnd < 35;
}

type Align = 'start' | 'center' | 'end';
export function Popover({ anchor, onClose, label, align = 'start', className = '', children, focus = true }: {
  anchor: HTMLElement | null; onClose: () => void; label: string; align?: Align; className?: string; children: React.ReactNode; focus?: boolean;
}) {
  const layer = useContext(LayerContext), ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const doc = anchor?.ownerDocument ?? layer?.ownerDocument;
    const win = doc?.defaultView;
    const vv = win?.visualViewport;
    const place = () => {
      const pop = ref.current; if (!pop || !anchor || !layer) return;
      const a = anchor.getBoundingClientRect(), r = layer.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
      const visibleTop = vv ? Math.max(0, vv.offsetTop - r.top) : 0;
      const visibleBottom = vv ? Math.min(r.height, vv.offsetTop + vv.height - r.top) : r.height;
      const availableHeight = Math.max(140, Math.floor(visibleBottom - visibleTop - 16));
      const clampedH = Math.min(h, availableHeight);
      let left = align === 'end' ? a.right - r.left - w : align === 'center' ? a.left + a.width / 2 - r.left - w / 2 : a.left - r.left;
      left = Math.max(8, Math.min(left, r.width - w - 8));
      let top = a.bottom - r.top + 6;
      if (top + clampedH > visibleBottom - 8 && a.top - r.top - clampedH - 6 > visibleTop + 8) top = a.top - r.top - clampedH - 6;
      const nextLeft = left + layer.scrollLeft;
      const nextTop = Math.max(visibleTop + 8, Math.min(top, visibleBottom - clampedH - 8)) + layer.scrollTop;
      const nextMaxHeight = vv && visibleBottom - visibleTop < r.height - 1 ? availableHeight : undefined;
      setPosition(prev => prev && prev.left === nextLeft && prev.top === nextTop && prev.maxHeight === nextMaxHeight
        ? prev
        : { left: nextLeft, top: nextTop, ...(nextMaxHeight !== undefined ? { maxHeight: nextMaxHeight } : {}) });
    };
    place();
    const observer = new ResizeObserver(place); if (ref.current) observer.observe(ref.current); if (layer) observer.observe(layer);
    doc?.addEventListener('scroll', place, true);
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      doc?.removeEventListener('scroll', place, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [anchor, layer, align]);
  useLayoutEffect(() => {
    const pop = ref.current, doc = anchor?.ownerDocument ?? layer?.ownerDocument ?? activeDocument, win = doc.defaultView!;
    const resolvePrevious = (): HTMLElement | null => {
      if (anchor?.getAttribute('aria-hidden') === 'true') {
        const more = layer?.closest('.workspace-leaf')?.querySelector<HTMLElement>('.view-header .view-actions > :last-child');
        if (more && more.getClientRects().length > 0) return more;
        return layer;
      }
      return anchor ?? doc.activeElement as HTMLElement | null;
    };
    const previous = resolvePrevious();
    let restoreFocus = true;
    const focusables = () => pop ? [...pop.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length > 0 && el.tabIndex >= 0) : [];
    const frame = focus ? window.requestAnimationFrame(() => pop?.querySelector<HTMLElement>('[data-autofocus], [aria-checked="true"], input:not(:disabled):not([tabindex="-1"]), button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]')?.focus({ preventScroll: true })) : 0;
    const down = (event: PointerEvent) => { const target = event.target as Node; if (pop?.contains(target) || anchor?.contains(target)) return; restoreFocus = false; close.current(); };
    const key = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); if (focus && previous?.isConnected) previous.focus({ preventScroll: true }); close.current(); return; }
      if (event.key === 'Tab' && focus && pop && pop.contains(doc.activeElement)) {
        const items = focusables();
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
      }
    };
    const leave = (event: FocusEvent) => { if (!focus || pop?.contains(event.target as Node) || anchor?.contains(event.target as Node)) return; restoreFocus = false; close.current(); };
    // Escape belongs to the floating layer before the host's document-level shortcuts.
    doc.addEventListener('pointerdown', down, true); win.addEventListener('keydown', key, true); doc.addEventListener('focusin', leave);
    return () => {
      window.cancelAnimationFrame(frame);
      doc.removeEventListener('pointerdown', down, true); win.removeEventListener('keydown', key, true); doc.removeEventListener('focusin', leave);
      if (focus && restoreFocus && previous?.isConnected && (pop?.contains(doc.activeElement) || doc.activeElement === doc.body)) previous.focus({ preventScroll: true });
    };
  }, [anchor, layer, focus]);
  if (!layer) return null;
  return createPortal(<div ref={ref} role="dialog" aria-label={label} className={`ink-popover ${className}`} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>{children}</div>, layer);
}

/** Anchored popover state: `toggle` from a button's click, `close` from inside. */
export function useAnchor<T extends string>() {
  const [state, setState] = useState<{ id: T; anchor: HTMLElement } | null>(null);
  const toggle = useCallback((id: T, anchor: HTMLElement | null) => setState(current => current?.id === id || !anchor ? null : { id, anchor }), []);
  const close = useCallback(() => setState(null), []);
  return { open: state?.id ?? null, anchor: state?.anchor ?? null, toggle, close, set: setState };
}

export type MenuEntry = { icon?: string; label: string; hint?: string; onSelect: () => void; disabled?: boolean; danger?: boolean; checked?: boolean } | 'separator' | { heading: string };
export function Menu({ items, onDone }: { items: readonly (MenuEntry | false | null | undefined)[]; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (event: React.KeyboardEvent) => {
    if (isImeComposing(event) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    const doc = ref.current?.ownerDocument ?? activeDocument;
    const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div ref={ref} className="ink-menu" role="menu" onKeyDown={move}>{items.filter(Boolean).map((item, i) => {
    if (item === 'separator') return <div key={i} className="ink-menu-separator" role="separator"/>;
    if (item && 'heading' in item) return <div key={i} className="ink-menu-heading">{item.heading}</div>;
    const entry = item as Exclude<MenuEntry, 'separator' | { heading: string }>;
    return <button key={i} type="button" role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={entry.checked} disabled={entry.disabled}
      className={`ink-menu-item${entry.danger ? ' is-danger' : ''}`} onClick={() => { onDone(); entry.onSelect(); }}>
      {entry.icon ? <InkIcon name={entry.icon}/> : <span className="ink-icon"/>}
      <span className="ink-menu-label">{entry.label}{entry.hint && <small>{entry.hint}</small>}</span>
      {entry.checked && <InkIcon name="check" className="ink-menu-check"/>}
    </button>;
  })}</div>;
}

/** APG radio groups use one Tab stop and arrow keys for the choices within it. */
export function radioKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (isImeComposing(event) || (event.target as HTMLElement).tagName === 'INPUT' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')];
  if (!buttons.length) return;
  event.preventDefault(); event.stopPropagation();
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus(); buttons[next].click();
}

export function Segmented<T extends string | number>({ value, options, onChange, label, className = '' }: {
  value: T; options: readonly { value: T; label: string; icon?: string; title?: string }[]; onChange: (value: T) => void; label: string; className?: string;
}) {
  return <div className={`ink-segmented ${className}`} role="radiogroup" aria-label={label} onKeyDown={radioKeys}>{options.map(option =>
    <button key={String(option.value)} type="button" role="radio" tabIndex={option.value === value ? 0 : -1} aria-checked={option.value === value} title={option.title ?? option.label}
      aria-label={option.icon ? option.title ?? option.label : undefined} onClick={() => onChange(option.value)}>
      {option.icon ? <InkIcon name={option.icon}/> : option.label}
    </button>)}</div>;
}

export function Switch({ checked, onChange, label, hint, icon }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string; icon?: string }) {
  return <label className="ink-switch-row">
    {icon && <InkIcon name={icon} className="ink-switch-icon"/>}
    <span className="ink-switch-copy"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <span className="ink-switch-control">
      <input type="checkbox" role="switch" aria-label={label} className="ink-switch" checked={checked} onChange={event => onChange(event.target.checked)}/>
      <span className="ink-switch-track" aria-hidden="true"><span className="ink-switch-thumb"/></span>
    </span>
  </label>;
}

export function Swatches({ colors, value, onChange, label, custom = true, allowTransparent = false }: { colors: readonly string[]; value: string; onChange: (color: string) => void; label: string; custom?: boolean; allowTransparent?: boolean }) {
  const isTransparent = allowTransparent && value === 'transparent';
  const preset = isTransparent || colors.some(c => c.toLowerCase() === value.toLowerCase());
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : colors[0] ?? '#fff4cc';
  return <div className="ink-swatches" role="radiogroup" aria-label={label} onKeyDown={radioKeys}>
    {allowTransparent && <button type="button" role="radio" tabIndex={isTransparent || !preset ? 0 : -1} className="ink-swatch is-transparent" aria-checked={isTransparent} aria-label="无填充" title="无填充" onClick={() => onChange('transparent')}><span/></button>}
    {colors.map((color, index) => <button key={color} type="button" role="radio" tabIndex={color.toLowerCase() === value.toLowerCase() || (!allowTransparent && !preset && index === 0) ? 0 : -1} className="ink-swatch" aria-checked={color.toLowerCase() === value.toLowerCase()} aria-label={`颜色 ${color}`} title={color} onClick={() => onChange(color)}><span style={{ background: color }}/></button>)}
    {custom && <label className="ink-swatch ink-swatch-custom" title="自定义颜色" data-selected={!preset}>
      <span style={!preset ? { background: pickerValue } : undefined}/>
      <input type="color" aria-label="自定义颜色" value={pickerValue} onChange={event => onChange(event.target.value)}/>
    </label>}
  </div>;
}

export interface Toast { id: number; kind: 'info' | 'success' | 'error' | 'progress'; message: string; detail?: string; action?: { label: string; run: () => void }; cancel?: () => void }
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());
  const next = useRef(0);
  const dismiss = useCallback((id: number) => { window.clearTimeout(timers.current.get(id)); timers.current.delete(id); setToasts(list => list.filter(t => t.id !== id)); }, []);
  const arm = useCallback((toast: Toast) => {
    window.clearTimeout(timers.current.get(toast.id));
    if (toast.kind === 'info' || toast.kind === 'success') timers.current.set(toast.id, window.setTimeout(() => dismiss(toast.id), toast.action ? 7000 : 3500));
  }, [dismiss]);
  const show = useCallback((toast: Omit<Toast, 'id'>) => {
    const item = { ...toast, id: ++next.current };
    setToasts(list => [...list.filter(t => !(t.kind === item.kind && t.message === item.message)), item].slice(-4)); arm(item);
    return item.id;
  }, [arm]);
  const update = useCallback((id: number, patch: Partial<Omit<Toast, 'id'>>) => {
    setToasts(list => list.map(t => { if (t.id !== id) return t; const item = { ...t, ...patch }; arm(item); return item; }));
  }, [arm]);
  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);
  return { toasts, show, update, dismiss };
}
export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return <div className="ink-toasts" aria-live="polite">{toasts.map(toast =>
    <div key={toast.id} className={`ink-toast is-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.kind === 'progress' ? <span className="ink-spinner" aria-hidden="true"/> : <InkIcon name={toast.kind === 'error' ? 'warning' : toast.kind === 'success' ? 'check' : 'info'}/>}
      <span className="ink-toast-text">{toast.message}{toast.detail && <small>{toast.detail}</small>}</span>
      {toast.action && <button type="button" className="ink-toast-action" onClick={() => { dismiss(toast.id); toast.action!.run(); }}>{toast.action.label}</button>}
      {toast.cancel && <button type="button" className="ink-toast-action" onClick={toast.cancel}>取消</button>}
      {toast.kind !== 'progress' && <button type="button" className="ink-toast-close" aria-label="关闭提示" onClick={() => dismiss(toast.id)}><InkIcon name="close"/></button>}
    </div>)}</div>;
}

/** A UI fault must never blank the note: show what happened and offer a reload (content stays in the session). */
export class ErrorBoundary extends React.Component<{ onReload: () => void; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('PageInk UI error', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="ink-view-error" role="alert">
      <strong>界面出现问题</strong>
      <p>已保存的内容不受影响。重新载入即可继续书写。</p>
      <p className="ink-error-detail">{this.state.error.message}</p>
      <button type="button" className="mod-cta" onClick={this.props.onReload}>重新载入</button>
    </div>;
  }
}
