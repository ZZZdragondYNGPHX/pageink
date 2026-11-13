import React, { useEffect, useRef } from 'react';
import { IconButton, InkIcon } from './InkIcon';
import { Menu, Popover, radioKeys, Segmented, Swatches, useAnchor } from './ui';
import { ERASER_SIZES, HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS, Preferences, PreferenceStore, SHAPE_WIDTHS, ShapeKind, TEXT_SIZES, ToolId } from './preferences';

interface ToolDef { id: ToolId; icon: string; label: string; key: string }
export const WRITING_TOOLS: ToolDef[] = [
  { id: 'pen', icon: 'pen', label: '笔', key: 'P' },
  { id: 'highlighter', icon: 'highlighter', label: '荧光笔', key: 'M' },
  { id: 'eraser', icon: 'eraser', label: '橡皮擦', key: 'E' },
  { id: 'lasso', icon: 'lasso', label: '圈选', key: 'L' },
  { id: 'select', icon: 'select', label: '选择', key: 'V' },
  { id: 'hand', icon: 'hand', label: '移动', key: 'H' },
];
export const INSERT_TOOLS: ToolDef[] = [
  { id: 'text', icon: 'text', label: '文字', key: 'T' },
  { id: 'shape', icon: 'shape', label: '形状', key: 'S' },
];
export const CAPTURE_TOOL: ToolDef = { id: 'capture', icon: 'capture', label: '摘录', key: 'C' };
export const SHORTCUTS: Record<string, ToolId | 'image'> = { p: 'pen', m: 'highlighter', e: 'eraser', l: 'lasso', v: 'select', h: 'hand', t: 'text', s: 'shape', c: 'capture', i: 'image' };
const SHAPES: { value: ShapeKind; label: string; icon: string }[] = [
  { value: 'rectangle', label: '矩形', icon: 'rectangle' }, { value: 'ellipse', label: '椭圆', icon: 'ellipse' }, { value: 'diamond', label: '菱形', icon: 'diamond' },
  { value: 'line', label: '直线', icon: 'line' }, { value: 'arrow', label: '箭头', icon: 'arrow' },
];

export function ToolButtons({ tool, onTool, onImage, capture }: { tool: ToolId; onTool: (tool: ToolId, anchor: HTMLElement) => void; onImage: () => void; capture: boolean }) {
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = tools.current;
    if (!element) return;
    const reveal = () => element.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    const observer = new ResizeObserver(reveal); observer.observe(element);
    return () => observer.disconnect();
  }, [tool]);
  const button = (t: ToolDef) => <IconButton key={t.id} icon={t.icon} label={t.label} shortcut={t.key} tabIndex={tool === t.id ? 0 : -1} aria-pressed={tool === t.id} className="ink-tool" onClick={event => onTool(t.id, event.currentTarget)}><span>{t.label}</span></IconButton>;
  return <div ref={tools} className="ink-tools" role="toolbar" aria-label="书写工具" onKeyDown={event => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.getClientRects().length), index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <div className="ink-tool-group">{WRITING_TOOLS.map(button)}</div>
    <div className="ink-tool-group">{INSERT_TOOLS.map(button)}<IconButton icon="image" label="插入图片" shortcut="I" tabIndex={-1} className="ink-tool" onClick={onImage}><span>图片</span></IconButton>{capture && button(CAPTURE_TOOL)}</div>
  </div>;
}

