import type { Element } from './model';

/** Freehand geometry is replaced, never edited in place, by the pinned kernel.
 * Freeze its payload so snapshots can share millions of points without risking
 * unnoticed history corruption. Non-freehand editable structures remain copied.
 */
export function snapshotElement<T extends Element>(element: T): T {
  if (element.type !== 'freedraw') return structuredClone(element);
  const { points, pressures, ...properties } = element;
  if (!Object.isFrozen(points)) {
    for (const point of points) if (!Object.isFrozen(point)) Object.freeze(point);
    Object.freeze(points);
  }
  if (!Object.isFrozen(pressures)) Object.freeze(pressures);
  return { ...structuredClone(properties), points, pressures } as T;
}
