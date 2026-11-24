import React, { useMemo } from 'react';
import type { Element } from './model';
import { IconButton, InkIcon } from './InkIcon';
import { LayerOrderAction, summarizeLayers } from './layers';

const KIND_ICON: Record<'group' | 'ink' | 'shape' | 'text' | 'image', string> = {
  group: 'group',
  ink: 'pen',
  shape: 'shape',
  text: 'text',
  image: 'image',
};

export function LayersPanel({
  elements,
  pageLabel,
  selectedIds,
  canGroup,
  grouped,
  locked,
  readOnly,
  onSelect,
  onOrder,
  onGroup,
  onUngroup,
  onLock,
  onUnlockAll,
}: {
  elements: readonly Element[];
  pageLabel?: string;
  selectedIds: readonly string[];
  canGroup: boolean;
  grouped: boolean;
  locked: boolean;
  readOnly?: boolean;
  onSelect: (ids: readonly string[]) => void;
  onOrder: (ids: readonly string[], action: LayerOrderAction) => void;
  onGroup: (ids: readonly string[]) => void;
  onUngroup: (ids: readonly string[]) => void;
  onLock: (ids: readonly string[], nextLocked: boolean) => void;
  onUnlockAll: () => void;
}) {
  const items = useMemo(() => summarizeLayers(elements), [elements]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const lockedCount = useMemo(() => elements.filter(e => !e.isDeleted && e.locked).length, [elements]);

  return <div className="ink-layers-panel">
    <div className="ink-layers-head">
      <div className="ink-popover-title">{pageLabel ? `图层与编组 · ${pageLabel}` : '图层与编组'}</div>
      {lockedCount > 0 && !readOnly && <button type="button" className="ink-layers-unlock-all" onClick={onUnlockAll}>全部解锁 ({lockedCount})</button>}
    </div>
    {selectedIds.length > 0 && !readOnly && <div className="ink-layers-selection">
      <span className="ink-layers-selection-title">当前选中 {selectedIds.length} 项</span>
      <div className="ink-layers-actions">
        <IconButton icon="bringFront" label="置于顶层" onClick={() => onOrder(selectedIds, 'front')}/>
        <IconButton icon="moveUp" label="上移一层" onClick={() => onOrder(selectedIds, 'forward')}/>
        <IconButton icon="moveDown" label="下移一层" onClick={() => onOrder(selectedIds, 'backward')}/>
        <IconButton icon="sendBack" label="置于底层" onClick={() => onOrder(selectedIds, 'back')}/>
        <span className="ink-divider" aria-hidden="true"/>
        {canGroup && <IconButton icon="group" label="组合所选" shortcut="Ctrl+G" onClick={() => onGroup(selectedIds)}/>}
        {grouped && <IconButton icon="ungroup" label="拆分组合" shortcut="Ctrl+Shift+G" onClick={() => onUngroup(selectedIds)}/>}
        <IconButton icon={locked ? 'unlock' : 'lock'} label={locked ? '解锁' : '锁定'} shortcut="Ctrl+Shift+L" onClick={() => onLock(selectedIds, !locked)}/>
      </div>
    </div>}
    {!items.length ? <p className="ink-mixed-empty">当前页面还没有内容。书写或添加对象后，可在这里调整层级、组合或锁定。</p>
      : <ol className="ink-layers-list" aria-label="对象层级（从顶层到底层）">{items.map((item, idx) => {
        const active = item.ids.some(id => selectedSet.has(id));
        const atTop = idx === 0, atBottom = idx === items.length - 1;
        return <li key={item.key} className={`ink-layer-row${active ? ' is-selected' : ''}${item.locked ? ' is-locked' : ''}`}>
          <button type="button" className="ink-layer-select" onClick={() => onSelect(item.ids)}>
            <InkIcon name={KIND_ICON[item.kind]}/>
            {item.color && <span className="ink-layer-dot" style={{ background: item.color }} aria-hidden="true"/>}
            <span className="ink-layer-label">{item.label}</span>
          </button>
          {!readOnly && <div className="ink-layer-row-actions">
            <IconButton icon="bringFront" label="置顶" disabled={atTop} onClick={() => onOrder(item.ids, 'front')}/>
            <IconButton icon="moveUp" label="上移一层" disabled={atTop} onClick={() => onOrder(item.ids, 'forward')}/>
            <IconButton icon="moveDown" label="下移一层" disabled={atBottom} onClick={() => onOrder(item.ids, 'backward')}/>
            <IconButton icon="sendBack" label="置底" disabled={atBottom} onClick={() => onOrder(item.ids, 'back')}/>
            {item.kind === 'group' && <IconButton icon="ungroup" label="拆分组合" onClick={() => onUngroup(item.ids)}/>}
            {item.kind === 'ink' && item.count > 1 && <IconButton icon="group" label="组合这些笔迹" onClick={() => onGroup(item.ids)}/>}
            <IconButton icon={item.locked ? 'unlock' : 'lock'} label={item.locked ? '解锁' : '锁定'} onClick={() => onLock(item.ids, !item.locked)}/>
          </div>}
        </li>;
      })}</ol>}
    <p className="ink-popover-note">上方为顶层，下方为底层。锁定底图或形状后，书写和擦除不会误触。</p>
  </div>;
}