/** Frequent tools stay in place; the full palette opens from the active tool or its style button. */
export function ToolShelf({ tool, onTool, onImage, capture, prefs, store }: {
  tool: ToolId; onTool: (tool: ToolId) => void; onImage: () => void; capture: boolean; prefs: Preferences; store: PreferenceStore;
}) {
  const pop = useAnchor<'options' | 'tools'>();
  const definition = [...WRITING_TOOLS, ...INSERT_TOOLS, CAPTURE_TOOL].find(t => t.id === tool)!;
  const color = tool === 'highlighter' ? prefs.highlighter.color : tool === 'text' ? prefs.text.color : tool === 'shape' ? prefs.shape.color : prefs.pen.color;
  const colors = tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const colored = ['pen', 'highlighter', 'text', 'shape'].includes(tool);
  const configurable = colored || tool === 'eraser' || tool === 'capture';
  const setColor = (value: string) => {
    if (tool === 'pen') store.update({ pen: { color: value } });
    if (tool === 'highlighter') store.update({ highlighter: { color: value } });
    if (tool === 'text') store.update({ text: { color: value } });
    if (tool === 'shape') store.update({ shape: { color: value } });
  };
  const detail = tool === 'eraser' ? prefs.eraser.mode === 'partial' ? '局部擦除' : '整笔擦除'
    : tool === 'capture' ? prefs.capture.shape === 'rect' ? '矩形' : '自由形状'
    : tool === 'text' ? `${prefs.text.size}` : tool === 'pen' ? `${prefs.pen.width}` : tool === 'highlighter' ? `${prefs.highlighter.width}` : `${prefs.shape.width}`;
  return <div className="ink-tool-shelf">
    <ToolButtons tool={tool} onTool={(next, anchor) => {
      if (tool === next && configurable) pop.toggle('options', anchor);
      else { pop.close(); onTool(next); }
    }} onImage={() => { pop.close(); onImage(); }} capture={capture}/>
    <IconButton icon="more" label="更多工具" className="ink-tools-more" aria-expanded={pop.open === 'tools'} onClick={event => pop.toggle('tools', event.currentTarget)}/>
    {pop.open === 'tools' && <Popover anchor={pop.anchor} onClose={pop.close} label="全部工具" align="end">
      <Menu onDone={pop.close} items={[
        ...[...WRITING_TOOLS, ...INSERT_TOOLS, ...(capture ? [CAPTURE_TOOL] : [])].map(t => ({ icon: t.icon, label: t.label, checked: tool === t.id, onSelect: () => onTool(t.id) })),
        { icon: 'image', label: '插入图片', onSelect: onImage },
      ]}/>
    </Popover>}
    {configurable && <div className="ink-quick-style" role="group" aria-label={`${definition.label}快捷设置`}>
      <button type="button" className="ink-style-trigger" aria-label={`${definition.label}设置`} aria-expanded={pop.open === 'options'} onClick={event => pop.toggle('options', event.currentTarget)}>
        {colored ? <span className="ink-style-dot" style={{ background: color }} aria-hidden="true"/> : <InkIcon name={definition.icon}/>}<span>{tool === 'eraser' || tool === 'capture' ? detail : definition.label}</span><InkIcon name="down"/>
      </button>
      {tool === 'pen' && <Widths values={PEN_WIDTHS.slice(0, 3)} value={prefs.pen.width} color="var(--ink-text)" onChange={width => store.update({ pen: { width } })} label="快捷粗细"/>}
      {tool === 'highlighter' && <Widths values={HIGHLIGHTER_WIDTHS} value={prefs.highlighter.width} color="var(--ink-text)" onChange={width => store.update({ highlighter: { width } })} label="快捷粗细"/>}
      {tool === 'shape' && <Widths values={SHAPE_WIDTHS} value={prefs.shape.width} color="var(--ink-text)" onChange={width => store.update({ shape: { width } })} label="快捷线宽"/>}
      {tool === 'eraser' && <EraserSizes prefs={prefs} store={store}/>}
      {colored && <div className="ink-quick-colors"><Swatches colors={colors.slice(0, 4)} value={color} onChange={setColor} label="常用颜色" custom={false}/></div>}
    </div>}
    {pop.open === 'options' && <Popover anchor={pop.anchor} onClose={pop.close} label={`${definition.label}设置`} align="end" className="ink-tool-popover">
      <div className="ink-popover-title">{definition.label}</div>
      <div className="ink-options" role="group" aria-label="工具选项"><ToolOptions tool={tool} prefs={prefs} store={store}/></div>
    </Popover>}
  </div>;
}

function Widths({ values, value, color, onChange, scale = 1, label }: { values: readonly number[]; value: number; color: string; onChange: (width: number) => void; scale?: number; label: string }) {
  return <div className="ink-widths" role="radiogroup" aria-label={label} onKeyDown={radioKeys}>{values.map((width, index) =>
    <button key={width} type="button" role="radio" tabIndex={width === value || !values.includes(value) && index === 0 ? 0 : -1} aria-checked={width === value} aria-label={`${label} ${width}`} title={`${label} ${width}`} onClick={() => onChange(width)}>
      <span style={{ width: Math.min(22, 4 + width * 3 * scale), height: Math.max(2, Math.min(14, width * 2.4 * scale)), background: color }}/>
    </button>)}</div>;
}

