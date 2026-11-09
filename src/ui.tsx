import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InkIcon } from './InkIcon';

/** Floating layers render into the workspace root so they share its theme tokens and bounds. */
export const LayerContext = createContext<HTMLElement | null>(null);

type Align = 'start' | 'center' | 'end';
export function Popover({ anchor, onClose, label, align = 'start', className = '', children, focus = true }: {
  anchor: HTMLElement | null; onClose: () => void; label: string; align?: Align; className?: string; children: React.ReactNode; focus?: boolean;
}) {
  const layer = useContext(LayerContext), ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const place = () => {
      const pop = ref.current; if (!pop || !anchor || !layer) return;
      const a = anchor.getBoundingClientRect(), r = layer.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
      let left = align === 'end' ? a.right - r.left - w : align === 'center' ? a.left + a.width / 2 - r.left - w / 2 : a.left - r.left;
      left = Math.max(8, Math.min(left, r.width - w - 8));
      let top = a.bottom - r.top + 6;
      if (top + h > r.height - 8 && a.top - r.top - h - 6 > 8) top = a.top - r.top - h - 6;
      setPosition({ left, top: Math.max(8, Math.min(top, r.height - h - 8)) });
    };
    place();
    const observer = new ResizeObserver(place); if (ref.current) observer.observe(ref.current); if (layer) observer.observe(layer);
    return () => observer.disconnect();
  }, [anchor, layer, align]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (focus) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], input, button:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true }));
    const down = (event: PointerEvent) => { const target = event.target as Node; if (ref.current?.contains(target) || anchor?.contains(target)) return; close.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close.current(); } };
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true);
      if (focus && previous?.isConnected && ref.current?.contains(document.activeElement)) previous.focus({ preventScroll: true });
    };
  }, [anchor]);
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
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
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

export function Segmented<T extends string | number>({ value, options, onChange, label, className = '' }: {
  value: T; options: readonly { value: T; label: string; icon?: string; title?: string }[]; onChange: (value: T) => void; label: string; className?: string;
}) {
  return <div className={`ink-segmented ${className}`} role="radiogroup" aria-label={label}>{options.map(option =>
    <button key={String(option.value)} type="button" role="radio" aria-checked={option.value === value} title={option.title ?? option.label}
      aria-label={option.icon ? option.title ?? option.label : undefined} onClick={() => onChange(option.value)}>
      {option.icon ? <InkIcon name={option.icon}/> : option.label}
    </button>)}</div>;
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return <label className="ink-switch-row">
    <span><span>{label}</span>{hint && <small>{hint}</small>}</span>
    <input type="checkbox" role="switch" className="ink-switch" checked={checked} onChange={event => onChange(event.target.checked)}/>
  </label>;
}

export function Swatches({ colors, value, onChange, label, custom = true }: { colors: readonly string[]; value: string; onChange: (color: string) => void; label: string; custom?: boolean }) {
  const preset = colors.some(c => c.toLowerCase() === value.toLowerCase());
  return <div className="ink-swatches" role="radiogroup" aria-label={label}>
    {colors.map(color => <button key={color} type="button" role="radio" className="ink-swatch" aria-checked={color.toLowerCase() === value.toLowerCase()} aria-label={`颜色 ${color}`} title={color} onClick={() => onChange(color)}><span style={{ background: color }}/></button>)}
    {custom && <label className="ink-swatch ink-swatch-custom" title="自定义颜色" aria-checked={!preset} role="radio">
      <span style={!preset ? { background: value } : undefined}/>
      <input type="color" aria-label="自定义颜色" value={value} onChange={event => onChange(event.target.value)}/>
    </label>}
  </div>;
}

export interface Toast { id: number; kind: 'info' | 'success' | 'error' | 'progress'; message: string; detail?: string; action?: { label: string; run: () => void }; cancel?: () => void }
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const next = useRef(0);
  const dismiss = useCallback((id: number) => { clearTimeout(timers.current.get(id)); timers.current.delete(id); setToasts(list => list.filter(t => t.id !== id)); }, []);
  const arm = useCallback((toast: Toast) => {
    clearTimeout(timers.current.get(toast.id));
    if (toast.kind === 'info' || toast.kind === 'success') timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), toast.action ? 7000 : 3500));
  }, [dismiss]);
  const show = useCallback((toast: Omit<Toast, 'id'>) => {
    const item = { ...toast, id: ++next.current };
    setToasts(list => [...list.filter(t => !(t.kind === item.kind && t.message === item.message)), item].slice(-4)); arm(item);
    return item.id;
  }, [arm]);
  const update = useCallback((id: number, patch: Partial<Omit<Toast, 'id'>>) => {
    setToasts(list => list.map(t => { if (t.id !== id) return t; const item = { ...t, ...patch }; arm(item); return item; }));
  }, [arm]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  return { toasts, show, update, dismiss };
}
export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return <div className="ink-toasts" aria-live="polite">{toasts.map(toast =>
    <div key={toast.id} className={`ink-toast is-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.kind === 'progress' ? <span className="ink-spinner" aria-hidden="true"/> : <InkIcon name={toast.kind === 'error' ? 'warning' : toast.kind === 'success' ? 'check' : 'more'} className={toast.kind === 'info' ? 'is-hidden' : ''}/>}
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
