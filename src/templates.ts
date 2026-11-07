import type { Page, Rect } from './model';
export const templateSpec = (template: Page['template']) => template === 'ruled' ? { step: 28, color: '#dce5ef', first: 1 } : { step: 24, color: '#e0e8f0', first: 0 };
export function paperStyle(template: Page['template']) {
  if (template === 'blank') return {};
  const {step,color}=templateSpec(template);
  return template === 'ruled' ? {backgroundImage:`repeating-linear-gradient(transparent 0 ${step-1}px, ${color} ${step-1}px ${step}px)`} : {backgroundImage:`linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,backgroundSize:`${step}px ${step}px`};
}
export function* templateLines(template: Page['template'], paper: Rect, area: Rect): Generator<[number,number,number,number]> {
  if (template === 'blank') return;
  const {step,first}=templateSpec(template);
  for(let k=Math.max(first,Math.floor((area.y-paper.y)/step));paper.y+k*step<Math.min(area.y+area.height,paper.y+paper.height);k++) {
    const y=paper.y+k*step+(template==='ruled'?-.5:.5);yield[paper.x,y,paper.x+paper.width,y];
  }
  if(template==='grid')for(let k=Math.max(0,Math.floor((area.x-paper.x)/step));paper.x+k*step<Math.min(area.x+area.width,paper.x+paper.width);k++) {
    const x=paper.x+k*step+.5;yield[x,paper.y,x,paper.y+paper.height];
  }
}
