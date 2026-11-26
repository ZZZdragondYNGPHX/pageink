import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InkStabilizer, stabilizeInkPoint, stabilizedRawPoints } from '../src/ink-input';
import { eraseStrokePath } from '../src/geometry';
import { restyleElements } from '../src/layers';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/preferences';
import { advanceZoomBox, buildZoomFreedrawElement, clampZoomBox, newlineZoomBox, sceneToZoomCanvas, shouldAutoAdvance, zoomBoxSize, zoomCanvasToScene } from '../src/zoom-window';
import type { Element, Rect } from '../src/model';

const shape = (id: string, type: 'rectangle' | 'ellipse' | 'line' | 'freedraw' | 'text', overrides: Record<string, unknown> = {}): Element => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 80,
  height: 40,
  angle: 0,
  strokeColor: '#1f2329',
  backgroundColor: 'transparent',
  fillStyle: 'hachure',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: 'a0' as Element['index'],
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...overrides,
} as unknown as Element);

describe('P1: InkStabilizer', () => {
  it('passes coordinates untouched at level 0', () => {
    const s = new InkStabilizer(0);
    assert.deepEqual(s.start(10, 20), [10, 20]);
    assert.deepEqual(s.next(30, 50), [30, 50]);
    assert.deepEqual(s.finish(40, 60), [40, 60]);
  });

  it('smooths intermediate jitter while anchoring exact start and finish points', () => {
    const light = new InkStabilizer(1);
    const medium = new InkStabilizer(2);
    assert.deepEqual(light.start(0, 0), [0, 0]);
    assert.deepEqual(medium.start(0, 0), [0, 0]);
    const l1 = light.next(10, 10);
    const m1 = medium.next(10, 10);
    assert.ok(Math.abs(l1[0] - 6.5) < 1e-5);
    assert.ok(Math.abs(m1[0] - 4.2) < 1e-5);
    assert.ok(m1[0] < l1[0]);
    assert.deepEqual(medium.finish(10, 10), [10, 10]);
  });

  it('tracks independent strokes cleanly and preserves raw coordinates via stabilizeInkPoint', () => {
    const strokeA = {};
    const strokeB = {};
    const a1 = stabilizeInkPoint(strokeA, 2, 10, 0, 0, 0);
    const b1 = stabilizeInkPoint(strokeB, 2, 0, 10, 0, 0);
    assert.ok(Math.abs(a1[0] - 4.2) < 1e-5);
    assert.equal(a1[1], 0);
    assert.equal(b1[0], 0);
    assert.ok(Math.abs(b1[1] - 4.2) < 1e-5);
    assert.deepEqual(stabilizedRawPoints(strokeA), [[0, 0], [10, 0]]);
    assert.deepEqual(stabilizedRawPoints(strokeB), [[0, 0], [0, 10]]);
  });
});

describe('P1: restyleElements strokeStyle & backgroundColor', () => {
  it('applies strokeStyle to shapes/lines only and fillColor (with solid fillStyle) to closed shapes only', () => {
    const rect = shape('r1', 'rectangle');
    const line = shape('l1', 'line');
    const stroke = shape('f1', 'freedraw');
    const res = restyleElements([rect, line, stroke], new Set(['r1', 'l1', 'f1']), {
      strokeStyle: 'dashed',
      backgroundColor: '#fff4cc',
    });
    assert.equal(res.changed, true);
    assert.equal(res.elements[0].strokeStyle, 'dashed');
    assert.equal(res.elements[0].backgroundColor, '#fff4cc');
    assert.equal(res.elements[0].fillStyle, 'solid');
    assert.equal(res.elements[1].strokeStyle, 'dashed');
    assert.equal(res.elements[1].backgroundColor, 'transparent');
    assert.equal(res.elements[2].strokeStyle, 'solid');
    assert.equal(res.elements[2].backgroundColor, 'transparent');
  });

  it('allows clearing fill back to transparent', () => {
    const rect = shape('r1', 'rectangle', { backgroundColor: '#ddf4e4', fillStyle: 'solid' });
    const res = restyleElements([rect], new Set(['r1']), { backgroundColor: 'transparent' });
    assert.equal(res.changed, true);
    assert.equal(res.elements[0].backgroundColor, 'transparent');
  });
});

