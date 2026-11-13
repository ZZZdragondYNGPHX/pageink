import type { Page, PageTemplate, Rect } from './model';

export const TEMPLATES: readonly { id: PageTemplate; label: string }[] = [
  { id: 'blank', label: '空白' }, { id: 'ruled', label: '横线' }, { id: 'grid', label: '方格' }, { id: 'dotted', label: '点阵' },
];
export const templateLabel = (template: PageTemplate) => TEMPLATES.find(t => t.id === template)?.label ?? '空白';

export function templateSpec(template: PageTemplate) {
  if (template === 'ruled') return { step: 28, color: '#dce5ef', first: 1 };
  if (template === 'dotted') return { step: 24, color: '#b8c3cf', first: 0, radius: 1.15 };
  return { step: 24, color: '#e0e8f0', first: 0 };
}

/** CSS background for a paper whose top-left corner is the paper rect origin. */
export function paperStyle(template: PageTemplate, miniature = false): Record<string, string> {
  if (template === 'blank' || !TEMPLATES.some(t => t.id === template)) return {};
  const { step: fullStep, color } = templateSpec(template);
  const step = miniature ? 5 : fullStep;
  if (template === 'ruled') return { backgroundImage: `repeating-linear-gradient(transparent 0 ${step - 1}px, ${color} ${step - 1}px ${step}px)` };
  if (template === 'dotted') return { backgroundImage: `radial-gradient(circle at ${step / 2}px ${step / 2}px, ${color} 1.15px, transparent 1.6px)`, backgroundSize: `${step}px ${step}px`, backgroundPosition: `${-step / 2}px ${-step / 2}px` };
  return { backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`, backgroundSize: `${step}px ${step}px` };
}

/** Ruled and grid lines inside `area`, in the same coordinates as `paper`. */
export function* templateLines(template: Page['template'], paper: Rect, area: Rect): Generator<[number, number, number, number]> {
  if (template !== 'ruled' && template !== 'grid') return;
  const { step, first } = templateSpec(template);
  for (let k = Math.max(first, Math.floor((area.y - paper.y) / step)); paper.y + k * step < Math.min(area.y + area.height, paper.y + paper.height); k++) {
    const y = paper.y + k * step + (template === 'ruled' ? -.5 : .5); yield [paper.x, y, paper.x + paper.width, y];
  }
  if (template === 'grid') for (let k = Math.max(0, Math.floor((area.x - paper.x) / step)); paper.x + k * step < Math.min(area.x + area.width, paper.x + paper.width); k++) {
    const x = paper.x + k * step + .5; yield [x, paper.y, x, paper.y + paper.height];
  }
}

/** Dot centres of the dotted template inside `area`. */
export function* templateDots(template: Page['template'], paper: Rect, area: Rect): Generator<[number, number]> {
  if (template !== 'dotted') return;
  const { step } = templateSpec(template);
  const left = Math.max(paper.x, area.x), top = Math.max(paper.y, area.y);
  const right = Math.min(paper.x + paper.width, area.x + area.width), bottom = Math.min(paper.y + paper.height, area.y + area.height);
  for (let y = paper.y + Math.ceil((top - paper.y) / step) * step; y <= bottom; y += step) {
    for (let x = paper.x + Math.ceil((left - paper.x) / step) * step; x <= right; x += step) yield [x, y];
  }
}
