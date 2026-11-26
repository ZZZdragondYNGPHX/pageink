import React, { useEffect, useRef } from 'react';
import { IconButton, InkIcon } from './InkIcon';
import { Menu, Popover, radioKeys, Segmented, Swatches, Switch, useAnchor } from './ui';
import { ERASER_SIZES, HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS, PenPreset, Preferences, PreferenceStore, SHAPE_FILLS, SHAPE_WIDTHS, ShapeKind, TAPE_COLORS, TEXT_SIZES, ToolId } from './preferences';

interface ToolDef { id: ToolId; icon: string; label: string; key: string }
export const WRITING_TOOLS: ToolDef[] = [
  { id: 'pen', icon: 'pen', label: '笔', key: 'P' },
  { id: 'highlighter', icon: 'highlighter', label: '荧光笔', key: 'M' },
  { id: 'eraser', icon: 'eraser', label: '橡皮擦', key: 'E' },
  { id: 'lasso', icon: 'lasso', label: '圈选', key: 'L' },
  { id: 'select', icon: 'select', label: '选择', key: 'V' },
  { id: 'hand', icon: 'hand', label: '移动', key: 'H' },
];
export const EXTRA_TOOLS: ToolDef[] = [
  { id: 'space', icon: 'space', label: '插空', key: 'K' },
  { id: 'tape', icon: 'tape', label: '胶带', key: 'A' },
];
export const INSERT_TOOLS: ToolDef[] = [
  { id: 'text', icon: 'text', label: '文字', key: 'T' },
  { id: 'shape', icon: 'shape', label: '形状', key: 'S' },
];
export const CAPTURE_TOOL: ToolDef = { id: 'capture', icon: 'capture', label: '摘录', key: 'C' };
export const SHORTCUTS: Record<string, ToolId | 'image'> = { p: 'pen', m: 'highlighter', e: 'eraser', l: 'lasso', v: 'select', k: 'space', a: 'tape', h: 'hand', t: 'text', s: 'shape', c: 'capture', i: 'image' };
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
  const activeExtra = EXTRA_TOOLS.find(t => t.id === tool);
  const visibleWriting = activeExtra ? [...WRITING_TOOLS, activeExtra] : WRITING_TOOLS;
  const button = (t: ToolDef) => <IconButton key={t.id} icon={t.icon} label={t.label} shortcut={t.key} tabIndex={tool === t.id ? 0 : -1} aria-pressed={tool === t.id} className="ink-tool" onClick={event => onTool(t.id, event.currentTarget)}><span>{t.label}</span></IconButton>;
  return <div ref={tools} className="ink-tools" role="toolbar" aria-label="书写工具" onKeyDown={event => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.getClientRects().length), index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <div className="ink-tool-group">{visibleWriting.map(button)}</div>
    <div className="ink-tool-group">{INSERT_TOOLS.map(button)}<IconButton icon="image" label="插入图片" shortcut="I" tabIndex={-1} className="ink-tool" onClick={onImage}><span>图片</span></IconButton>{capture && button(CAPTURE_TOOL)}</div>
  </div>;
}

