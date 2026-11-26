import type { Element } from './model';

const sharedRawPoints = new WeakSet<readonly [number, number][]>();

/** Freehand geometry is replaced, never edited in place, by the pinned kernel.
 * Freeze its payload so snapshots can share millions of points without risking
 * unnoticed history corruption. Non-freehand editable structures remain copied.
 */
export function snapshotElement<T extends Element>(element: T): T {
  if (element.type !== 'freedraw') return structuredClone(element);
  const { points, pressures, customData, ...properties } = element;
  if (!Object.isFrozen(points)) {
    for (const point of points) if (!Object.isFrozen(point)) Object.freeze(point);
    Object.freeze(points);
  }
  if (!Object.isFrozen(pressures)) Object.freeze(pressures);
  let copiedCustomData: typeof customData;
  if (customData) {
    const { inkRawPoints, inkRawPressures, ...editable } = customData;
    if (inkRawPoints && !sharedRawPoints.has(inkRawPoints)) {
      for (const point of inkRawPoints) if (!Object.isFrozen(point)) Object.freeze(point);
      Object.freeze(inkRawPoints); sharedRawPoints.add(inkRawPoints);
    }
    if (inkRawPressures && !Object.isFrozen(inkRawPressures)) Object.freeze(inkRawPressures);
    copiedCustomData = structuredClone(editable);
    if (inkRawPoints) copiedCustomData.inkRawPoints = inkRawPoints;
    if (inkRawPressures) copiedCustomData.inkRawPressures = inkRawPressures;
  }
  return { ...structuredClone(properties), ...(customData ? { customData: copiedCustomData } : {}), points, pressures } as T;
}