describe('P1: Zoom Window geometry & auto-advance', () => {
  const box: Rect = { x: 100, y: 200, width: 300, height: 100 };
  const page: Rect = { x: 0, y: 0, width: 800, height: 1100 };

  it('maps canvas coordinates to scene coordinates and back 1-to-1', () => {
    const scene = zoomCanvasToScene(150, 50, 600, 200, box);
    assert.deepEqual(scene, [175, 225]);
    const back = sceneToZoomCanvas(scene[0], scene[1], 600, 200, box);
    assert.deepEqual(back, [150, 50]);
  });

  it('sizes target box inversely with zoom factor', () => {
    assert.deepEqual(zoomBoxSize(600, 180, 2), { width: 300, height: 90 });
    assert.deepEqual(zoomBoxSize(600, 180, 4), { width: 150, height: 45 });
  });

  it('advances horizontally and wraps to next line at page right edge', () => {
    const stepped = advanceZoomBox(box, page, 1, 56);
    assert.ok(Math.abs(stepped.x - 295) < 1e-5);
    assert.equal(stepped.y, 200);

    const atEdge: Rect = { x: 500, y: 200, width: 300, height: 100 };
    const wrapped = advanceZoomBox(atEdge, page, 1, 56);
    assert.equal(wrapped.x, 24);
    assert.equal(wrapped.y, 256);
  });

  it('computes newline and clamps within page bounds', () => {
    const nl = newlineZoomBox(box, page, 64);
    assert.equal(nl.x, 24);
    assert.equal(nl.y, 264);
    assert.deepEqual(clampZoomBox({ x: 900, y: 1200, width: 300, height: 100 }, page), { x: 500, y: 1000, width: 300, height: 100 });
  });

  it('detects auto-advance trigger zone accurately', () => {
    assert.equal(shouldAutoAdvance(300, box), false);
    assert.equal(shouldAutoAdvance(316, box), true);
  });

  it('builds a normalized freedraw element with inkKind, zero pressures and rawPoints preserved', () => {
    const el = buildZoomFreedrawElement([[120, 210], [120, 210], [150, 230]], [0.2, 0.8, 0], {
      color: '#2463c8',
      width: 2,
      opacity: 100,
      inkKind: 'pen',
      fixedPressure: false,
      rawPoints: [[120, 210], [120, 210], [155, 235]],
    });
    assert.ok(el && el.type === 'freedraw');
    assert.equal(el.x, 120);
    assert.equal(el.y, 210);
    assert.equal(el.width, 30);
    assert.equal(el.height, 20);
    assert.deepEqual(el.points, [[0, 0], [0, 0], [30, 20]]);
    assert.deepEqual(el.pressures, [0.2, 0.8, 0]);
    assert.equal(el.customData?.inkKind, 'pen');
    assert.deepEqual(el.customData?.inkRawPoints, [[0, 0], [0, 0], [35, 25]]);

    const sliced = eraseStrokePath(el, [[135, 220]], 6, false);
    assert.ok(sliced.length >= 1);
    for (const piece of sliced) {
      assert.equal(piece.customData?.inkRawPoints, undefined);
      assert.equal(piece.customData?.inkKind, 'pen');
    }
  });
});

describe('P1: normalizePreferences new fields', () => {
  it('accepts valid P1 preferences and falls back safely on invalid input', () => {
    assert.equal(DEFAULT_PREFERENCES.pen.stabilize, 1);
    assert.equal(DEFAULT_PREFERENCES.autoCollapseDock, false);
    const ok = normalizePreferences({
      pen: { stabilize: 2 },
      shape: { strokeStyle: 'dotted', fillColor: '#dcecff' },
      nightPaper: true,
      autoCollapseDock: true,
      sidebar: { tab: 'outline' },
    });
    assert.equal(ok.pen.stabilize, 2);
    assert.equal(ok.shape.strokeStyle, 'dotted');
    assert.equal(ok.shape.fillColor, '#dcecff');
    assert.equal(ok.nightPaper, true);
    assert.equal(ok.autoCollapseDock, true);
    assert.equal(ok.sidebar.tab, 'outline');

    const bad = normalizePreferences({
      pen: { stabilize: 9 },
      shape: { strokeStyle: 'zigzag', fillColor: 'not-a-color' },
      nightPaper: 'yes',
      autoCollapseDock: 'always',
      sidebar: { tab: 'unknown' },
    });
    assert.equal(bad.pen.stabilize, DEFAULT_PREFERENCES.pen.stabilize);
    assert.equal(bad.shape.strokeStyle, 'solid');
    assert.equal(bad.shape.fillColor, 'transparent');
    assert.equal(bad.nightPaper, false);
    assert.equal(bad.autoCollapseDock, false);
    assert.equal(bad.sidebar.tab, 'pages');
  });
});