/** Full options for the active tool, opened from its button or contextual settings. */
export function ToolOptions({ tool, prefs, store }: { tool: ToolId; prefs: Preferences; store: PreferenceStore }) {
  const divider = <span className="ink-divider" aria-hidden="true"/>;
  switch (tool) {
    case 'pen': return <>
      <Swatches colors={PEN_COLORS} value={prefs.pen.color} onChange={color => store.update({ pen: { color } })} label="笔颜色"/>{divider}
      <Widths values={PEN_WIDTHS} value={prefs.pen.width} color="var(--ink-text)" onChange={width => store.update({ pen: { width } })} label="粗细"/>{divider}
      <IconButton icon="pressure" label={prefs.pen.pressure ? '压感已开启' : '压感已关闭（等宽）'} aria-pressed={prefs.pen.pressure} className="ink-toggle" onClick={() => store.update({ pen: { pressure: !prefs.pen.pressure } })}><span>压感</span></IconButton>
      {divider}<label className="ink-option-switch"><span><strong>涂划擦除</strong><small>在笔迹上快速来回涂划，即可擦除</small></span><input type="checkbox" role="switch" aria-label="涂划擦除" checked={prefs.pen.scribble} onChange={event => store.update({ pen: { scribble: event.target.checked } })}/></label>
    </>;
    case 'highlighter': return <>
      <Swatches colors={HIGHLIGHTER_COLORS} value={prefs.highlighter.color} onChange={color => store.update({ highlighter: { color } })} label="荧光笔颜色"/>{divider}
      <Widths values={HIGHLIGHTER_WIDTHS} value={prefs.highlighter.width} color="var(--ink-text)" onChange={width => store.update({ highlighter: { width } })} label="粗细"/>
    </>;
    case 'eraser': return <>
      <Segmented label="擦除方式" value={prefs.eraser.mode} onChange={mode => store.update({ eraser: { mode } })} options={[{ value: 'partial', label: '局部擦除' }, { value: 'stroke', label: '整笔擦除' }]}/>{divider}
      <EraserSizes prefs={prefs} store={store}/>
    </>;
    case 'shape': return <>
      <Segmented label="形状" value={prefs.shape.kind} onChange={kind => store.update({ shape: { kind } })} options={SHAPES}/>{divider}
      <Swatches colors={PEN_COLORS} value={prefs.shape.color} onChange={color => store.update({ shape: { color } })} label="形状颜色"/>{divider}
      <Widths values={SHAPE_WIDTHS} value={prefs.shape.width} color="var(--ink-text)" onChange={width => store.update({ shape: { width } })} label="线宽"/>
    </>;
    case 'text': return <>
      <Swatches colors={PEN_COLORS} value={prefs.text.color} onChange={color => store.update({ text: { color } })} label="文字颜色"/>{divider}
      <Segmented label="字号" value={prefs.text.size} onChange={size => store.update({ text: { size } })} options={TEXT_SIZES.map(t => ({ value: t.size, label: t.label }))}/>
    </>;
    case 'capture': return <>
      <Segmented label="摘录方式" value={prefs.capture.shape} onChange={shape => store.update({ capture: { shape } })} options={[{ value: 'rect', label: '矩形' }, { value: 'lasso', label: '自由形状' }]}/>{divider}
      <IconButton icon="pen" label={prefs.capture.annotations ? '摘录时包含笔迹' : '只摘录原文'} aria-pressed={prefs.capture.annotations} className="ink-toggle" onClick={() => store.update({ capture: { annotations: !prefs.capture.annotations } })}><span>含笔迹</span></IconButton>
      <span className="ink-hint">框选 PDF 内容，自动放入草稿纸</span>
    </>;
    case 'lasso': return <span className="ink-hint">圈住内容即可选中，拖动选区可移动</span>;
    case 'select': return <span className="ink-hint">点选或拖框选择对象，双击文字可编辑</span>;
    case 'hand': return <span className="ink-hint">拖动以移动画面</span>;
  }
}

function EraserSizes({ prefs, store }: { prefs: Preferences; store: PreferenceStore }) {
  return <div className="ink-widths" role="radiogroup" aria-label="橡皮大小" onKeyDown={radioKeys}>{ERASER_SIZES.map(s => <button key={s.size} type="button" role="radio" tabIndex={prefs.eraser.size === s.size ? 0 : -1} aria-checked={prefs.eraser.size === s.size} title={`橡皮${s.label}`} aria-label={`橡皮${s.label}`} onClick={() => store.update({ eraser: { size: s.size } })}><span className="is-ring" style={{ width: 6 + s.size * 0.6, height: 6 + s.size * 0.6 }}/></button>)}</div>;
}