/** Frequent tools stay in place; the full palette opens from the active tool or its style button. */
export function ToolShelf({ tool, onTool, onImage, capture, prefs, store, onRevealAllTapes }: {
  tool: ToolId; onTool: (tool: ToolId) => void; onImage: () => void; capture: boolean; prefs: Preferences; store: PreferenceStore; onRevealAllTapes?: (revealed: boolean) => void;
}) {
  const pop = useAnchor<'options' | 'tools'>();
  const definition = [...WRITING_TOOLS, ...EXTRA_TOOLS, ...INSERT_TOOLS, CAPTURE_TOOL].find(t => t.id === tool)!;
  const color = tool === 'highlighter' ? prefs.highlighter.color : tool === 'tape' ? prefs.tape.color : tool === 'text' ? prefs.text.color : tool === 'shape' ? prefs.shape.color : prefs.pen.color;
  const colors = tool === 'highlighter' ? HIGHLIGHTER_COLORS : tool === 'tape' ? TAPE_COLORS : PEN_COLORS;
  const colored = ['pen', 'highlighter', 'tape', 'text', 'shape'].includes(tool);
  const usesPenSlots = tool === 'pen' || tool === 'highlighter';
  const configurable = colored || tool === 'eraser' || tool === 'capture' || tool === 'lasso';
  const updateActiveSlot = (kind: 'pen' | 'highlighter', patch: Partial<Pick<PenPreset, 'color' | 'width'>>) => {
    const idx = prefs.activeSlot;
    if (idx < 0 || idx >= prefs.penSlots.length || prefs.penSlots[idx].kind !== kind) return undefined;
    return prefs.penSlots.map((slot, i) => i === idx ? { ...slot, ...patch } : slot);
  };
  const setColor = (value: string) => {
    if (tool === 'pen') { const penSlots = updateActiveSlot('pen', { color: value }); store.update({ pen: { color: value }, ...(penSlots ? { penSlots } : {}) }); }
    if (tool === 'highlighter') { const penSlots = updateActiveSlot('highlighter', { color: value }); store.update({ highlighter: { color: value }, ...(penSlots ? { penSlots } : {}) }); }
    if (tool === 'tape') store.update({ tape: { color: value } });
    if (tool === 'text') store.update({ text: { color: value } });
    if (tool === 'shape') store.update({ shape: { color: value } });
  };
  const setWidth = (kind: 'pen' | 'highlighter', width: number) => {
    const penSlots = updateActiveSlot(kind, { width });
    store.update({ [kind]: { width }, ...(penSlots ? { penSlots } : {}) });
  };
  const selectSlot = (index: number) => {
    const slot = prefs.penSlots[index];
    if (!slot) return;
    store.update({
      activeSlot: index,
      [slot.kind]: { color: slot.color, width: slot.width },
    });
    onTool(slot.kind);
  };
  const detail = tool === 'eraser' ? (prefs.eraser.highlighterOnly ? '仅荧光笔' : prefs.eraser.mode === 'partial' ? '局部擦' : '整笔擦')
    : tool === 'lasso' ? (prefs.lasso.filter === 'ink' ? '仅笔迹' : prefs.lasso.filter === 'highlighter' ? '仅荧光笔' : '全部')
    : tool === 'capture' ? (prefs.capture.shape === 'rect' ? '矩形' : '自由')
    : tool === 'text' ? `${prefs.text.size}` : tool === 'pen' ? `${prefs.pen.width}` : tool === 'highlighter' ? `${prefs.highlighter.width}` : `${prefs.shape.width}`;
  const showTriggerLabel = tool === 'eraser' || tool === 'capture';
  return <div className="ink-tool-shelf">
    <ToolButtons tool={tool} onTool={(next, anchor) => {
      if (tool === next && configurable) pop.toggle('options', anchor);
      else { pop.close(); onTool(next); }
    }} onImage={() => { pop.close(); onImage(); }} capture={capture}/>
    <IconButton icon="more" label="更多工具" className="ink-tools-more" aria-expanded={pop.open === 'tools'} onClick={event => pop.toggle('tools', event.currentTarget)}/>
    {pop.open === 'tools' && <Popover anchor={pop.anchor} onClose={pop.close} label="全部工具" align="end">
      <Menu onDone={pop.close} items={[
        ...[...WRITING_TOOLS, ...EXTRA_TOOLS, ...INSERT_TOOLS, ...(capture ? [CAPTURE_TOOL] : [])].map(t => ({ icon: t.icon, label: t.label, checked: tool === t.id, onSelect: () => onTool(t.id) })),
        { icon: 'image', label: '插入图片', onSelect: onImage },
      ]}/>
    </Popover>}
    {configurable && <div className="ink-quick-style" role="group" aria-label={`${definition.label}快捷设置`}>
      {usesPenSlots && (() => {
        const hasCheckedSlot = prefs.activeSlot >= 0 && prefs.penSlots[prefs.activeSlot]?.kind === tool;
        return <div className="ink-pen-slots" role="radiogroup" aria-label="常用笔袋" onKeyDown={radioKeys}>
          {prefs.penSlots.map((slot, index) => {
            const active = index === prefs.activeSlot && tool === slot.kind;
            return <button key={slot.id} type="button" role="radio" tabIndex={active || (!hasCheckedSlot && index === 0) ? 0 : -1} aria-checked={active}
              className={`ink-pen-slot${slot.kind === 'highlighter' ? ' is-highlighter' : ''}`}
              title={`${slot.kind === 'highlighter' ? '荧光笔' : '笔'} · ${slot.width}px`} aria-label={`笔袋 ${index + 1}：${slot.kind === 'highlighter' ? '荧光笔' : '笔'} ${slot.width}px`}
              onClick={() => selectSlot(index)}>
              <span className="ink-pen-slot-dot" style={{ background: slot.color, width: Math.min(18, 7 + slot.width * 2.2), height: Math.min(18, 7 + slot.width * 2.2) }}/>
              <span className="ink-pen-slot-badge" aria-hidden="true"><InkIcon name={slot.kind === 'highlighter' ? 'highlighter' : 'pen'}/></span>
            </button>;
          })}
        </div>;
      })()}
      <button type="button" className={`ink-style-trigger${showTriggerLabel ? ' has-label' : ''}`} aria-label={`${definition.label}设置`} aria-expanded={pop.open === 'options'} onClick={event => pop.toggle('options', event.currentTarget)}>
        {colored ? <span className="ink-style-dot" style={{ background: color }} aria-hidden="true"/> : <InkIcon name={definition.icon}/>}
        {showTriggerLabel && <span className="ink-style-label">{detail}</span>}
        <InkIcon name="down"/>
      </button>
      {tool === 'pen' && <Widths values={PEN_WIDTHS.slice(0, 3)} value={prefs.pen.width} color="var(--ink-text)" onChange={width => setWidth('pen', width)} label="快捷粗细"/>}
      {tool === 'highlighter' && <Widths values={HIGHLIGHTER_WIDTHS} value={prefs.highlighter.width} color="var(--ink-text)" onChange={width => setWidth('highlighter', width)} label="快捷粗细"/>}
      {tool === 'shape' && <Widths values={SHAPE_WIDTHS} value={prefs.shape.width} color="var(--ink-text)" onChange={width => store.update({ shape: { width } })} label="快捷线宽"/>}
      {tool === 'eraser' && <><EraserSizes prefs={prefs} store={store}/><IconButton icon="highlighter" label={prefs.eraser.highlighterOnly ? '仅擦荧光笔已开启' : '仅擦荧光笔'} aria-pressed={prefs.eraser.highlighterOnly} className="ink-toggle-icon" onClick={() => store.update({ eraser: { highlighterOnly: !prefs.eraser.highlighterOnly } })}/><IconButton icon="autoReturn" label={prefs.eraser.autoReturn ? '擦完自动回笔已开启' : '擦完自动回笔'} aria-pressed={prefs.eraser.autoReturn} className="ink-toggle-icon" onClick={() => store.update({ eraser: { autoReturn: !prefs.eraser.autoReturn } })}/></>}
      {tool === 'lasso' && <Segmented label="圈选范围" value={prefs.lasso.filter} onChange={filter => store.update({ lasso: { filter } })} options={[{ value: 'all', label: '全部' }, { value: 'ink', label: '笔迹' }, { value: 'highlighter', label: '荧光笔' }]}/>}
      {tool === 'tape' && onRevealAllTapes && <><IconButton icon="eye" label="揭开当前页所有胶带" className="ink-toggle-icon" onClick={() => onRevealAllTapes(true)}/><IconButton icon="eyeOff" label="重新遮盖当前页所有胶带" className="ink-toggle-icon" onClick={() => onRevealAllTapes(false)}/></>}
      {colored && !usesPenSlots && <div className="ink-quick-colors"><Swatches colors={colors.slice(0, 4)} value={color} onChange={setColor} label="常用颜色" custom={false}/></div>}
    </div>}
    {pop.open === 'options' && <Popover anchor={pop.anchor} onClose={pop.close} label={`${definition.label}设置`} align="end" className="ink-tool-popover">
      <div className="ink-popover-title">{definition.label}</div>
      <div className="ink-options" role="group" aria-label="工具选项"><ToolOptions tool={tool} prefs={prefs} store={store} onRevealAllTapes={onRevealAllTapes}/></div>
    </Popover>}
  </div>;
}

function Widths({ values, value, color, onChange, scale = 1, label }: { values: readonly number[]; value: number; color: string; onChange: (width: number) => void; scale?: number; label: string }) {
  return <div className="ink-widths" role="radiogroup" aria-label={label} onKeyDown={radioKeys}>{values.map((width, index) =>
    <button key={width} type="button" role="radio" tabIndex={width === value || !values.includes(value) && index === 0 ? 0 : -1} aria-checked={width === value} aria-label={`${label} ${width}`} title={`${label} ${width}`} onClick={() => onChange(width)}>
      <span style={{ width: Math.min(20, 6 + width * 3.2 * scale), height: Math.max(3, Math.min(12, 2 + width * 2.1 * scale)), background: color }}/>
    </button>)}</div>;
}

/** Full options for the active tool, opened from its button or contextual settings. */
export function ToolOptions({ tool, prefs, store, onRevealAllTapes }: { tool: ToolId; prefs: Preferences; store: PreferenceStore; onRevealAllTapes?: (revealed: boolean) => void }) {
  const divider = <span className="ink-divider" aria-hidden="true"/>;
  const syncSlot = (kind: 'pen' | 'highlighter', patch: Partial<Pick<PenPreset, 'color' | 'width'>>) => {
    const idx = prefs.activeSlot;
    if (idx < 0 || idx >= prefs.penSlots.length || prefs.penSlots[idx].kind !== kind) return undefined;
    return prefs.penSlots.map((slot, i) => i === idx ? { ...slot, ...patch } : slot);
  };
  const addSlot = (kind: 'pen' | 'highlighter') => {
    if (prefs.penSlots.length >= 6) return;
    const current = kind === 'pen' ? prefs.pen : prefs.highlighter;
    const next: PenPreset[] = [...prefs.penSlots, { id: `slot-${Date.now()}`, kind, color: current.color, width: current.width }];
    store.update({ penSlots: next, activeSlot: next.length - 1 });
  };
  const removeSlot = () => {
    if (prefs.penSlots.length <= 1 || prefs.activeSlot < 0) return;
    const next = prefs.penSlots.filter((_, i) => i !== prefs.activeSlot);
    const nextIndex = Math.min(prefs.activeSlot, next.length - 1);
    const target = next[nextIndex];
    if (target.kind === tool) {
      store.update({ penSlots: next, activeSlot: nextIndex, [target.kind]: { color: target.color, width: target.width } });
    } else {
      store.update({ penSlots: next, activeSlot: -1 });
    }
  };
  switch (tool) {
    case 'pen': return <>
      <Swatches colors={PEN_COLORS} value={prefs.pen.color} onChange={color => { const penSlots = syncSlot('pen', { color }); store.update({ pen: { color }, ...(penSlots ? { penSlots } : {}) }); }} label="笔颜色"/>{divider}
      <Widths values={PEN_WIDTHS} value={prefs.pen.width} color="var(--ink-text)" onChange={width => { const penSlots = syncSlot('pen', { width }); store.update({ pen: { width }, ...(penSlots ? { penSlots } : {}) }); }} label="粗细"/>{divider}
      <IconButton icon="pressure" label={prefs.pen.pressure ? '压感已开启' : '压感已关闭（等宽）'} aria-pressed={prefs.pen.pressure} className="ink-toggle" onClick={() => store.update({ pen: { pressure: !prefs.pen.pressure } })}><span>压感</span></IconButton>
      <div className="ink-option-row"><span>笔迹防抖</span><Segmented label="笔迹防抖" value={prefs.pen.stabilize} onChange={stabilize => store.update({ pen: { stabilize } })} options={[{ value: 0, label: '关' }, { value: 1, label: '轻' }, { value: 2, label: '中' }]}/></div>
      <div className="ink-slot-manage">
        <button type="button" disabled={prefs.penSlots.length >= 6} onClick={() => addSlot('pen')}><InkIcon name="plus"/>存入笔袋 ({prefs.penSlots.length}/6)</button>
        {prefs.penSlots.length > 1 && prefs.activeSlot >= 0 && prefs.penSlots[prefs.activeSlot]?.kind === 'pen' && <button type="button" onClick={removeSlot}><InkIcon name="trash"/>移除当前槽</button>}
      </div>
      {divider}
      <Switch label="画圈长按套索" hint="画闭合圈后长按该笔划（或圈住内容停顿），直接无边选中" checked={prefs.pen.circleLasso} onChange={circleLasso => store.update({ pen: { circleLasso } })}/>
      <Switch label="一笔成形" hint="画直线、箭头、圆、矩形或菱形末尾停顿，自动规整" checked={prefs.pen.holdToShape} onChange={holdToShape => store.update({ pen: { holdToShape } })}/>
      <Switch label="涂划擦除" hint="来回快速涂划即可清除涂划范围内的全部笔迹" checked={prefs.pen.scribble} onChange={scribble => store.update({ pen: { scribble } })}/>
    </>;
    case 'highlighter': return <>
      <Swatches colors={HIGHLIGHTER_COLORS} value={prefs.highlighter.color} onChange={color => { const penSlots = syncSlot('highlighter', { color }); store.update({ highlighter: { color }, ...(penSlots ? { penSlots } : {}) }); }} label="荧光笔颜色"/>{divider}
      <Widths values={HIGHLIGHTER_WIDTHS} value={prefs.highlighter.width} color="var(--ink-text)" onChange={width => { const penSlots = syncSlot('highlighter', { width }); store.update({ highlighter: { width }, ...(penSlots ? { penSlots } : {}) }); }} label="粗细"/>{divider}
      <div className="ink-slot-manage">
        <button type="button" disabled={prefs.penSlots.length >= 6} onClick={() => addSlot('highlighter')}><InkIcon name="plus"/>存入笔袋 ({prefs.penSlots.length}/6)</button>
        {prefs.penSlots.length > 1 && prefs.activeSlot >= 0 && prefs.penSlots[prefs.activeSlot]?.kind === 'highlighter' && <button type="button" onClick={removeSlot}><InkIcon name="trash"/>移除当前槽</button>}
      </div>
      <span className="ink-hint">采用正片叠底不遮黑字；划线末尾停顿可自动拉直</span>
    </>;
    case 'eraser': return <>
      <Segmented label="擦除方式" value={prefs.eraser.mode} onChange={mode => store.update({ eraser: { mode } })} options={[{ value: 'partial', label: '局部擦除' }, { value: 'stroke', label: '整笔擦除' }]}/>{divider}
      <EraserSizes prefs={prefs} store={store}/>{divider}
      <Switch label="仅擦除荧光笔" hint="擦除高亮时保护普通手写笔迹" checked={prefs.eraser.highlighterOnly} onChange={highlighterOnly => store.update({ eraser: { highlighterOnly } })}/>
      <Switch label="擦完自动回笔" hint="抬手后自动切回上一支书写工具，防止误擦" checked={prefs.eraser.autoReturn} onChange={autoReturn => store.update({ eraser: { autoReturn } })}/>
    </>;
    case 'shape': return <>
      <Segmented label="形状" value={prefs.shape.kind} onChange={kind => store.update({ shape: { kind } })} options={SHAPES}/>{divider}
      <Swatches colors={PEN_COLORS} value={prefs.shape.color} onChange={color => store.update({ shape: { color } })} label="形状颜色"/>{divider}
      <Widths values={SHAPE_WIDTHS} value={prefs.shape.width} color="var(--ink-text)" onChange={width => store.update({ shape: { width } })} label="线宽"/>{divider}
      <div className="ink-option-row"><span>线型</span><Segmented label="线型" value={prefs.shape.strokeStyle} onChange={strokeStyle => store.update({ shape: { strokeStyle } })} options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]}/></div>
      {['rectangle', 'ellipse', 'diamond'].includes(prefs.shape.kind) && <div className="ink-option-row"><span>填充</span><Swatches colors={SHAPE_FILLS} value={prefs.shape.fillColor} allowTransparent onChange={fillColor => store.update({ shape: { fillColor } })} label="形状填充"/></div>}
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
    case 'lasso': return <>
      <Segmented label="圈选范围" value={prefs.lasso.filter} onChange={filter => store.update({ lasso: { filter } })} options={[{ value: 'all', label: '全部对象' }, { value: 'ink', label: '仅笔迹' }, { value: 'highlighter', label: '仅荧光笔' }]}/>{divider}
      <span className="ink-hint">圈住内容即可无边选中，拖动选区可统一操作</span>
    </>;
    case 'tape': return <>
      <Swatches colors={TAPE_COLORS} value={prefs.tape.color} onChange={color => store.update({ tape: { color } })} label="胶带颜色"/>{divider}
      <div className="ink-option-row"><span>胶带高度</span><Segmented label="胶带高度" value={prefs.tape.height} onChange={height => store.update({ tape: { height } })} options={[{ value: 22, label: '细' }, { value: 28, label: '中' }, { value: 40, label: '宽' }]}/></div>
      {onRevealAllTapes && <div className="ink-slot-manage">
        <button type="button" onClick={() => onRevealAllTapes(true)}><InkIcon name="eye"/>全部揭开</button>
        <button type="button" onClick={() => onRevealAllTapes(false)}><InkIcon name="eyeOff"/>全部遮盖</button>
      </div>}
      <span className="ink-hint">拖动盖住答案或公式，轻点胶带即可揭开/遮盖自测</span>
    </>;
    case 'select': return <span className="ink-hint">点选或拖框选择对象，双击文字可编辑</span>;
    case 'space': return <span className="ink-hint">在页面任意处向下拖插入空白，向上拖收起空隙</span>;
    case 'hand': return <span className="ink-hint">拖动以移动画面</span>;
  }
}

function EraserSizes({ prefs, store }: { prefs: Preferences; store: PreferenceStore }) {
  return <div className="ink-widths" role="radiogroup" aria-label="橡皮大小" onKeyDown={radioKeys}>{ERASER_SIZES.map(s => <button key={s.size} type="button" role="radio" tabIndex={prefs.eraser.size === s.size ? 0 : -1} aria-checked={prefs.eraser.size === s.size} title={`橡皮${s.label}`} aria-label={`橡皮${s.label}`} onClick={() => store.update({ eraser: { size: s.size } })}><span className="is-ring" style={{ width: 6 + s.size * 0.6, height: 6 + s.size * 0.6 }}/></button>)}</div>;
}
